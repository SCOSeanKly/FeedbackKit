//
//  Attachments.swift
//  FeedbackKit
//
//  Picking, uploading and showing images. Shared by the conversation
//  composer and the report form.
//

import PhotosUI
import SwiftUI

#if canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
#elseif canImport(AppKit)
import AppKit
typealias PlatformImage = NSImage
#endif

extension Image {
    /// A SwiftUI image from raw bytes, or nil if they don't decode.
    init?(platformData data: Data) {
        guard let image = PlatformImage(data: data) else { return nil }
        #if canImport(UIKit)
        self.init(uiImage: image)
        #else
        self.init(nsImage: image)
        #endif
    }
}

// MARK: - Uploader

/// One picked image on its way to the server.
struct PendingAttachment: Identifiable {
    let id = UUID()
    let preview: PreparedImage
    var attachment: Attachment?
    var failure: String?

    var isUploading: Bool { attachment == nil && failure == nil }
}

/// Prepares picked photos and uploads them straight away, so sending the
/// message or report only has to pass ids. Keeps at most four.
@MainActor
@Observable
final class AttachmentUploader {
    static let maximum = 4

    let client: FeedbackClient
    private(set) var items: [PendingAttachment] = []
    var selection: [PhotosPickerItem] = []

    init(client: FeedbackClient) {
        self.client = client
    }

    var uploadedIDs: [String] { items.compactMap(\.attachment?.id) }
    var isUploading: Bool { items.contains(where: \.isUploading) }
    var canAddMore: Bool { items.count < Self.maximum }
    var remainingSlots: Int { max(0, Self.maximum - items.count) }

    /// Called when the picker selection changes; ingests new picks and clears the picker.
    func ingestSelection() async {
        let picks = selection
        selection = []
        for pick in picks where canAddMore {
            guard let data = try? await pick.loadTransferable(type: Data.self) else { continue }
            await add(data)
        }
    }

    /// Prepares and uploads one image.
    func add(_ data: Data) async {
        guard canAddMore else { return }
        let prepared = await Task.detached(priority: .userInitiated) {
            FeedbackImagePreparer.prepare(data)
        }.value
        guard let prepared else { return }

        var pending = PendingAttachment(preview: prepared)
        items.append(pending)
        let index = items.count - 1
        do {
            pending.attachment = try await client.uploadAttachment(prepared)
        } catch {
            pending.failure = (error as? FeedbackError)?.localizedDescription ?? error.localizedDescription
        }
        if index < items.count, items[index].id == pending.id {
            items[index] = pending
        }
    }

    func remove(_ item: PendingAttachment) {
        items.removeAll { $0.id == item.id }
    }

    func removeAll() {
        items.removeAll()
    }

    func retry(_ item: PendingAttachment) async {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[index].failure = nil
        do {
            items[index].attachment = try await client.uploadAttachment(item.preview)
        } catch {
            items[index].failure = (error as? FeedbackError)?.localizedDescription ?? error.localizedDescription
        }
    }
}

// MARK: - Strip of pending thumbnails

struct AttachmentStrip: View {
    @Bindable var uploader: AttachmentUploader
    var thumbnailSize: CGFloat = 72

    var body: some View {
        if !uploader.items.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(uploader.items) { item in
                        ZStack(alignment: .topTrailing) {
                            if let image = Image(platformData: item.preview.data) {
                                image
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: thumbnailSize, height: thumbnailSize)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .opacity(item.isUploading ? 0.5 : 1)
                            }
                            if item.isUploading {
                                ProgressView()
                                    .frame(width: thumbnailSize, height: thumbnailSize)
                            } else if item.failure != nil {
                                Button {
                                    Task { await uploader.retry(item) }
                                } label: {
                                    Image(systemName: "arrow.clockwise.circle.fill")
                                        .font(.title2)
                                        .foregroundStyle(.white, .red)
                                }
                                .buttonStyle(.plain)
                                .frame(width: thumbnailSize, height: thumbnailSize)
                                .accessibilityLabel(Text("Retry upload", bundle: .module))
                            }
                            Button {
                                uploader.remove(item)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.title3)
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .gray)
                            }
                            .buttonStyle(.plain)
                            .offset(x: 6, y: -6)
                            .accessibilityLabel(Text("Remove image", bundle: .module))
                        }
                        .padding(.top, 6)
                        .padding(.trailing, 6)
                    }
                }
                .padding(.horizontal, 4)
            }
            .scrollIndicators(.hidden)
        }
    }
}

// MARK: - Showing an attachment

/// Loads an attachment's bytes through the client (cached) and shows it,
/// reserving space at the right aspect ratio while it loads.
struct AttachmentThumbnail: View {
    let client: FeedbackClient
    let attachment: Attachment
    var maxWidth: CGFloat = 240

    @State private var data: Data?
    @State private var failed = false

    var body: some View {
        let width = min(maxWidth, max(120, CGFloat(attachment.width > 0 ? attachment.width : 240) / 3))
        let height = width / attachment.aspectRatio
        ZStack {
            if let data, let image = Image(platformData: data) {
                image
                    .resizable()
                    .scaledToFill()
            } else if failed {
                Image(systemName: "photo")
                    .font(.title)
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .frame(width: width, height: min(height, 360))
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .task(id: attachment.id) {
            do {
                data = try await client.attachmentData(id: attachment.id)
            } catch {
                failed = true
            }
        }
        .accessibilityLabel(Text("Image attachment", bundle: .module))
    }
}

/// Full-screen zoomable viewer, dismissed with a Done button or a drag down.
struct AttachmentViewer: View {
    let client: FeedbackClient
    let attachment: Attachment
    @Environment(\.dismiss) private var dismiss

    @State private var data: Data?
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var dragOffset: CGSize = .zero

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let data, let image = Image(platformData: data) {
                    image
                        .resizable()
                        .scaledToFit()
                        .scaleEffect(scale)
                        .offset(dragOffset)
                        .gesture(
                            MagnifyGesture()
                                .onChanged { value in scale = max(1, min(5, lastScale * value.magnification)) }
                                .onEnded { _ in lastScale = scale }
                        )
                        .simultaneousGesture(
                            DragGesture()
                                .onChanged { value in
                                    if scale <= 1 { dragOffset = value.translation }
                                }
                                .onEnded { value in
                                    if scale <= 1, abs(value.translation.height) > 120 {
                                        dismiss()
                                    } else {
                                        withAnimation(.snappy) { dragOffset = .zero }
                                    }
                                }
                        )
                        .onTapGesture(count: 2) {
                            withAnimation(.snappy) {
                                scale = scale > 1 ? 1 : 2.5
                                lastScale = scale
                            }
                        }
                } else {
                    ProgressView().tint(.white)
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Text("Done", bundle: .module)
                    }
                    .foregroundStyle(.white)
                }
            }
            #if os(iOS)
            .toolbarBackground(.black, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
            .task { data = try? await client.attachmentData(id: attachment.id) }
        }
    }
}

/// Presents `AttachmentViewer` full screen on iOS and as a sheet elsewhere.
struct AttachmentViewerPresenter: ViewModifier {
    let client: FeedbackClient
    @Binding var attachment: Attachment?

    func body(content: Content) -> some View {
        #if os(iOS)
        content.fullScreenCover(item: $attachment) { attachment in
            AttachmentViewer(client: client, attachment: attachment)
        }
        #else
        content.sheet(item: $attachment) { attachment in
            AttachmentViewer(client: client, attachment: attachment)
                .frame(minWidth: 600, minHeight: 500)
        }
        #endif
    }
}

extension View {
    func attachmentViewer(client: FeedbackClient, attachment: Binding<Attachment?>) -> some View {
        modifier(AttachmentViewerPresenter(client: client, attachment: attachment))
    }
}
