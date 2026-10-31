//
//  FeedbackClientTests.swift
//  FeedbackKitTests
//

import Foundation
import Testing
@testable import FeedbackKit

@Suite("FeedbackClient", .serialized)
struct FeedbackClientTests {
    let configuration = FeedbackConfiguration(
        baseURL: URL(string: "https://feedback.example.test")!,
        appID: "demo"
    )

    /// Fresh transport, token store and a temporary draft directory per test.
    private func makeClient(tokens: [String: String] = [:]) -> (FeedbackClient, MockTransport, InMemoryTokenStore, FeedbackDraftStore) {
        let transport = MockTransport()
        MockURLProtocol.transport = transport
        let tokenStore = InMemoryTokenStore(initial: tokens)
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "FeedbackKitTests-\(UUID().uuidString)")
        let draftStore = FeedbackDraftStore(appID: configuration.appID, directory: directory)
        let client = FeedbackClient(
            configuration: configuration,
            urlSession: MockURLProtocol.makeSession(),
            tokenStore: tokenStore,
            draftStore: draftStore
        )
        return (client, transport, tokenStore, draftStore)
    }

    private var validDraft: FeedbackDraft {
        FeedbackDraft(kind: .idea, title: "Add a dark icon", body: "The current icon is hard to see on dark home screens.")
    }

    // MARK: Registration

    @Test("First submit registers, stores the token, then sends with a bearer")
    func registersBeforeFirstSubmit() async throws {
        let (client, transport, tokenStore, _) = makeClient()
        transport.enqueue(
            .json(201, ["token": "fk1_abc"]),
            .json(201, ["id": "sub-1", "state": "pending"])
        )

        let draft = validDraft
        let receipt = try await client.submit(draft)

        #expect(receipt == SubmissionReceipt(id: "sub-1", state: .pending))
        let requests = transport.requests
        #expect(requests.count == 2)
        #expect(requests[0].path == "/api/register")
        #expect(requests[0].json["app"] as? String == "demo")
        #expect(requests[0].authorization == nil)
        #expect(requests[1].path == "/api/submit")
        #expect(requests[1].authorization == "Bearer fk1_abc")
        #expect(requests[1].json["requestId"] as? String == draft.requestID.uuidString)
        #expect(requests[1].json["kind"] as? String == "idea")
        #expect(tokenStore.all[configuration.tokenAccount] == "fk1_abc")
    }

    @Test("A stored token is reused without registering")
    func reusesStoredToken() async throws {
        let (client, transport, _, _) = makeClient(tokens: [configuration.tokenAccount: "fk1_stored"])
        transport.enqueue(.json(201, ["id": "sub-2", "state": "pending"]))

        _ = try await client.submit(validDraft)

        let requests = transport.requests
        #expect(requests.count == 1)
        #expect(requests[0].path == "/api/submit")
        #expect(requests[0].authorization == "Bearer fk1_stored")
    }

    @Test("Concurrent first calls share one registration")
    func registrationIsSingleFlight() async throws {
        let (client, transport, _, _) = makeClient()
        transport.enqueue(
            .json(201, ["token": "fk1_once"]),
            .json(200, ["submissions": [], "hasMore": false]),
            .json(200, ["submissions": [], "hasMore": false])
        )

        async let first = client.myReports()
        async let second = client.myReports()
        _ = try await (first, second)

        let registerCalls = transport.requests.filter { $0.path == "/api/register" }
        #expect(registerCalls.count == 1)
    }

    @Test("A 401 forgets the token, re-registers and retries exactly once")
    func reregistersAfter401() async throws {
        let (client, transport, tokenStore, _) = makeClient(tokens: [configuration.tokenAccount: "fk1_stale"])
        transport.enqueue(
            .json(401, ["error": ["code": "unauthorized", "message": "nope"]]),
            .json(201, ["token": "fk1_new"]),
            .json(201, ["id": "sub-3", "state": "pending"])
        )

        let receipt = try await client.submit(validDraft)

        #expect(receipt.id == "sub-3")
        let paths = transport.requests.map(\.path)
        #expect(paths == ["/api/submit", "/api/register", "/api/submit"])
        #expect(transport.requests[2].authorization == "Bearer fk1_new")
        #expect(tokenStore.all[configuration.tokenAccount] == "fk1_new")
    }

    @Test("A second 401 surfaces as unauthorized")
    func secondUnauthorizedIsFatal() async throws {
        let (client, transport, _, _) = makeClient(tokens: [configuration.tokenAccount: "fk1_stale"])
        transport.enqueue(
            .json(401, ["error": ["code": "unauthorized", "message": "nope"]]),
            .json(201, ["token": "fk1_new"]),
            .json(401, ["error": ["code": "unauthorized", "message": "still no"]])
        )

        await #expect(throws: FeedbackError.unauthorized) {
            try await client.submit(validDraft)
        }
    }

    // MARK: Error mapping

    @Test("409 maps to conflict")
    func conflictMapsTo409() async throws {
        let (client, transport, _, _) = makeClient(tokens: [configuration.tokenAccount: "fk1_ok"])
        transport.enqueue(.json(409, ["error": ["code": "request_id_conflict", "message": "used"]]))

        await #expect(throws: FeedbackError.conflict) {
            try await client.submit(validDraft)
        }
    }

    @Test("429 carries Retry-After in seconds")
    func rateLimitParsesRetryAfterSeconds() async throws {
        let (client, transport, _, _) = makeClient(tokens: [configuration.tokenAccount: "fk1_ok"])
        transport.enqueue(.json(429, ["error": ["code": "rate_limited", "message": "slow down"]], headers: ["Retry-After": "60"]))

        await #expect(throws: FeedbackError.rateLimited(retryAfter: 60)) {
            try await client.submit(validDraft)
        }
    }

    @Test("Retry-After as an HTTP-date becomes a positive interval")
    func rateLimitParsesRetryAfterDate() throws {
        let future = Date().addingTimeInterval(120)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        let response = HTTPURLResponse(
            url: configuration.baseURL,
            statusCode: 429,
            httpVersion: nil,
            headerFields: ["Retry-After": formatter.string(from: future)]
        )!

        let interval = try #require(FeedbackClient.retryAfter(from: response))
        #expect(interval > 100 && interval <= 120)
    }

    @Test("Server error messages are surfaced")
    func serverErrorCarriesMessage() async throws {
        let (client, transport, _, _) = makeClient(tokens: [configuration.tokenAccount: "fk1_ok"])
        transport.enqueue(.json(500, ["error": ["code": "internal", "message": "Something went wrong."]]))

        await #expect(throws: FeedbackError.server(status: 500, message: "Something went wrong.")) {
            try await client.submit(validDraft)
        }
    }

    @Test("Transport failures map to network errors and nothing is recorded as sent")
    func networkFailure() async throws {
        let (client, transport, _, draftStore) = makeClient(tokens: [configuration.tokenAccount: "fk1_ok"])
        // Empty queue: the mock fails the request with cannotConnectToHost.
        _ = transport

        let draft = validDraft
        // URLSession decorates the error's userInfo, so match on the code only.
        let thrown = await #expect(throws: FeedbackError.self) {
            try await client.submit(draft)
        }
        guard case .network(let urlError)? = thrown else {
            Issue.record("Expected a network error, got \(String(describing: thrown))")
            return
        }
        #expect(urlError.code == .cannotConnectToHost)
        // The draft (and its requestID) survives for the retry.
        #expect(try draftStore.load()?.requestID == draft.requestID)
    }

    // MARK: Validation and drafts

    @Test("Client-side validation rejects a short title before any request")
    func validationRejectsShortTitle() async throws {
        let (client, transport, _, _) = makeClient(tokens: [configuration.tokenAccount: "fk1_ok"])
        let draft = FeedbackDraft(title: "Hi", body: "This body is long enough to pass.")

        await #expect(throws: FeedbackError.invalidInput([.titleTooShort])) {
            try await client.submit(draft)
        }
        #expect(transport.requests.isEmpty)
    }

    @Test("Lengths are counted in Unicode scalars, matching the server")
    func lengthsCountScalars() {
        // Five flag emoji = ten scalars, which is a valid title length.
        let draft = FeedbackDraft(title: "🇬🇧🇬🇧🇬🇧🇬🇧🇬🇧", body: String(repeating: "x", count: 10))
        #expect(draft.titleLength == 10)
        #expect(draft.isValid)
    }

    @Test("A successful submit clears the pending draft")
    func successClearsDraft() async throws {
        let (client, transport, _, draftStore) = makeClient(tokens: [configuration.tokenAccount: "fk1_ok"])
        transport.enqueue(.json(201, ["id": "sub-4", "state": "pending"]))

        let draft = validDraft
        try await client.saveDraft(draft)
        _ = try await client.submit(draft)

        #expect(try draftStore.load() == nil)
    }

    @Test("Draft store round-trips and clears")
    func draftStoreRoundTrip() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "FeedbackKitTests-\(UUID().uuidString)")
        let store = FeedbackDraftStore(appID: "demo", directory: directory)
        let draft = FeedbackDraft(kind: .other, title: "Hello there", body: "Some body text here.")

        #expect(try store.load() == nil)
        try store.save(draft)
        #expect(try store.load() == draft)
        try store.clear()
        #expect(try store.load() == nil)
    }

    // MARK: Mine

    @Test("myReports decodes a page")
    func myReportsDecodes() async throws {
        let (client, transport, _, _) = makeClient(tokens: [configuration.tokenAccount: "fk1_ok"])
        let requestID = UUID()
        transport.enqueue(.json(200, [
            "submissions": [[
                "id": "sub-9",
                "requestId": requestID.uuidString.lowercased(),
                "kind": "issue",
                "title": "Crash on launch",
                "body": "It crashes every time I open it.",
                "state": "pending",
                "createdAt": "2026-10-07T12:00:00Z",
            ]],
            "hasMore": true,
        ]))

        let page = try await client.myReports(offset: 50)

        #expect(transport.requests[0].json["offset"] as? Int == 50)
        #expect(page.hasMore)
        #expect(page.submissions.count == 1)
        let first = try #require(page.submissions.first)
        #expect(first.requestId == requestID)
        #expect(first.kind == .issue)
        #expect(first.createdAt == ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z"))
    }
}
