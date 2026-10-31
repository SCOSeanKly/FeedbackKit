//
//  FeedbackClientPhase3Tests.swift
//  FeedbackKitTests
//
//  Votes, follows, conversations and the board. Declared as an extension of
//  the main suite so they share its `.serialized` trait: the URLProtocol mock
//  is process-wide, so suites must not run concurrently with each other.
//

import Foundation
import Testing
@testable import FeedbackKit

extension FeedbackClientTests {
    private func makeAuthenticatedClient() -> (FeedbackClient, MockTransport) {
        let transport = MockTransport()
        MockURLProtocol.transport = transport
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "FeedbackKitTests-\(UUID().uuidString)")
        let client = FeedbackClient(
            configuration: configuration,
            urlSession: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore(initial: [configuration.tokenAccount: "fk1_ok"]),
            draftStore: FeedbackDraftStore(appID: configuration.appID, directory: directory)
        )
        return (client, transport)
    }

    private static var engagementJSON: [String: Any] {
        ["issueNumber": 7, "votes": 3, "voted": true, "follows": 1, "following": false]
    }

    @Test("vote posts issueNumber and on, decodes counts")
    func vote() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(200, Self.engagementJSON))

        let result = try await client.vote(issueNumber: 7, on: true)

        let request = try #require(transport.requests.first)
        #expect(request.path == "/api/vote")
        #expect(request.method == "POST")
        #expect(request.json["issueNumber"] as? Int == 7)
        #expect(request.json["on"] as? Bool == true)
        #expect(result == Engagement(issueNumber: 7, votes: 3, voted: true, follows: 1, following: false))
    }

    @Test("follow off hits /api/follow")
    func follow() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(200, Self.engagementJSON))

        _ = try await client.follow(issueNumber: 7, on: false)

        let request = try #require(transport.requests.first)
        #expect(request.path == "/api/follow")
        #expect(request.json["on"] as? Bool == false)
    }

    @Test("conversation pages by after and decodes messages in order")
    func conversation() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(200, [
            "messages": [
                ["id": "m1", "sender": "user", "body": "Hello", "seq": 1, "createdAt": "2026-10-07T10:00:00Z"],
                ["id": "m2", "sender": "developer", "body": "Hi!", "seq": 2, "createdAt": "2026-10-07T10:05:00Z"],
            ],
            "hasMore": false,
            "nextAfter": 2,
        ]))

        let page = try await client.conversation(submissionID: "sub-1", after: 0)

        let request = try #require(transport.requests.first)
        #expect(request.path == "/api/conversation")
        #expect(request.json["submissionId"] as? String == "sub-1")
        #expect(request.json["after"] as? Int == 0)
        #expect(page.messages.map(\.seq) == [1, 2])
        #expect(page.messages[1].sender == .developer)
        #expect(page.nextAfter == 2)
        #expect(!page.hasMore)
    }

    @Test("reply sends the same requestId and normalises the text")
    func reply() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(201, [
            "message": ["id": "m3", "sender": "user", "body": "Any update?", "seq": 3, "createdAt": "2026-10-07T11:00:00Z"],
        ]))
        let requestID = UUID()

        let message = try await client.reply(submissionID: "sub-1", requestID: requestID, message: "  Any update?\r\n")

        let request = try #require(transport.requests.first)
        #expect(request.path == "/api/reply")
        #expect(request.json["requestId"] as? String == requestID.uuidString)
        #expect(request.json["message"] as? String == "Any update?")
        #expect(message.id == "m3")
    }

    @Test("reply rejects empty and oversized text locally")
    func replyValidation() async throws {
        let (client, transport) = makeAuthenticatedClient()

        await #expect(throws: FeedbackError.invalidInput([.messageEmpty])) {
            try await client.reply(submissionID: "sub-1", requestID: UUID(), message: "   ")
        }
        await #expect(throws: FeedbackError.invalidInput([.messageTooLong])) {
            try await client.reply(submissionID: "sub-1", requestID: UUID(), message: String(repeating: "x", count: 4_001))
        }
        #expect(transport.requests.isEmpty)
    }

    @Test("reply 409 surfaces as conflict")
    func replyConflict() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(409, ["error": ["code": "request_id_conflict", "message": "used"]]))

        await #expect(throws: FeedbackError.conflict) {
            try await client.reply(submissionID: "sub-1", requestID: UUID(), message: "Hello")
        }
    }

    @Test("unreadReplies posts to /api/unread and returns the count; isRegistered reflects the token")
    func unreadReplies() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(200, ["unread": 3]))

        #expect(try await client.isRegistered)
        let unread = try await client.unreadReplies()

        #expect(unread == 3)
        #expect(transport.requests.first?.path == "/api/unread")
        #expect(transport.requests.first?.authorization == "Bearer fk1_ok")
    }

    @Test("markConversationRead posts through and returns the marker")
    func markRead() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(200, ["readThrough": 5]))

        let through = try await client.markConversationRead(submissionID: "sub-1", through: 5)

        #expect(through == 5)
        #expect(transport.requests.first?.json["through"] as? Int == 5)
    }

    @Test("board is a GET with bearer, query params and personalised flags")
    func board() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(200, [
            "app": ["id": "demo", "name": "Demo"],
            "issues": [[
                "id": "i1", "number": 4, "title": "Dark icon", "body": "", "status": "in_progress",
                "release": "1.3", "roadmapLane": "now", "kind": "idea",
                "votes": 12, "follows": 3, "voted": true, "following": false,
                "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-07T00:00:00Z",
            ]],
            "hasMore": true,
        ]))

        let page = try await client.board(status: .inProgress, query: "dark", sort: .top, offset: 25)

        let request = try #require(transport.requests.first)
        #expect(request.method == "GET")
        #expect(request.path == "/api/board/demo")
        #expect(request.authorization == "Bearer fk1_ok")
        let components = URLComponents(url: request.url, resolvingAgainstBaseURL: false)
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query == ["status": "in_progress", "q": "dark", "sort": "top", "offset": "25"])
        #expect(request.body.isEmpty)
        #expect(page.app.name == "Demo")
        let issue = try #require(page.issues.first)
        #expect(issue.status == .inProgress)
        #expect(issue.roadmapLane == .now)
        #expect(issue.voted && !issue.following)
        #expect(page.hasMore)
    }

    @Test("mine decodes the linked issue and unread counters, tolerating their absence")
    func mineCounters() async throws {
        let (client, transport) = makeAuthenticatedClient()
        transport.enqueue(.json(200, [
            "submissions": [
                [
                    "id": "s1", "requestId": UUID().uuidString, "kind": "issue", "title": "Crash", "body": "It crashes.",
                    "state": "published", "createdAt": "2026-10-07T12:00:00Z",
                    "issue": ["number": 9, "status": "planned"], "messageCount": 2, "unreadCount": 1,
                    "lastMessageAt": "2026-10-07T13:00:00Z",
                ],
                [
                    "id": "s2", "requestId": UUID().uuidString, "kind": "idea", "title": "Old shape", "body": "No counters here.",
                    "state": "pending", "createdAt": "2026-10-06T12:00:00Z",
                ],
            ],
            "hasMore": false,
        ]))

        let page = try await client.myReports()

        #expect(page.submissions[0].issue == LinkedIssue(number: 9, status: .planned))
        #expect(page.submissions[0].unreadCount == 1)
        #expect(page.submissions[1].issue == nil)
        #expect(page.submissions[1].messageCount == 0)
    }
}
