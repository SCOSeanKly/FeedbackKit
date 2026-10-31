//
//  FeedbackDraftStore.swift
//  FeedbackKit
//
//  Persists the one in-progress draft, requestID included, so a send that
//  times out (or an app that is killed mid-way) retries with the same id and
//  the server counts the report once. Cleared only when the server confirms.
//

import Foundation

public struct FeedbackDraftStore: Sendable {
    public let fileURL: URL

    /// Stores under Application Support/FeedbackKit/<appID>/pending-draft.json
    /// unless a directory is supplied (tests use a temporary one).
    public init(appID: String, directory: URL? = nil) {
        let base = directory ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "FeedbackKit", directoryHint: .isDirectory)
        fileURL = base
            .appending(path: appID, directoryHint: .isDirectory)
            .appending(path: "pending-draft.json")
    }

    public func load() throws -> FeedbackDraft? {
        guard FileManager.default.fileExists(atPath: fileURL.path()) else { return nil }
        let data = try Data(contentsOf: fileURL)
        return try JSONDecoder().decode(FeedbackDraft.self, from: data)
    }

    public func save(_ draft: FeedbackDraft) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(draft)
        #if os(iOS)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
        #else
        try data.write(to: fileURL, options: [.atomic])
        #endif
    }

    public func clear() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path()) else { return }
        try FileManager.default.removeItem(at: fileURL)
    }
}
