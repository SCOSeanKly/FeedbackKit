//
//  FeedbackConfiguration.swift
//  FeedbackKit
//
//  The only per-app wiring: where the Worker lives and which app this is.
//  Both values are public information; the installation token the client
//  earns at runtime is the only secret, and it lives in the Keychain.
//

import Foundation

public struct FeedbackConfiguration: Sendable, Hashable {
    /// Origin of the FeedbackKit Worker, for example `https://feedback.example.com`.
    public var baseURL: URL

    /// The `apps.id` value registered on the server for this app.
    public var appID: String

    /// Whether to prove the installation with App Attest when the device
    /// supports it. Defaults to on; the simulator and servers with App
    /// Attest disabled fall back to a plain token automatically.
    public var attestation: AttestationPolicy

    public init(baseURL: URL, appID: String, attestation: AttestationPolicy = .whenAvailable) {
        self.baseURL = baseURL
        self.appID = appID
        self.attestation = attestation
    }

    /// Keychain account name: one token per (server, app) pair, so a test
    /// server and production never share credentials.
    var tokenAccount: String {
        "\(baseURL.host() ?? baseURL.absoluteString)/\(appID)"
    }

    /// Keychain account holding the registered App Attest key id.
    var attestKeyAccount: String {
        "\(tokenAccount)/attest-key"
    }
}
