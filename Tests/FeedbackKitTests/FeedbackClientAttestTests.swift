//
//  FeedbackClientAttestTests.swift
//  FeedbackKitTests
//
//  App Attest flow and diagnostics, using a fake provider. An extension of
//  the main suite so the process-wide URLProtocol mock is never shared
//  between concurrently running suites.
//

import CryptoKit
import Foundation
import Testing
@testable import FeedbackKit

/// Deterministic stand-in for DeviceCheck.
final class FakeAttestProvider: AppAttestProvider, @unchecked Sendable {
    private let lock = NSLock()
    var supported: Bool
    private(set) var generatedKeys = 0
    private(set) var attestations: [(keyID: String, clientDataHash: Data)] = []
    private(set) var assertions: [(keyID: String, clientDataHash: Data)] = []

    init(supported: Bool = true) {
        self.supported = supported
    }

    var isSupported: Bool { supported }

    func generateKey() async throws -> String {
        lock.withLock {
            generatedKeys += 1
            return "key-\(generatedKeys)"
        }
    }

    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        lock.withLock { attestations.append((keyID, clientDataHash)) }
        return Data("ATTESTATION".utf8)
    }

    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        lock.withLock { assertions.append((keyID, clientDataHash)) }
        return Data("ASSERTION".utf8)
    }
}

extension FeedbackClientTests {
    private func makeAttestClient(
        provider: FakeAttestProvider,
        tokens: [String: String] = [:]
    ) -> (FeedbackClient, MockTransport, InMemoryTokenStore) {
        let transport = MockTransport()
        MockURLProtocol.transport = transport
        let tokenStore = InMemoryTokenStore(initial: tokens)
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "FeedbackKitTests-\(UUID().uuidString)")
        let client = FeedbackClient(
            configuration: configuration,
            urlSession: MockURLProtocol.makeSession(),
            tokenStore: tokenStore,
            draftStore: FeedbackDraftStore(appID: configuration.appID, directory: directory),
            attestProvider: provider
        )
        return (client, transport, tokenStore)
    }

    private var sampleDraft: FeedbackDraft {
        FeedbackDraft(kind: .issue, title: "Attested report", body: "Sent from a device that can attest.")
    }

    @Test("Attested registration then a signed submit")
    func attestedRegistrationAndSignedWrite() async throws {
        let provider = FakeAttestProvider()
        let (client, transport, tokenStore) = makeAttestClient(provider: provider)
        transport.enqueue(
            .json(200, ["challenge": "cmVnaXN0ZXI", "expiresIn": 300]),
            .json(201, ["token": "fk1_attested", "upgraded": false]),
            .json(200, ["challenge": "YXNzZXJ0", "expiresIn": 300]),
            .json(201, ["id": "sub-1", "state": "pending"])
        )

        let draft = sampleDraft
        let receipt = try await client.submit(draft)
        #expect(receipt.id == "sub-1")

        let requests = transport.requests
        #expect(requests.map(\.path) == ["/api/attest/challenge", "/api/attest/register", "/api/attest/challenge", "/api/submit"])

        // Register: purpose/path on the challenge, then key + attestation + challenge.
        #expect(requests[0].json["purpose"] as? String == "register")
        #expect(requests[0].json["path"] as? String == "/api/attest/register")
        #expect(requests[1].authorization == nil)
        #expect(requests[1].json["app"] as? String == "demo")
        #expect(requests[1].json["keyId"] as? String == "key-1")
        #expect(requests[1].json["challenge"] as? String == "cmVnaXN0ZXI")
        #expect(requests[1].json["attestation"] as? String == Data("ATTESTATION".utf8).base64EncodedString())
        let challengeBytes = try #require(AttestationEncoding.dataFromBase64url("cmVnaXN0ZXI"))
        #expect(provider.attestations.first?.clientDataHash == Data(SHA256.hash(data: challengeBytes)))

        // Assertion: challenge for the write path, then signed headers.
        #expect(requests[2].json["purpose"] as? String == "assert")
        #expect(requests[2].json["path"] as? String == "/api/submit")
        let submit = requests[3]
        #expect(submit.authorization == "Bearer fk1_attested")
        #expect(submit.headers["X-Attest-Key"] == "key-1")
        #expect(submit.headers["X-Attest-Assertion"] == Data("ASSERTION".utf8).base64EncodedString())
        let clientDataHeader = try #require(submit.headers["X-Attest-Client-Data"])
        let clientData = try #require(Data(base64Encoded: clientDataHeader))
        let claim = try #require(JSONSerialization.jsonObject(with: clientData) as? [String: String])
        #expect(claim["method"] == "POST")
        #expect(claim["path"] == "/api/submit")
        #expect(claim["challenge"] == "YXNzZXJ0")
        #expect(claim["bodyHash"] == AttestationEncoding.base64url(Data(SHA256.hash(data: submit.body))))
        #expect(provider.assertions.first?.clientDataHash == Data(SHA256.hash(data: clientData)))

        #expect(tokenStore.all[configuration.tokenAccount] == "fk1_attested")
        #expect(tokenStore.all[configuration.attestKeyAccount] == "key-1")
        #expect(try await client.isAttested)
    }

    @Test("Reads are never signed")
    func readsAreNotSigned() async throws {
        let provider = FakeAttestProvider()
        let (client, transport, _) = makeAttestClient(
            provider: provider,
            tokens: [configuration.tokenAccount: "fk1_ok", configuration.attestKeyAccount: "key-9"]
        )
        transport.enqueue(.json(200, ["submissions": [], "hasMore": false]))

        _ = try await client.myReports()

        let request = try #require(transport.requests.first)
        #expect(request.path == "/api/mine")
        #expect(request.headers["X-Attest-Key"] == nil)
        #expect(provider.assertions.isEmpty)
    }

    @Test("Without App Attest support the client registers plainly")
    func unsupportedDeviceFallsBack() async throws {
        let (client, transport, _) = makeAttestClient(provider: FakeAttestProvider(supported: false))
        transport.enqueue(
            .json(201, ["token": "fk1_plain"]),
            .json(201, ["id": "sub-2", "state": "pending"])
        )

        _ = try await client.submit(sampleDraft)

        #expect(transport.requests.map(\.path) == ["/api/register", "/api/submit"])
        #expect(transport.requests[1].headers["X-Attest-Key"] == nil)
    }

    @Test("Server with App Attest disabled falls back to a plain token")
    func serverDisabledFallsBack() async throws {
        let (client, transport, _) = makeAttestClient(provider: FakeAttestProvider())
        transport.enqueue(
            .json(404, ["error": ["code": "attest_disabled", "message": "off"]]),
            .json(201, ["token": "fk1_plain"]),
            .json(200, ["submissions": [], "hasMore": false])
        )

        _ = try await client.myReports()

        #expect(transport.requests.map(\.path) == ["/api/attest/challenge", "/api/register", "/api/mine"])
    }

    @Test("A 403 attestation code upgrades the existing installation and retries once")
    func attestationRequiredUpgrades() async throws {
        let provider = FakeAttestProvider()
        let (client, transport, tokenStore) = makeAttestClient(provider: provider, tokens: [configuration.tokenAccount: "fk1_old"])
        transport.enqueue(
            .json(403, ["error": ["code": "attestation_required", "message": "verify"]]),
            .json(200, ["challenge": "cmVnaXN0ZXI", "expiresIn": 300]),
            .json(200, ["token": NSNull(), "upgraded": true]),
            .json(200, ["challenge": "YXNzZXJ0", "expiresIn": 300]),
            .json(200, ["issueNumber": 3, "votes": 1, "voted": true, "follows": 0, "following": false])
        )

        let result = try await client.vote(issueNumber: 3, on: true)

        #expect(result.voted)
        let paths = transport.requests.map(\.path)
        #expect(paths == ["/api/vote", "/api/attest/challenge", "/api/attest/register", "/api/attest/challenge", "/api/vote"])
        // The upgrade carries the existing token so the server binds the key to it.
        #expect(transport.requests[2].authorization == "Bearer fk1_old")
        #expect(transport.requests[4].headers["X-Attest-Key"] == "key-1")
        #expect(tokenStore.all[configuration.tokenAccount] == "fk1_old")
        #expect(tokenStore.all[configuration.attestKeyAccount] == "key-1")
    }

    @Test("A 403 attestation code without App Attest support surfaces as attestationRequired")
    func attestationRequiredUnsupported() async throws {
        let (client, transport, _) = makeAttestClient(
            provider: FakeAttestProvider(supported: false),
            tokens: [configuration.tokenAccount: "fk1_old"]
        )
        transport.enqueue(.json(403, ["error": ["code": "attestation_required", "message": "verify"]]))

        await #expect(throws: FeedbackError.attestationRequired) {
            try await client.vote(issueNumber: 3, on: true)
        }
    }

    @Test("Diagnostics ride along in the submit body when attached")
    func diagnosticsIncluded() async throws {
        let (client, transport, _) = makeAttestClient(
            provider: FakeAttestProvider(supported: false),
            tokens: [configuration.tokenAccount: "fk1_ok"]
        )
        transport.enqueue(.json(201, ["id": "sub-3", "state": "pending"]))
        var draft = sampleDraft
        draft.diagnostics = FeedbackDiagnostics(
            appVersion: "1.2", build: "34", platform: "iOS", osVersion: "27.0.1",
            deviceModel: "iPhone17,1", locale: "en_GB", timeZone: "Europe/London", extras: ["screen": "Builder"]
        )

        _ = try await client.submit(draft)

        let diagnostics = try #require(transport.requests.first?.json["diagnostics"] as? [String: Any])
        #expect(diagnostics["appVersion"] as? String == "1.2")
        #expect((diagnostics["extras"] as? [String: String])?["screen"] == "Builder")
        #expect(draft.diagnostics?.summary == "App 1.2 (34) · iOS 27.0.1 · iPhone17,1 · en_GB · screen")
    }

    @Test("Diagnostics are omitted when the draft has none")
    func diagnosticsOmitted() async throws {
        let (client, transport, _) = makeAttestClient(
            provider: FakeAttestProvider(supported: false),
            tokens: [configuration.tokenAccount: "fk1_ok"]
        )
        transport.enqueue(.json(201, ["id": "sub-4", "state": "pending"]))

        _ = try await client.submit(sampleDraft)

        #expect(transport.requests.first?.json["diagnostics"] == nil)
    }
}
