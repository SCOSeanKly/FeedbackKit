//
//  FeedbackImages.swift
//  FeedbackKit
//
//  Getting a picked photo ready to upload (downscale, fix orientation,
//  re-encode as JPEG) and a small cache for images coming back down. Uses
//  ImageIO so it works the same on iOS and macOS and handles HEIC input.
//

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A JPEG ready for `FeedbackClient.uploadAttachment`.
public struct PreparedImage: Sendable, Equatable {
    public let data: Data
    public let width: Int
    public let height: Int
    public var contentType: String { "image/jpeg" }

    public init(data: Data, width: Int, height: Int) {
        self.data = data
        self.width = width
        self.height = height
    }
}

public enum FeedbackImagePreparer {
    /// Longest side after downscaling. Plenty for a screenshot, small enough
    /// to upload on a poor connection.
    public static let maxDimension = 2048
    public static let jpegQuality: CGFloat = 0.82

    /// Decodes any image ImageIO understands (JPEG, PNG, HEIC, ...), applies
    /// the EXIF orientation, scales it down and re-encodes as JPEG.
    public static func prepare(_ data: Data, maxDimension: Int = maxDimension) -> PreparedImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return PreparedImage(data: output as Data, width: image.width, height: image.height)
    }
}

/// Memory plus on-disk cache for attachment bytes. Attachments are immutable,
/// so a cached copy never goes stale.
actor AttachmentCache {
    static let shared = AttachmentCache()

    private var memory: [String: Data] = [:]
    private var memoryBytes = 0
    private let memoryLimit = 40 * 1024 * 1024
    private let directory: URL

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        directory = caches.appending(path: "FeedbackKit/attachments", directoryHint: .isDirectory)
    }

    func data(for id: String) -> Data? {
        if let hit = memory[id] { return hit }
        let url = directory.appending(path: id)
        guard let data = try? Data(contentsOf: url) else { return nil }
        remember(id, data)
        return data
    }

    func store(_ data: Data, for id: String) {
        remember(id, data)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: directory.appending(path: id), options: .atomic)
    }

    private func remember(_ id: String, _ data: Data) {
        if memoryBytes + data.count > memoryLimit {
            memory.removeAll()
            memoryBytes = 0
        }
        memory[id] = data
        memoryBytes += data.count
    }
}
