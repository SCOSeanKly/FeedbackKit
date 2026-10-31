//
//  FeedbackModels.swift
//  FeedbackKit
//
//  Wire types shared by the client and the views. Field names match the
//  Worker's JSON exactly so no key-mapping strategy is needed.
//

import Foundation

// MARK: - Kind

public enum FeedbackKind: String, Codable, CaseIterable, Sendable, Identifiable {
    case issue
    case idea
    case other

    public var id: String { rawValue }

    /// Short label for pickers and lists.
    public var title: String {
        switch self {
        case .issue: String(localized: "Issue", bundle: .module)
        case .idea: String(localized: "Idea", bundle: .module)
        case .other: String(localized: "Other", bundle: .module)
        }
    }

    /// One-line hint shown under the picker.
    public var hint: String {
        switch self {
        case .issue: String(localized: "Something is broken or behaving unexpectedly.", bundle: .module)
        case .idea: String(localized: "A feature or improvement you'd like to see.", bundle: .module)
        case .other: String(localized: "Anything else you'd like to say.", bundle: .module)
        }
    }

    public var systemImage: String {
        switch self {
        case .issue: "ladybug"
        case .idea: "lightbulb"
        case .other: "bubble.left"
        }
    }
}

// MARK: - Limits

/// Length limits enforced by the Worker. Counted in Unicode scalars on both
/// sides so a string the form accepts is never rejected by the server.
public enum FeedbackLimits {
    public static let titleLength = 5...160
    public static let bodyLength = 10...10_000
    public static let messageLength = 1...4_000
}

// MARK: - Draft

/// What the person is writing. The `requestID` is minted when the form opens
/// and reused on every retry, which is what makes sending idempotent.
public struct FeedbackDraft: Codable, Sendable, Equatable, Identifiable {
    public var requestID: UUID
    public var kind: FeedbackKind
    public var title: String
    public var body: String
    /// Optional device facts attached with the person's consent. Not part of
    /// the idempotency hash, so a retry after an update still matches.
    public var diagnostics: FeedbackDiagnostics?
    /// Ids of images already uploaded with `uploadAttachment`, linked to the
    /// report when it is sent.
    public var attachmentIDs: [String]

    public var id: UUID { requestID }

    public init(
        requestID: UUID = UUID(),
        kind: FeedbackKind = .issue,
        title: String = "",
        body: String = "",
        diagnostics: FeedbackDiagnostics? = nil,
        attachmentIDs: [String] = []
    ) {
        self.requestID = requestID
        self.kind = kind
        self.title = title
        self.body = body
        self.diagnostics = diagnostics
        self.attachmentIDs = attachmentIDs
    }

    enum CodingKeys: String, CodingKey {
        case requestID, kind, title, body, diagnostics, attachmentIDs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestID = try c.decode(UUID.self, forKey: .requestID)
        kind = try c.decode(FeedbackKind.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decode(String.self, forKey: .body)
        diagnostics = try c.decodeIfPresent(FeedbackDiagnostics.self, forKey: .diagnostics)
        attachmentIDs = try c.decodeIfPresent([String].self, forKey: .attachmentIDs) ?? []
    }

    /// Title with internal whitespace collapsed, the way the server stores it.
    public var normalizedTitle: String {
        title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Body with line endings normalised and outer whitespace trimmed.
    public var normalizedBody: String {
        body.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var titleLength: Int { normalizedTitle.unicodeScalars.count }
    public var bodyLength: Int { normalizedBody.unicodeScalars.count }

    /// Problems that would make the server reject the draft. Empty when valid.
    public var validationIssues: [FeedbackValidationIssue] {
        var issues: [FeedbackValidationIssue] = []
        if titleLength < FeedbackLimits.titleLength.lowerBound { issues.append(.titleTooShort) }
        if titleLength > FeedbackLimits.titleLength.upperBound { issues.append(.titleTooLong) }
        if bodyLength < FeedbackLimits.bodyLength.lowerBound { issues.append(.bodyTooShort) }
        if bodyLength > FeedbackLimits.bodyLength.upperBound { issues.append(.bodyTooLong) }
        return issues
    }

    public var isValid: Bool { validationIssues.isEmpty }
}

public enum FeedbackValidationIssue: Sendable, Equatable {
    case titleTooShort
    case titleTooLong
    case bodyTooShort
    case bodyTooLong
    case messageEmpty
    case messageTooLong

    public var message: String {
        switch self {
        case .titleTooShort:
            String(localized: "The title needs at least \(FeedbackLimits.titleLength.lowerBound) characters.", bundle: .module)
        case .titleTooLong:
            String(localized: "The title can be at most \(FeedbackLimits.titleLength.upperBound) characters.", bundle: .module)
        case .bodyTooShort:
            String(localized: "Please add a little more detail (at least \(FeedbackLimits.bodyLength.lowerBound) characters).", bundle: .module)
        case .bodyTooLong:
            String(localized: "The details can be at most \(FeedbackLimits.bodyLength.upperBound) characters.", bundle: .module)
        case .messageEmpty:
            String(localized: "Write a message first.", bundle: .module)
        case .messageTooLong:
            String(localized: "Messages can be at most \(FeedbackLimits.messageLength.upperBound) characters.", bundle: .module)
        }
    }
}

// MARK: - Statuses

public enum SubmissionState: String, Codable, Sendable {
    case pending
    case published
    case dismissed

    public var title: String {
        switch self {
        case .pending: String(localized: "Received", bundle: .module)
        case .published: String(localized: "Published", bundle: .module)
        case .dismissed: String(localized: "Closed", bundle: .module)
        }
    }
}

/// Status of a reviewed public issue.
public enum IssueStatus: String, Codable, Sendable, CaseIterable, Identifiable {
    case reported
    case planned
    case inProgress = "in_progress"
    case pending
    case testing
    case complete
    case closed

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .reported: String(localized: "Reported", bundle: .module)
        case .planned: String(localized: "Planned", bundle: .module)
        case .inProgress: String(localized: "In progress", bundle: .module)
        case .pending: String(localized: "Pending", bundle: .module)
        case .testing: String(localized: "Testing", bundle: .module)
        case .complete: String(localized: "Complete", bundle: .module)
        case .closed: String(localized: "Closed", bundle: .module)
        }
    }

    public var systemImage: String {
        switch self {
        case .reported: "circle"
        case .planned: "calendar"
        case .inProgress: "hammer"
        case .pending: "hourglass"
        case .testing: "testtube.2"
        case .complete: "checkmark.circle.fill"
        case .closed: "xmark.circle"
        }
    }
}

public enum RoadmapLane: String, Codable, Sendable {
    case now
    case next
    case later

    public var title: String {
        switch self {
        case .now: String(localized: "Now", bundle: .module)
        case .next: String(localized: "Next", bundle: .module)
        case .later: String(localized: "Later", bundle: .module)
        }
    }
}

// MARK: - Server responses

/// What `/api/submit` returns.
public struct SubmissionReceipt: Decodable, Sendable, Equatable {
    public let id: String
    public let state: SubmissionState
}

/// The public issue a report was published as.
public struct LinkedIssue: Decodable, Sendable, Hashable {
    public let number: Int
    public let status: IssueStatus
}

/// One of this installation's own reports, as returned by `/api/mine`.
public struct Submission: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let requestId: UUID
    public let kind: FeedbackKind
    public let title: String
    public let body: String
    public let state: SubmissionState
    public let createdAt: Date
    /// Present once the developer has published the report.
    public let issue: LinkedIssue?
    public let messageCount: Int
    /// Developer messages this installation hasn't read yet.
    public let unreadCount: Int
    public let lastMessageAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, requestId, kind, title, body, state, createdAt, issue, messageCount, unreadCount, lastMessageAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        requestId = try c.decode(UUID.self, forKey: .requestId)
        kind = try c.decode(FeedbackKind.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decode(String.self, forKey: .body)
        state = try c.decode(SubmissionState.self, forKey: .state)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        issue = try c.decodeIfPresent(LinkedIssue.self, forKey: .issue)
        messageCount = try c.decodeIfPresent(Int.self, forKey: .messageCount) ?? 0
        unreadCount = try c.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
        lastMessageAt = try c.decodeIfPresent(Date.self, forKey: .lastMessageAt)
    }
}

public struct SubmissionPage: Decodable, Sendable, Equatable {
    public let submissions: [Submission]
    public let hasMore: Bool
}

/// An image attached to a report or message. Bytes are fetched separately
/// with `FeedbackClient.attachmentData(id:)`; only the owner can read them.
public struct Attachment: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let contentType: String
    public let bytes: Int
    public let width: Int
    public let height: Int

    /// Width over height, or 1 when the server doesn't know the size.
    public var aspectRatio: CGFloat {
        width > 0 && height > 0 ? CGFloat(width) / CGFloat(height) : 1
    }
}

/// One message in the private conversation about a report.
public struct Message: Decodable, Sendable, Hashable, Identifiable {
    public enum Sender: String, Codable, Sendable {
        case user
        case developer
    }

    public let id: String
    public let sender: Sender
    /// May be empty when the message is images only.
    public let body: String
    public let seq: Int
    public let createdAt: Date
    public let attachments: [Attachment]

    enum CodingKeys: String, CodingKey {
        case id, sender, body, seq, createdAt, attachments
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sender = try c.decode(Sender.self, forKey: .sender)
        body = try c.decode(String.self, forKey: .body)
        seq = try c.decode(Int.self, forKey: .seq)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        attachments = try c.decodeIfPresent([Attachment].self, forKey: .attachments) ?? []
    }
}

public struct ConversationPage: Decodable, Sendable, Equatable {
    public let messages: [Message]
    public let hasMore: Bool
    /// Pass back as `after` to fetch the next page.
    public let nextAfter: Int
}

/// A reviewed, published issue as shown on the board.
public struct BoardIssue: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let number: Int
    public let title: String
    public let body: String
    public let status: IssueStatus
    public let release: String?
    public let roadmapLane: RoadmapLane?
    /// Kind of the earliest report behind the issue, when known.
    public let kind: FeedbackKind?
    public var votes: Int
    public var follows: Int
    /// This installation's own state; false when fetched anonymously.
    public var voted: Bool
    public var following: Bool
    public let createdAt: Date
    public let updatedAt: Date
}

public struct BoardApp: Decodable, Sendable, Equatable {
    public let id: String
    public let name: String
}

public struct BoardPage: Decodable, Sendable, Equatable {
    public let app: BoardApp
    public let issues: [BoardIssue]
    public let hasMore: Bool
}

public enum BoardSort: String, Sendable, CaseIterable, Identifiable {
    case recent
    case top

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .recent: String(localized: "Recently updated", bundle: .module)
        case .top: String(localized: "Most voted", bundle: .module)
        }
    }
}

/// Result of a vote or follow toggle: the issue's fresh counts and this installation's state.
public struct Engagement: Decodable, Sendable, Equatable {
    public let issueNumber: Int
    public let votes: Int
    public let voted: Bool
    public let follows: Int
    public let following: Bool
}

// MARK: - Request bodies

struct RegisterRequest: Encodable {
    let app: String
}

struct SubmitRequest: Encodable {
    let requestId: UUID
    let kind: FeedbackKind
    let title: String
    let body: String
    let diagnostics: FeedbackDiagnostics?
    let attachmentIds: [String]?

    init(draft: FeedbackDraft) {
        requestId = draft.requestID
        kind = draft.kind
        title = draft.normalizedTitle
        body = draft.normalizedBody
        diagnostics = draft.diagnostics
        attachmentIds = draft.attachmentIDs.isEmpty ? nil : draft.attachmentIDs
    }
}

struct UploadResponse: Decodable {
    let attachment: Attachment
}

struct MineRequest: Encodable {
    let offset: Int
}

struct ConversationRequest: Encodable {
    let submissionId: String
    let after: Int
}

struct ReplyRequest: Encodable {
    let submissionId: String
    let requestId: UUID
    let message: String
    let attachmentIds: [String]?
}

struct ConversationReadRequest: Encodable {
    let submissionId: String
    let through: Int
}

struct ToggleRequest: Encodable {
    let issueNumber: Int
    let on: Bool
}

struct RegisterResponse: Decodable {
    let token: String
}

struct ReplyResponse: Decodable {
    let message: Message
}

struct ReadThroughResponse: Decodable {
    let readThrough: Int
}

struct UnreadResponse: Decodable {
    let unread: Int
}

struct EmptyRequest: Encodable {}

struct APIErrorEnvelope: Decodable {
    struct Body: Decodable {
        let code: String
        let message: String
    }

    let error: Body
}
