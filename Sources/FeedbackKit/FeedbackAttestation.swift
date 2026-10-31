//
//  FeedbackAttestation.swift
//  FeedbackKit
//
//  Apple App Attest support. The Secure Enclave key never leaves the
//  device; the server learns its public half once (attestation) and then
//  checks a signature on every write (assertion). `AppAttestProvider` is a
//  seam over DCAppAttestService so tests can run without a device.
//

import CryptoKit
import DeviceCheck
import Foundation

public protocol AppAttestProvider: Sendable {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data
}

/// The real thing. Unsupported on the simulator and on Macs without a Secure Enclave.
public struct DeviceCheckAttestProvider: AppAttestProvider {
    public init() {}

    public var isSupported: Bool { DCAppAttestService.shared.isSupported }

    public func generateKey() async throws -> String {
        try await DCAppAttestService.shared.generateKey()
    }

    public func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await DCAppAttestService.shared.attestKey(keyID, clientDataHash: clientDataHash)
    }

    public func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await DCAppAttestService.shared.generateAssertion(keyID, clientDataHash: clientDataHash)
    }
}

/// How hard the client tries to attest.
public enum AttestationPolicy: Sendable, Hashable {
    /// Never touch App Attest. Registration is a plain token.
    case disabled
    /// Attest when the device supports it; fall back to a plain token
    /// otherwise (simulator, server with App Attest off).
    case whenAvailable
}

// MARK: - Wire types

struct AttestChallengeRequest: Encodable {
    let purpose: String
    let path: String
}

struct AttestChallengeResponse: Decodable {
    let challenge: String
}

struct AttestRegisterRequest: Encodable {
    let app: String
    let keyId: String
    let challenge: String
    let attestation: String
}

struct AttestRegisterResponse: Decodable {
    let token: String?
    let upgraded: Bool
}

/// What an assertion signs. Encoded with sorted keys so the bytes the
/// server hashes are exactly the bytes we hashed.
struct AssertionClientData: Encodable {
    let bodyHash: String
    let challenge: String
    let method: String
    let path: String
}

/// The headers that carry an assertion.
struct AssertionHeaders: Sendable {
    static let key = "X-Attest-Key"
    static let clientData = "X-Attest-Client-Data"
    static let assertion = "X-Attest-Assertion"

    let keyID: String
    let clientData: Data
    let assertion: Data

    var fields: [String: String] {
        [
            Self.key: keyID,
            Self.clientData: clientData.base64EncodedString(),
            Self.assertion: assertion.base64EncodedString(),
        ]
    }
}

enum AttestationEncoding {
    static func canonicalJSON<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func dataFromBase64url(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
        return Data(base64Encoded: base64)
    }
}
