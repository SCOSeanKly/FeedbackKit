//
//  ConversationView.swift
//  FeedbackKit
//
//  The private thread between the person who sent a report and the
//  developer, laid out the way Messages does it: tailed bubbles grouped by
//  sender, time separators instead of a caption under every message, images
//  inline with a full-screen viewer, and a capsule composer with the send
//  button inside it.
//
//  Opening the thread marks the developer's messages as read. Sending keeps
//  one requestID per attempt until it succeeds, so a retry after a dropped
//  connection never duplicates the message.
//

import PhotosUI
import SwiftUI

public struct ConversationView: View {
    @State private var model: ConversationModel
    @State private var uploader: AttachmentUploader
    @State private var viewing: Attachment?
    @FocusState private var composerFocused: Bool

    public init(client: FeedbackClient, submission: Submission) {
        _model = State(initialValue: ConversationModel(client: client, submission: submission))
        _uploader = State(initialValue: AttachmentUploader(client: client))
    }

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    reportCard
                        .padding(.bottom, 12)

                    if model.messages.isEmpty, model.hasLoaded, model.error == nil {
                        Text("No replies yet. You'll see the developer's response here, and you can add more detail below.", bundle: .module)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                            .padding(.vertical, 8)
                    }

                    ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                        let previous = index > 0 ? model.messages[index - 1] : nil
                        let next = index + 1 < model.messages.count ? model.messages[index + 1] : nil
                        if ConversationModel.needsTimestamp(before: message, previous: previous) {
                            TimestampSeparator(date: message.createdAt)
                        }
                        MessageBubble(
                            message: message,
                            client: model.client,
                            hasTail: next?.sender != message.sender,
                            onTapAttachment: { viewing = $0 }
                        )
                        .id(message.id)
                        .padding(.bottom, next?.sender == message.sender ? 0 : 8)
                    }

                    if let error = model.error {
                        Label(error.localizedDescription, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 8)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages.count) {
                if let last = model.messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(Text(model.submission.title))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .attachmentViewer(client: model.client, attachment: $viewing)
        .task { await model.load() }
        .onChange(of: uploader.selection) {
            guard !uploader.selection.isEmpty else { return }
            Task { await uploader.ingestSelection() }
        }
    }

    // MARK: Pieces

    private var reportCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Label(model.submission.kind.title, systemImage: model.submission.kind.systemImage)
                Text("·")
                if let issue = model.submission.issue {
                    Text("#\(issue.number) · \(issue.status.title)")
                } else {
                    Text(model.submission.state.title)
                }
                Spacer()
                Text(model.submission.createdAt, format: .dateTime.day().month().year())
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Text(model.submission.body)
                .font(.callout)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var composer: some View {
        VStack(spacing: 6) {
            AttachmentStrip(uploader: uploader, thumbnailSize: 64)
                .padding(.horizontal, 12)

            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(
                    selection: $uploader.selection,
                    maxSelectionCount: uploader.remainingSlots,
                    matching: .images,
                    photoLibrary: .shared()
                ) {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .frame(width: 34, height: 34)
                        .background(.fill.secondary, in: Circle())
                        .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .disabled(!uploader.canAddMore || model.isSending)
                .accessibilityLabel(Text("Add photo", bundle: .module))

                HStack(alignment: .bottom, spacing: 4) {
                    TextField(text: $model.draft, axis: .vertical) {
                        Text("Message", bundle: .module)
                    }
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($composerFocused)
                    .disabled(model.isSending)
                    .padding(.leading, 12)
                    .padding(.vertical, 7)

                    Button {
                        Task {
                            await model.send(attachmentIDs: uploader.uploadedIDs)
                            if model.error == nil { uploader.removeAll() }
                        }
                    } label: {
                        Group {
                            if model.isSending {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.body.weight(.bold))
                                    .foregroundStyle(.white)
                            }
                        }
                        .frame(width: 28, height: 28)
                        .background(canSend ? AnyShapeStyle(.tint) : AnyShapeStyle(.fill.tertiary), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .padding(3)
                    .accessibilityLabel(Text("Send", bundle: .module))
                }
                .background(.background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(.quaternary, lineWidth: 1)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .padding(.top, uploader.items.isEmpty ? 6 : 0)
        }
        .background(.bar)
    }

    private var canSend: Bool {
        !model.isSending && !uploader.isUploading
            && (!model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !uploader.uploadedIDs.isEmpty)
    }
}

// MARK: - Separator

struct TimestampSeparator: View {
    let date: Date

    var body: some View {
        Text(date, format: Self.format(for: date))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .accessibilityAddTraits(.isHeader)
    }

    /// "Today 14:32" style granularity: time only for today, weekday within
    /// the week, full date beyond that.
    static func format(for date: Date) -> Date.FormatStyle {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return .dateTime.hour().minute()
        }
        if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
            return .dateTime.weekday(.wide).hour().minute()
        }
        return .dateTime.day().month().hour().minute()
    }
}

// MARK: - Bubble

struct MessageBubble: View {
    let message: Message
    let client: FeedbackClient
    let hasTail: Bool
    let onTapAttachment: (Attachment) -> Void

    private var isMine: Bool { message.sender == .user }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if isMine { Spacer(minLength: 56) }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 3) {
                ForEach(message.attachments) { attachment in
                    Button {
                        onTapAttachment(attachment)
                    } label: {
                        AttachmentThumbnail(client: client, attachment: attachment)
                    }
                    .buttonStyle(.plain)
                }
                if !message.body.isEmpty {
                    Text(message.body)
                        .font(.body)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .foregroundStyle(isMine ? .white : .primary)
                        .background(bubbleFill, in: BubbleShape(isMine: isMine, hasTail: hasTail))
                        .textSelection(.enabled)
                }
            }
            if !isMine { Spacer(minLength: 56) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var bubbleFill: AnyShapeStyle {
        if isMine { return AnyShapeStyle(.tint) }
        #if canImport(UIKit)
        return AnyShapeStyle(Color(uiColor: .systemGray5))
        #else
        return AnyShapeStyle(.quaternary)
        #endif
    }

    private var accessibilityText: Text {
        let who = isMine ? Text("You", bundle: .module) : Text("Developer", bundle: .module)
        return who + Text(": ") + Text(message.body) + Text(message.createdAt, format: .relative(presentation: .named))
    }
}

/// A Messages-style bubble: continuous corners with a small tail at the
/// bottom corner on the speaker's side, only on the last bubble of a run.
struct BubbleShape: Shape {
    var isMine: Bool
    var hasTail: Bool
    var radius: CGFloat = 18

    func path(in rect: CGRect) -> Path {
        let r = min(radius, min(rect.width, rect.height) / 2)
        let body = Path(roundedRect: rect, cornerRadius: r, style: .continuous)
        guard hasTail else { return body }

        // The tail fills in the bottom corner on the speaker's side and
        // pokes a few points past the edge, with a concave curl back up to
        // the side. Combined with a true union so overlapping the rounded
        // corner never punches a hole.
        var tail = Path()
        let y = rect.maxY
        if isMine {
            let x = rect.maxX
            tail.move(to: CGPoint(x: x - r, y: y))
            tail.addLine(to: CGPoint(x: x + 5, y: y))
            tail.addQuadCurve(to: CGPoint(x: x, y: y - r), control: CGPoint(x: x - 2, y: y - 3))
            tail.closeSubpath()
        } else {
            let x = rect.minX
            tail.move(to: CGPoint(x: x + r, y: y))
            tail.addLine(to: CGPoint(x: x - 5, y: y))
            tail.addQuadCurve(to: CGPoint(x: x, y: y - r), control: CGPoint(x: x + 2, y: y - 3))
            tail.closeSubpath()
        }
        return body.union(tail)
    }
}

// MARK: - Model

@MainActor
@Observable
final class ConversationModel {
    let client: FeedbackClient
    let submission: Submission

    private(set) var messages: [Message] = []
    private(set) var hasLoaded = false
    private(set) var isSending = false
    private(set) var error: FeedbackError?
    var draft = ""

    /// Stays the same across retries of one send; rotated only on success.
    private var pendingRequestID = UUID()

    init(client: FeedbackClient, submission: Submission) {
        self.client = client
        self.submission = submission
    }

    /// A separator goes above the first message and whenever more than an
    /// hour passed since the previous one, like Messages.
    static func needsTimestamp(before message: Message, previous: Message?) -> Bool {
        guard let previous else { return true }
        return message.createdAt.timeIntervalSince(previous.createdAt) > 60 * 60
    }

    func load() async {
        guard !hasLoaded else { return }
        do {
            var all: [Message] = []
            var after = 0
            repeat {
                let page = try await client.conversation(submissionID: submission.id, after: after)
                all.append(contentsOf: page.messages)
                after = page.nextAfter
                if !page.hasMore { break }
            } while true
            messages = all
            error = nil
            hasLoaded = true
            if let last = all.last {
                _ = try? await client.markConversationRead(submissionID: submission.id, through: last.seq)
            }
        } catch let failure as FeedbackError {
            error = failure
            hasLoaded = true
        } catch {
            self.error = .server(status: 0, message: error.localizedDescription)
            hasLoaded = true
        }
    }

    func send(attachmentIDs: [String]) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isSending, !text.isEmpty || !attachmentIDs.isEmpty else { return }
        isSending = true
        defer { isSending = false }
        do {
            let message = try await client.reply(
                submissionID: submission.id,
                requestID: pendingRequestID,
                message: text,
                attachmentIDs: attachmentIDs
            )
            if !messages.contains(where: { $0.id == message.id }) {
                messages.append(message)
            }
            draft = ""
            pendingRequestID = UUID()
            error = nil
        } catch let failure as FeedbackError {
            if failure == .conflict {
                // An earlier attempt did land with different text. Start a fresh id.
                pendingRequestID = UUID()
            }
            error = failure
        } catch {
            self.error = .server(status: 0, message: error.localizedDescription)
        }
    }
}
