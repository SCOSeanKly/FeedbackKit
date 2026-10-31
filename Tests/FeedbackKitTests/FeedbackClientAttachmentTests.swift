//
//  FeedbackClientAttachmentTests.swift
//  FeedbackKitTests
//
//  Image uploads, downloads and linking. Extension of the main suite for
//  the shared `.serialized` trait.
//

import Foundation
import Testing
@testable import FeedbackKit

extension FeedbackClientTests {
    private func makeMediaClient() -> (FeedbackClient, MockTransport) {
        let transport = MockTransport()
        MockURLProtocol.transport = transport
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "FeedbackKitTests-\(UUID().uuidString)")
        let client = FeedbackClient(
            configuration: configuration,
            urlSession: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore(initial: [configuration.tokenAccount: "fk1_ok"]),
            draftStore: FeedbackDraftStore(appID: configuration.appID, directory: directory),
            attestProvider: FakeAttestProvider(supported: false)
        )
        return (client, transport)
    }

    private var attachmentJSON: [String: Any] {
        ["id": "att-1", "contentType": "image/jpeg", "bytes": 3, "width": 640, "height": 480]
    }

    @Test("uploadAttachment posts raw JPEG bytes with size headers")
    func upload() async throws {
        let (client, transport) = makeMediaClient()
        transport.enqueue(.json(201, ["attachment": attachmentJSON]))
        let image = PreparedImage(data: Data([0xff, 0xd8, 0xff]), width: 640, height: 480)

        let attachment = try await client.uploadAttachment(image)

        let request = try #require(transport.requests.first)
        #expect(request.path == "/api/attachments")
        #expect(request.method == "POST")
        #expect(request.headers["Content-Type"] == "image/jpeg")
        #expect(request.headers["X-Image-Width"] == "640")
        #expect(request.headers["X-Image-Height"] == "480")
        #expect(request.body == Data([0xff, 0xd8, 0xff]))
        #expect(attachment.id == "att-1")
        #expect(attachment.aspectRatio == CGFloat(640) / CGFloat(480))
    }

    @Test("attachmentData fetches once and then serves from cache")
    func downloadCached() async throws {
        let (client, transport) = makeMediaClient()
        let bytes = Data("PNGBYTES".utf8)
        transport.enqueue(MockResponse(status: 200, body: bytes, headers: ["Content-Type": "image/png"]))
        let id = UUID().uuidString.lowercased()

        let first = try await client.attachmentData(id: id)
        let second = try await client.attachmentData(id: id)

        #expect(first == bytes && second == bytes)
        #expect(transport.requests.count == 1)
        #expect(transport.requests[0].method == "GET")
        #expect(transport.requests[0].path == "/api/attachments/\(id)")
        #expect(transport.requests[0].authorization == "Bearer fk1_ok")
    }

    @Test("reply carries attachmentIds and allows empty text with images")
    func replyWithImages() async throws {
        let (client, transport) = makeMediaClient()
        transport.enqueue(.json(201, [
            "message": ["id": "m9", "sender": "user", "body": "", "seq": 4, "createdAt": "2026-10-21T10:00:00Z",
                        "attachments": [attachmentJSON]],
        ]))

        let message = try await client.reply(submissionID: "sub-1", requestID: UUID(), message: "  ", attachmentIDs: ["att-1"])

        let request = try #require(transport.requests.first)
        #expect(request.json["attachmentIds"] as? [String] == ["att-1"])
        #expect(request.json["message"] as? String == "")
        #expect(message.attachments.map(\.id) == ["att-1"])
    }

    @Test("reply without text or images is rejected locally")
    func replyEmpty() async throws {
        let (client, transport) = makeMediaClient()
        await #expect(throws: FeedbackError.invalidInput([.messageEmpty])) {
            try await client.reply(submissionID: "sub-1", requestID: UUID(), message: "", attachmentIDs: [])
        }
        #expect(transport.requests.isEmpty)
    }

    @Test("submit sends attachmentIds only when the draft has some")
    func submitWithImages() async throws {
        let (client, transport) = makeMediaClient()
        transport.enqueue(.json(201, ["id": "sub-5", "state": "pending"]), .json(201, ["id": "sub-6", "state": "pending"]))

        var draft = FeedbackDraft(title: "With screenshot", body: "The screenshot shows the problem.")
        draft.attachmentIDs = ["att-1", "att-2"]
        _ = try await client.submit(draft)
        _ = try await client.submit(FeedbackDraft(title: "Without one", body: "Plain text report here."))

        #expect(transport.requests[0].json["attachmentIds"] as? [String] == ["att-1", "att-2"])
        #expect(transport.requests[1].json["attachmentIds"] == nil)
    }

    @Test("Messages without an attachments field decode with none, and drafts without ids load")
    func backwardsCompatibleDecoding() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let message = try decoder.decode(Message.self, from: Data(#"{"id":"m1","sender":"developer","body":"Hi","seq":1,"createdAt":"2026-10-21T10:00:00Z"}"#.utf8))
        #expect(message.attachments.isEmpty)

        let draft = try JSONDecoder().decode(FeedbackDraft.self, from: Data(#"{"requestID":"4B1E2C6A-2E0B-4F67-9B0E-3B8B6A2B9C11","kind":"idea","title":"Old draft","body":"Saved before attachments existed."}"#.utf8))
        #expect(draft.attachmentIDs.isEmpty)
    }

    @Test("Image preparer downsizes and re-encodes as JPEG")
    func preparer() throws {
        // A 1x1 PNG; the preparer should hand back a JPEG with the same size.
        let png = try #require(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="))
        let prepared = try #require(FeedbackImagePreparer.prepare(png))
        #expect(prepared.width == 1 && prepared.height == 1)
        #expect(prepared.contentType == "image/jpeg")
        #expect(prepared.data.prefix(3) == Data([0xff, 0xd8, 0xff]))
    }
}
