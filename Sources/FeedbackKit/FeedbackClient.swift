//
//  FeedbackClient.swift
//  FeedbackKit
//
//  The one object a host app talks to. Registers this installation with the
//  Worker the first time it is needed, keeps the token in the Keychain, and
//  sends reports idempotently.
//
//  Credential flow:
//    1. Look for a cached token, then the Keychain.
//    2. If none, register (single-flight, so concurrent callers share one
//       registration). With App Attest available this is an attested
//       registration; otherwise a plain POST /api/register.
//    3. On a 401, forget the token, register once more and retry the call.
//       A second 401 surfaces as `FeedbackError.unauthorized`.
//
//  App Attest:
//    • Attested installations sign every write (submit, reply, vote, follow)
//      with a fresh server challenge bound to method, path and body hash.
//    • If the server answers 403 with an attestation code, the client
//      attests (upgrading the existing installation) and retries once.
//

import Foundation

public actor FeedbackClient {
    public let configuration: FeedbackConfiguration

    private let session: URLSession
    private let tokenStore: any FeedbackTokenStore
    private let draftStore: FeedbackDraftStore
    private let attestProvider: any AppAttestProvider
    private let attachmentCache: AttachmentCache

    private var cachedToken: String?
    /// `.none` = not loaded yet; `.some(nil)` = known to have no key.
    private var cachedKeyID: String??
    private var registration: Task<String, Error>?

    /// Write endpoints the server expects attested installations to sign.
    private static let assertedPaths: Set<String> = ["/api/submit", "/api/reply", "/api/vote", "/api/follow"]
    private static let attestationErrorCodes: Set<String> = ["attestation_required", "assertion_required", "assertion_invalid"]
    private static let jsonContentType = "application/json"

    private let encoder = JSONEncoder()
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = (try? FeedbackClient.iso8601.parse(text))
                ?? (try? FeedbackClient.iso8601Fractional.parse(text))
            {
                return date
            }
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Unrecognised date: \(text)"
            ))
        }
        return decoder
    }()

    // FormatStyle values are Sendable, unlike the Formatter classes, so they
    // can be shared statics under strict concurrency.
    private static let iso8601 = Date.ISO8601FormatStyle()
    private static let iso8601Fractional = Date.ISO8601FormatStyle().time(includingFractionalSeconds: true)

    /// - Parameters:
    ///   - configuration: Server origin, app id and attestation policy.
    ///   - urlSession: Injectable for tests; defaults to a session that waits
    ///     for connectivity rather than failing fast when offline.
    ///   - tokenStore: Defaults to the Keychain.
    ///   - draftStore: Defaults to Application Support for this app id.
    ///   - attestProvider: Defaults to DeviceCheck; tests inject a fake.
    public init(
        configuration: FeedbackConfiguration,
        urlSession: URLSession? = nil,
        tokenStore: any FeedbackTokenStore = KeychainTokenStore(),
        draftStore: FeedbackDraftStore? = nil,
        attestProvider: any AppAttestProvider = DeviceCheckAttestProvider()
    ) {
        self.configuration = configuration
        self.session = urlSession ?? FeedbackClient.makeDefaultSession()
        self.tokenStore = tokenStore
        self.draftStore = draftStore ?? FeedbackDraftStore(appID: configuration.appID)
        self.attestProvider = attestProvider
        self.attachmentCache = urlSession == nil ? .shared : AttachmentCache()
    }

    private static func makeDefaultSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 90
        config.waitsForConnectivity = true
        return URLSession(configuration: config)
    }

    // MARK: - Registration

    /// Ensures this installation has a token, registering if needed. Safe to
    /// call at any time; most hosts never need to, because the other calls
    /// do it for you.
    @discardableResult
    public func register() async throws -> String {
        try await ensureToken()
    }

    /// True when this installation is bound to an App Attest key.
    public var isAttested: Bool {
        get throws { try storedKeyID() != nil }
    }

    /// True once this installation holds a token, i.e. it has talked to the
    /// server before. Lets hosts skip background polling for installations
    /// that never sent anything, without triggering a registration.
    public var isRegistered: Bool {
        get throws {
            if cachedToken != nil { return true }
            return try tokenStore.token(for: configuration.tokenAccount) != nil
        }
    }

    /// Discards the stored token and attest key. The next call registers a
    /// new installation, which loses access to earlier reports. Mainly for debugging.
    public func resetInstallation() throws {
        cachedToken = nil
        cachedKeyID = .some(nil)
        registration?.cancel()
        registration = nil
        try tokenStore.removeToken(for: configuration.tokenAccount)
        try tokenStore.removeToken(for: configuration.attestKeyAccount)
    }

    private func ensureToken() async throws -> String {
        if let cachedToken { return cachedToken }
        if let stored = try tokenStore.token(for: configuration.tokenAccount) {
            cachedToken = stored
            return stored
        }
        if let registration { return try await registration.value }

        let task = Task<String, Error> { try await self.registerInstallation() }
        registration = task
        defer { registration = nil }

        let token = try await task.value
        try tokenStore.store(token, for: configuration.tokenAccount)
        cachedToken = token
        return token
    }

    /// Attested registration when possible, plain otherwise.
    private func registerInstallation() async throws -> String {
        if configuration.attestation == .whenAvailable, attestProvider.isSupported {
            do {
                return try await attestAndRegister(upgrading: nil)
            } catch FeedbackError.network(let error) {
                throw FeedbackError.network(error)
            } catch FeedbackError.rateLimited(let retryAfter) {
                throw FeedbackError.rateLimited(retryAfter: retryAfter)
            } catch {
                // App Attest disabled on the server, a DeviceCheck hiccup, or a
                // rejected attestation: fall back to a plain token. In the
                // server's `required` mode the plain path returns 403 below.
            }
        }
        let response: RegisterResponse = try await performJSON(
            method: "POST",
            path: "api/register",
            body: try encoder.encode(RegisterRequest(app: configuration.appID)),
            token: nil
        )
        return response.token
    }

    /// Generates a key, attests it against a server challenge and registers.
    /// With `upgrading` set, the key is bound to that existing installation.
    private func attestAndRegister(upgrading existingToken: String?) async throws -> String {
        let keyID = try await attestProvider.generateKey()
        let challenge = try await requestChallenge(purpose: "register", path: "/api/attest/register")
        guard let challengeBytes = AttestationEncoding.dataFromBase64url(challenge) else {
            throw FeedbackError.invalidResponse
        }
        let attestation = try await attestProvider.attestKey(keyID, clientDataHash: AttestationEncoding.sha256(challengeBytes))

        let response: AttestRegisterResponse = try await performJSON(
            method: "POST",
            path: "api/attest/register",
            body: try encoder.encode(AttestRegisterRequest(
                app: configuration.appID,
                keyId: keyID,
                challenge: challenge,
                attestation: attestation.base64EncodedString()
            )),
            token: existingToken
        )

        try tokenStore.store(keyID, for: configuration.attestKeyAccount)
        cachedKeyID = .some(keyID)

        if let token = response.token { return token }
        if response.upgraded, let existingToken { return existingToken }
        throw FeedbackError.invalidResponse
    }

    private func requestChallenge(purpose: String, path: String) async throws -> String {
        let response: AttestChallengeResponse = try await performJSON(
            method: "POST",
            path: "api/attest/challenge",
            body: try encoder.encode(AttestChallengeRequest(purpose: purpose, path: path)),
            token: nil
        )
        return response.challenge
    }

    private func storedKeyID() throws -> String? {
        if let cachedKeyID { return cachedKeyID }
        let stored = try tokenStore.token(for: configuration.attestKeyAccount)
        cachedKeyID = .some(stored)
        return stored
    }

    private func forgetToken() throws {
        cachedToken = nil
        try tokenStore.removeToken(for: configuration.tokenAccount)
    }

    private func forgetKey() throws {
        cachedKeyID = .some(nil)
        try tokenStore.removeToken(for: configuration.attestKeyAccount)
    }

    // MARK: - Drafts

    /// The draft that was being written when the form last closed without
    /// sending, if any.
    public func pendingDraft() throws -> FeedbackDraft? {
        try draftStore.load()
    }

    /// Persists the draft so its requestID survives a retry or relaunch.
    public func saveDraft(_ draft: FeedbackDraft) throws {
        try draftStore.save(draft)
    }

    /// Throws the pending draft away (the person cancelled).
    public func discardDraft() throws {
        try draftStore.clear()
    }

    // MARK: - Reports

    /// Sends a report. Validates locally first, persists the draft so a retry
    /// reuses the same requestID, and clears it once the server confirms.
    public func submit(_ draft: FeedbackDraft) async throws -> SubmissionReceipt {
        let issues = draft.validationIssues
        guard issues.isEmpty else { throw FeedbackError.invalidInput(issues) }

        try draftStore.save(draft)
        let receipt: SubmissionReceipt = try await authenticated(
            method: "POST",
            path: "api/submit",
            body: SubmitRequest(draft: draft)
        )
        // Only clear if the stored draft is still this one; the form may
        // have started a fresh draft meanwhile.
        if let stored = try? draftStore.load(), stored.requestID == draft.requestID {
            try? draftStore.clear()
        }
        return receipt
    }

    /// This installation's reports, newest first, 50 per page.
    public func myReports(offset: Int = 0) async throws -> SubmissionPage {
        try await authenticated(method: "POST", path: "api/mine", body: MineRequest(offset: offset))
    }

    // MARK: - Conversations

    /// Messages about one of this installation's reports, oldest first.
    /// Pass the previous page's `nextAfter` to continue.
    public func conversation(submissionID: String, after: Int = 0) async throws -> ConversationPage {
        try await authenticated(
            method: "POST",
            path: "api/conversation",
            body: ConversationRequest(submissionId: submissionID, after: after)
        )
    }

    /// Sends a reply. Reuse the same `requestID` when retrying a failed send;
    /// the server stores the message once. Text may be empty when images
    /// are attached.
    public func reply(
        submissionID: String,
        requestID: UUID,
        message: String,
        attachmentIDs: [String] = []
    ) async throws -> Message {
        let text = message.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let length = text.unicodeScalars.count
        if length < FeedbackLimits.messageLength.lowerBound, attachmentIDs.isEmpty {
            throw FeedbackError.invalidInput([.messageEmpty])
        }
        if length > FeedbackLimits.messageLength.upperBound { throw FeedbackError.invalidInput([.messageTooLong]) }

        let response: ReplyResponse = try await authenticated(
            method: "POST",
            path: "api/reply",
            body: ReplyRequest(
                submissionId: submissionID,
                requestId: requestID,
                message: text,
                attachmentIds: attachmentIDs.isEmpty ? nil : attachmentIDs
            )
        )
        return response.message
    }

    /// Developer replies this installation has not read yet, across all of
    /// its reports. Intended for badges; call it on foreground, not in a loop.
    public func unreadReplies() async throws -> Int {
        let response: UnreadResponse = try await authenticated(method: "POST", path: "api/unread", body: EmptyRequest())
        return response.unread
    }

    /// Records that this installation has read messages up to `through` (a seq).
    @discardableResult
    public func markConversationRead(submissionID: String, through: Int) async throws -> Int {
        let response: ReadThroughResponse = try await authenticated(
            method: "POST",
            path: "api/conversation-read",
            body: ConversationReadRequest(submissionId: submissionID, through: through)
        )
        return response.readThrough
    }

    // MARK: - Attachments

    /// Uploads a prepared image. Link the returned id to a report or reply
    /// within a day, or the server discards it.
    public func uploadAttachment(_ image: PreparedImage) async throws -> Attachment {
        let (data, _) = try await authenticatedData(
            method: "POST",
            path: "api/attachments",
            body: image.data,
            contentType: image.contentType,
            extraHeaders: ["X-Image-Width": String(image.width), "X-Image-Height": String(image.height)]
        )
        do {
            return try decoder.decode(UploadResponse.self, from: data).attachment
        } catch {
            throw FeedbackError.invalidResponse
        }
    }

    /// The bytes of an attachment on one of this installation's reports.
    /// Cached in memory and on disk; attachments never change.
    public func attachmentData(id: String) async throws -> Data {
        if let cached = await attachmentCache.data(for: id) { return cached }
        let (data, _) = try await authenticatedData(method: "GET", path: "api/attachments/\(id)", body: nil)
        await attachmentCache.store(data, for: id)
        return data
    }

    // MARK: - Board

    /// Published issues for this app, with this installation's vote and
    /// follow state. 25 per page.
    public func board(
        status: IssueStatus? = nil,
        query: String? = nil,
        sort: BoardSort = .recent,
        offset: Int = 0
    ) async throws -> BoardPage {
        var items: [URLQueryItem] = []
        if let status { items.append(URLQueryItem(name: "status", value: status.rawValue)) }
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if sort != .recent { items.append(URLQueryItem(name: "sort", value: sort.rawValue)) }
        if offset > 0 { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        return try await authenticatedRaw(
            method: "GET",
            path: "api/board/\(configuration.appID)",
            query: items,
            body: nil
        )
    }

    /// Adds or removes this installation's vote on an issue.
    public func vote(issueNumber: Int, on: Bool) async throws -> Engagement {
        try await authenticated(method: "POST", path: "api/vote", body: ToggleRequest(issueNumber: issueNumber, on: on))
    }

    /// Starts or stops following an issue.
    public func follow(issueNumber: Int, on: Bool) async throws -> Engagement {
        try await authenticated(method: "POST", path: "api/follow", body: ToggleRequest(issueNumber: issueNumber, on: on))
    }

    // MARK: - Ask

    /// Whether the helper is switched on for this app, and how it should look.
    /// Throws `notFound` when the app has no helper, so hosts can hide the entry.
    public func askConfiguration() async throws -> AskConfiguration {
        try await authenticatedRaw(method: "GET", path: "api/ask/config", body: nil)
    }

    /// Asks the helper a question. `history` is the conversation so far (the server
    /// uses only the last few turns), so "and how do I turn that off?" works.
    public func ask(_ question: String, history: [AskTurn] = []) async throws -> AskAnswer {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await authenticated(method: "POST", path: "api/ask", body: AskRequest(question: text, history: history))
    }

    /// Records whether an answer helped. Failures are the caller's to ignore.
    public func rateAskAnswer(logID: String, helpful: Bool) async throws {
        let _: AskAcknowledgement = try await authenticated(
            method: "POST",
            path: "api/ask/feedback",
            body: AskFeedbackRequest(logId: logID, helpful: helpful)
        )
    }

    // MARK: - Transport

    private func authenticated<Response: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: some Encodable
    ) async throws -> Response {
        try await authenticatedRaw(method: method, path: path, query: query, body: try encoder.encode(body))
    }

    private func authenticatedRaw<Response: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Data?
    ) async throws -> Response {
        let (data, _) = try await authenticatedData(method: method, path: path, query: query, body: body)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw FeedbackError.invalidResponse
        }
    }

    /// An authenticated request returning raw bytes, with the 401 and App
    /// Attest recovery paths.
    private func authenticatedData(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Data?,
        contentType: String = FeedbackClient.jsonContentType,
        extraHeaders: [String: String] = [:]
    ) async throws -> (Data, HTTPURLResponse) {
        let token = try await ensureToken()
        do {
            return try await performSigned(method: method, path: path, query: query, body: body, contentType: contentType, token: token, extraHeaders: extraHeaders)
        } catch FeedbackError.unauthorized {
            // The server no longer recognises this installation. Register a
            // fresh one and try exactly once more.
            try forgetToken()
            try? forgetKey()
            let fresh = try await ensureToken()
            return try await performSigned(method: method, path: path, query: query, body: body, contentType: contentType, token: fresh, extraHeaders: extraHeaders)
        } catch FeedbackError.attestationRequired
            where configuration.attestation == .whenAvailable && attestProvider.isSupported
        {
            // Bind a fresh App Attest key to this installation, then retry once.
            try? forgetKey()
            _ = try await attestAndRegister(upgrading: token)
            return try await performSigned(method: method, path: path, query: query, body: body, contentType: contentType, token: token, extraHeaders: extraHeaders)
        }
    }

    /// Adds App Attest assertion headers on write endpoints when this
    /// installation holds a key.
    private func performSigned(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Data?,
        contentType: String,
        token: String,
        extraHeaders: [String: String]
    ) async throws -> (Data, HTTPURLResponse) {
        var headers = extraHeaders
        let absolutePath = "/" + path
        if Self.assertedPaths.contains(absolutePath), let keyID = try storedKeyID() {
            do {
                let assertion = try await assertionHeaders(keyID: keyID, method: method, path: absolutePath, body: body ?? Data())
                headers.merge(assertion.fields) { _, new in new }
            } catch let error as FeedbackError {
                throw error
            } catch {
                // The key is gone (reinstall, restore). Send unsigned; the
                // server's 403 triggers a re-attestation above.
                try? forgetKey()
            }
        }
        return try await perform(method: method, path: path, query: query, body: body, contentType: contentType, token: token, extraHeaders: headers)
    }

    private func assertionHeaders(keyID: String, method: String, path: String, body: Data) async throws -> AssertionHeaders {
        let challenge = try await requestChallenge(purpose: "assert", path: path)
        let clientData = try AttestationEncoding.canonicalJSON(AssertionClientData(
            bodyHash: AttestationEncoding.base64url(AttestationEncoding.sha256(body)),
            challenge: challenge,
            method: method,
            path: path
        ))
        let assertion = try await attestProvider.generateAssertion(keyID, clientDataHash: AttestationEncoding.sha256(clientData))
        return AssertionHeaders(keyID: keyID, clientData: clientData, assertion: assertion)
    }

    /// Unauthenticated-or-explicit-token JSON call used by registration.
    private func performJSON<Response: Decodable>(
        method: String,
        path: String,
        body: Data?,
        token: String?
    ) async throws -> Response {
        let (data, _) = try await perform(method: method, path: path, query: [], body: body, contentType: Self.jsonContentType, token: token, extraHeaders: [:])
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw FeedbackError.invalidResponse
        }
    }

    /// Performs one request and maps non-2xx statuses to `FeedbackError`.
    private func perform(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Data?,
        contentType: String,
        token: String?,
        extraHeaders: [String: String]
    ) async throws -> (Data, HTTPURLResponse) {
        var url = configuration.baseURL.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        for (field, value) in extraHeaders {
            request.setValue(value, forHTTPHeaderField: field)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw FeedbackError.network(error)
        }

        guard let http = response as? HTTPURLResponse else { throw FeedbackError.invalidResponse }
        let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data)
        let serverMessage = envelope?.error.message

        switch http.statusCode {
        case 200..<300: return (data, http)
        case 401: throw FeedbackError.unauthorized
        case 403:
            if let code = envelope?.error.code, Self.attestationErrorCodes.contains(code) {
                throw FeedbackError.attestationRequired
            }
            throw FeedbackError.forbidden(serverMessage)
        case 404: throw FeedbackError.notFound(serverMessage)
        case 409: throw FeedbackError.conflict
        case 413: throw FeedbackError.payloadTooLarge
        case 429: throw FeedbackError.rateLimited(retryAfter: Self.retryAfter(from: http))
        default: throw FeedbackError.server(status: http.statusCode, message: serverMessage)
        }
    }

    /// Parses `Retry-After` as either delta-seconds or an HTTP-date.
    static func retryAfter(from response: HTTPURLResponse) -> TimeInterval? {
        guard let value = response.value(forHTTPHeaderField: "Retry-After")?
            .trimmingCharacters(in: .whitespaces)
        else { return nil }
        if let seconds = TimeInterval(value) { return max(0, seconds) }
        if let date = try? httpDate.parse(value) {
            return max(0, date.timeIntervalSinceNow)
        }
        return nil
    }

    /// IMF-fixdate, e.g. `Wed, 07 Oct 2026 13:30:00 GMT`.
    private static let httpDate = Date.ParseStrategy(
        format: "\(weekday: .abbreviated), \(day: .twoDigits) \(month: .abbreviated) \(year: .defaultDigits) \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits):\(second: .twoDigits) GMT",
        locale: Locale(identifier: "en_US_POSIX"),
        timeZone: TimeZone(secondsFromGMT: 0)!
    )
}
