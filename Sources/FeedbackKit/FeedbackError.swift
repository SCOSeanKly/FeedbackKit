//
//  FeedbackError.swift
//  FeedbackKit
//
//  Every failure the client can surface, mapped from the Worker's status
//  codes so views can react to specific cases (conflict, rate limit) and show
//  a sensible message for the rest.
//

import Foundation

public enum FeedbackError: Error, Sendable, Equatable {
    /// The draft fails client-side validation; nothing was sent.
    case invalidInput([FeedbackValidationIssue])
    /// 401 after one re-registration attempt. The server rejected both tokens.
    case unauthorized
    /// 403: the server refused on policy grounds.
    case forbidden(String?)
    /// 403 with an App Attest code: the installation must attest (or sign)
    /// and the client could not satisfy that, e.g. on a device without
    /// App Attest while the server runs in `required` mode.
    case attestationRequired
    /// 404: usually the app id is not registered on the server.
    case notFound(String?)
    /// 409: this requestId was already used for different content.
    case conflict
    /// 413: the request body exceeded the server's limit.
    case payloadTooLarge
    /// 429 with the parsed Retry-After, when the server sent one.
    case rateLimited(retryAfter: TimeInterval?)
    /// Any other non-2xx status.
    case server(status: Int, message: String?)
    /// The response was not HTTP, or its body could not be decoded.
    case invalidResponse
    /// A transport failure from URLSession.
    case network(URLError)
    /// The Keychain refused to read or write the installation token.
    case keychain(OSStatus)
}

extension FeedbackError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidInput(let issues):
            return issues.first?.message ?? String(localized: "Please check what you've written.", bundle: .module)
        case .unauthorized:
            return String(localized: "This installation couldn't be verified. Please try again later.", bundle: .module)
        case .forbidden(let message):
            return message ?? String(localized: "The server declined this request.", bundle: .module)
        case .attestationRequired:
            return String(localized: "This device couldn't be verified with the feedback service.", bundle: .module)
        case .notFound(let message):
            return message ?? String(localized: "The feedback service isn't set up for this app yet.", bundle: .module)
        case .conflict:
            return String(localized: "An earlier copy of this report already reached us with different text.", bundle: .module)
        case .payloadTooLarge:
            return String(localized: "This report is too large to send.", bundle: .module)
        case .rateLimited(let retryAfter):
            if let retryAfter {
                let seconds = Int(retryAfter.rounded(.up))
                return String(localized: "You're sending too quickly. Try again in \(seconds) seconds.", bundle: .module)
            }
            return String(localized: "You're sending too quickly. Please try again shortly.", bundle: .module)
        case .server(let status, let message):
            return message ?? String(localized: "The feedback service returned an error (\(status)).", bundle: .module)
        case .invalidResponse:
            return String(localized: "The feedback service sent an unexpected response.", bundle: .module)
        case .network(let error):
            return error.localizedDescription
        case .keychain:
            return String(localized: "Couldn't access secure storage on this device.", bundle: .module)
        }
    }

    /// True when sending the same draft again, unchanged, may succeed.
    public var isRetryable: Bool {
        switch self {
        case .rateLimited, .network, .server, .invalidResponse: true
        default: false
        }
    }
}
