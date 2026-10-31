//
//  MockURLProtocol.swift
//  FeedbackKitTests
//
//  Intercepts every request on a test URLSession, records it, and answers
//  from a scripted queue. The queue is shared static state, so suites that
//  use it run `.serialized`.
//

import Foundation

struct MockResponse {
    var status: Int
    var body: Data
    var headers: [String: String] = ["Content-Type": "application/json"]

    static func json(_ status: Int, _ object: [String: Any], headers: [String: String] = [:]) -> MockResponse {
        let data = try! JSONSerialization.data(withJSONObject: object)
        var allHeaders = ["Content-Type": "application/json"]
        allHeaders.merge(headers) { _, new in new }
        return MockResponse(status: status, body: data, headers: allHeaders)
    }
}

/// A recorded request with its body already read out of the stream.
struct RecordedRequest {
    let url: URL
    let method: String
    let headers: [String: String]
    let body: Data

    var json: [String: Any] {
        (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
    }

    var path: String { url.path() }
    var authorization: String? { headers["Authorization"] }
}

final class MockTransport: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [MockResponse] = []
    private(set) var recorded: [RecordedRequest] = []

    func enqueue(_ responses: MockResponse...) {
        lock.withLock { queue.append(contentsOf: responses) }
    }

    fileprivate func record(_ request: RecordedRequest) -> MockResponse? {
        lock.withLock {
            recorded.append(request)
            return queue.isEmpty ? nil : queue.removeFirst()
        }
    }

    var requests: [RecordedRequest] { lock.withLock { recorded } }
}

final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var transport = MockTransport()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.httpBody ?? Self.readStream(request.httpBodyStream)
        let recorded = RecordedRequest(
            url: request.url!,
            method: request.httpMethod ?? "GET",
            headers: request.allHTTPHeaderFields ?? [:],
            body: body
        )
        guard let response = Self.transport.record(recorded) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: response.headers
        )!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readStream(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    /// A session that routes everything through this protocol.
    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }
}
