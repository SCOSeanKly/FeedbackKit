//
//  InMemoryTokenStore.swift
//  FeedbackKitTests
//
//  Keychain stand-in so tests never touch the real one.
//

import FeedbackKit
import Foundation

final class InMemoryTokenStore: FeedbackTokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String] = [:]

    init(initial: [String: String] = [:]) {
        tokens = initial
    }

    func token(for account: String) throws -> String? {
        lock.withLock { tokens[account] }
    }

    func store(_ token: String, for account: String) throws {
        lock.withLock { tokens[account] = token }
    }

    func removeToken(for account: String) throws {
        _ = lock.withLock { tokens.removeValue(forKey: account) }
    }

    var all: [String: String] { lock.withLock { tokens } }
}
