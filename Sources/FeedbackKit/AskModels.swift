//
//  AskModels.swift
//  FeedbackKit
//
//  What the Ask endpoints send and return. Ask is the in-app helper that
//  answers "how do I do X?" from the app's own knowledge, served by the same
//  Worker as feedback (see worker/src/routes/ask.ts).
//

import Foundation

/// Per-app settings the chat needs before the first question.
public struct AskConfiguration: Decodable, Sendable, Equatable {
    public let enabled: Bool
    /// The assistant's display name, e.g. "Ask NuKey".
    public let name: String
    /// Starter questions shown above the input.
    public let suggestions: [String]
}

/// One turn of the conversation, sent back with the next question so follow-ups make sense.
public struct AskTurn: Codable, Sendable, Equatable {
    public enum Role: String, Codable, Sendable {
        case user
        case assistant
    }

    public let role: Role
    public let content: String

    public init(role: Role, content: String) {
        self.role = role
        self.content = content
    }
}

/// The helper's reply.
public struct AskAnswer: Decodable, Sendable, Equatable {
    /// Plain text with **bold** and numbered lines.
    public let answer: String
    /// Slug of the most useful guide, one the app published. Nil when none fits.
    public let guide: String?
    public let guideTitle: String?
    /// Identifies the answer for `rateAskAnswer`. Nil for canned replies that were never logged.
    public let logId: String?
}

struct AskRequest: Encodable {
    let question: String
    let history: [AskTurn]
}

struct AskFeedbackRequest: Encodable {
    let logId: String
    let helpful: Bool
}

struct AskAcknowledgement: Decodable {
    let ok: Bool
}
