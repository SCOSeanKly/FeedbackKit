//
//  FeedbackTokenStore.swift
//  FeedbackKit
//
//  Where the installation token lives. The Keychain implementation is the
//  default; the protocol exists so tests (and any host with its own secure
//  storage) can swap it without touching the client.
//

import Foundation
import Security

public protocol FeedbackTokenStore: Sendable {
    func token(for account: String) throws -> String?
    func store(_ token: String, for account: String) throws
    func removeToken(for account: String) throws
}

/// Generic-password Keychain items under one service name, one item per
/// (server, app) account. `AfterFirstUnlock` so a send queued in the
/// background still has its credential; the token is not synced to iCloud.
public struct KeychainTokenStore: FeedbackTokenStore {
    public var service: String

    public init(service: String = "dev.feedbackkit.installation-token") {
        self.service = service
    }

    public func token(for account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
                throw FeedbackError.keychain(errSecDecode)
            }
            return token
        case errSecItemNotFound:
            return nil
        default:
            throw FeedbackError.keychain(status)
        }
    }

    public func store(_ token: String, for account: String) throws {
        let data = Data(token.utf8)
        var attributes = baseQuery(account: account)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            let update: [String: Any] = [kSecValueData as String: data]
            let updateStatus = SecItemUpdate(baseQuery(account: account) as CFDictionary, update as CFDictionary)
            guard updateStatus == errSecSuccess else { throw FeedbackError.keychain(updateStatus) }
        default:
            throw FeedbackError.keychain(status)
        }
    }

    public func removeToken(for account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw FeedbackError.keychain(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
