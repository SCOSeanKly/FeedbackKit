//
//  FeedbackForm.swift
//  FeedbackKit
//
//  The drop-in "Send Feedback" sheet. Uses only system fonts, colours and
//  controls so it inherits whatever the host app has set via `.tint`,
//  `.font` and the environment.
//
//  Present it as a sheet:
//
//      .sheet(isPresented: $showingFeedback) {
//          FeedbackForm(client: feedbackClient)
//      }
//
//  It wraps itself in a NavigationStack so the Cancel and Send toolbar
//  buttons work when presented modally, which is the normal case.
//

import PhotosUI
import SwiftUI

public struct FeedbackForm: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: FeedbackFormModel
    @State private var uploader: AttachmentUploader
    @FocusState private var focusedField: Field?

    private let onSubmitted: (@MainActor (SubmissionReceipt) -> Void)?

    private enum Field: Hashable {
        case title
        case body
    }

    /// - Parameters:
    ///   - client: The shared client for this app.
    ///   - diagnostics: Device facts offered for attachment, shown in full
    ///     in the consent text with an on-by-default toggle. Pass `nil` to
    ///     hide the option entirely.
    ///   - onSubmitted: Called after the server confirms, before the sheet
    ///     dismisses. Use it to thank the person or refresh a list.
    public init(
        client: FeedbackClient,
        diagnostics: FeedbackDiagnostics? = .current(),
        onSubmitted: (@MainActor (SubmissionReceipt) -> Void)? = nil
    ) {
        _model = State(initialValue: FeedbackFormModel(client: client, diagnostics: diagnostics))
        _uploader = State(initialValue: AttachmentUploader(client: client))
        self.onSubmitted = onSubmitted
    }

    public var body: some View {
        NavigationStack {
            Form {
                kindSection
                titleSection
                bodySection
                screenshotsSection
                diagnosticsSection
                errorSection
                consentSection
            }
            .navigationTitle(Text("Send Feedback", bundle: .module))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { toolbarContent }
            .disabled(model.isSending)
            .interactiveDismissDisabled(model.isSending)
            .task { await model.load() }
            .onChange(of: model.draft) { model.persistDraft() }
            .onChange(of: uploader.selection) {
                guard !uploader.selection.isEmpty else { return }
                Task { await uploader.ingestSelection() }
            }
            .alert(
                Text("Thank You", bundle: .module),
                isPresented: sentAlertBinding
            ) {
                Button {
                    dismiss()
                } label: {
                    Text("Done", bundle: .module)
                }
            } message: {
                Text("Your feedback has been sent. You can check on it under My Reports.", bundle: .module)
            }
        }
    }

    // MARK: Sections

    private var kindSection: some View {
        Section {
            Picker(selection: $model.draft.kind) {
                ForEach(FeedbackKind.allCases) { kind in
                    Text(kind.title).tag(kind)
                }
            } label: {
                Text("Type", bundle: .module)
            }
            .pickerStyle(.segmented)
        } footer: {
            Text(model.draft.kind.hint)
        }
    }

    private var titleSection: some View {
        Section {
            TextField(text: $model.draft.title, axis: .vertical) {
                Text("Summarise it in a sentence", bundle: .module)
            }
            .lineLimit(1...3)
            .focused($focusedField, equals: .title)
            .submitLabel(.next)
            .onSubmit { focusedField = .body }
        } header: {
            Text("Title", bundle: .module)
        } footer: {
            counter(model.draft.titleLength, limit: FeedbackLimits.titleLength)
        }
    }

    private var bodySection: some View {
        Section {
            TextEditor(text: $model.draft.body)
                .frame(minHeight: 160)
                .focused($focusedField, equals: .body)
        } header: {
            Text("Details", bundle: .module)
        } footer: {
            counter(model.draft.bodyLength, limit: FeedbackLimits.bodyLength)
        }
    }

    private var screenshotsSection: some View {
        Section {
            AttachmentStrip(uploader: uploader)
                .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            PhotosPicker(
                selection: $uploader.selection,
                maxSelectionCount: uploader.remainingSlots,
                matching: .images,
                photoLibrary: .shared()
            ) {
                Label {
                    Text("Add Screenshot", bundle: .module)
                } icon: {
                    Image(systemName: "photo.badge.plus")
                }
            }
            .disabled(!uploader.canAddMore)
        } header: {
            Text("Screenshots", bundle: .module)
        } footer: {
            Text("Up to \(AttachmentUploader.maximum) images. Only the developer can see them.", bundle: .module)
        }
    }

    @ViewBuilder
    private var diagnosticsSection: some View {
        if let diagnostics = model.diagnostics {
            Section {
                Toggle(isOn: $model.includeDiagnostics) {
                    Text("Include device details", bundle: .module)
                }
            } footer: {
                Text(diagnostics.summary)
            }
        }
    }

    @ViewBuilder
    private var errorSection: some View {
        if case .failed(let error) = model.phase {
            Section {
                Label {
                    Text(error.localizedDescription)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
                if error == .conflict {
                    Button {
                        model.startFresh()
                    } label: {
                        Text("Send as a New Report", bundle: .module)
                    }
                }
            }
        }
    }

    private var consentSection: some View {
        Section {
            EmptyView()
        } footer: {
            VStack(alignment: .leading, spacing: 14) {
                Text(
                    "Sending shares this report with the developer along with an anonymous identifier for this installation, used only to show you replies and status updates. Please don't include passwords or other sensitive personal details.",
                    bundle: .module
                )
                FeedbackBrandBadge()
            }
        }
    }

    private func counter(_ count: Int, limit: ClosedRange<Int>) -> some View {
        HStack {
            Spacer()
            Text("\(count) / \(limit.upperBound)")
                .monospacedDigit()
                .foregroundStyle(count > limit.upperBound ? .red : .secondary)
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(role: .cancel) {
                model.cancel()
                dismiss()
            } label: {
                Text("Cancel", bundle: .module)
            }
        }
        ToolbarItem(placement: .confirmationAction) {
            if model.isSending {
                ProgressView()
            } else {
                Button {
                    focusedField = nil
                    Task { await model.send(attachmentIDs: uploader.uploadedIDs, onSubmitted: onSubmitted) }
                } label: {
                    Text("Send", bundle: .module)
                }
                .disabled(!model.draft.isValid || uploader.isUploading)
            }
        }
    }

    private var sentAlertBinding: Binding<Bool> {
        Binding(
            get: {
                if case .sent = model.phase { return true }
                return false
            },
            set: { if !$0 { dismiss() } }
        )
    }
}

// MARK: - Model

@MainActor
@Observable
final class FeedbackFormModel {
    enum Phase: Equatable {
        case editing
        case sending
        case sent(SubmissionReceipt)
        case failed(FeedbackError)
    }

    var draft = FeedbackDraft()
    private(set) var phase: Phase = .editing
    /// Offered diagnostics, or nil when the host opted out of the feature.
    let diagnostics: FeedbackDiagnostics?
    var includeDiagnostics = true

    private let client: FeedbackClient
    private var hasLoaded = false

    init(client: FeedbackClient, diagnostics: FeedbackDiagnostics?) {
        self.client = client
        self.diagnostics = diagnostics
    }

    var isSending: Bool { phase == .sending }

    /// Restores an unsent draft (same requestID, so a retry stays idempotent)
    /// or starts a new one.
    func load() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        if let pending = try? await client.pendingDraft() {
            draft = pending
        } else {
            draft = FeedbackDraft()
            persistDraft()
        }
    }

    func persistDraft() {
        guard hasLoaded else { return }
        let snapshot = draft
        Task { try? await client.saveDraft(snapshot) }
    }

    func send(attachmentIDs: [String], onSubmitted: (@MainActor (SubmissionReceipt) -> Void)?) async {
        guard draft.isValid, !isSending else { return }
        phase = .sending
        draft.diagnostics = includeDiagnostics ? diagnostics : nil
        draft.attachmentIDs = attachmentIDs
        do {
            let receipt = try await client.submit(draft)
            phase = .sent(receipt)
            onSubmitted?(receipt)
        } catch let error as FeedbackError {
            phase = .failed(error)
        } catch {
            phase = .failed(.server(status: 0, message: error.localizedDescription))
        }
    }

    /// After a 409: keep the text, mint a fresh requestID.
    func startFresh() {
        draft.requestID = UUID()
        phase = .editing
        persistDraft()
    }

    /// Cancel discards the draft so the next form starts clean, unless a send
    /// was attempted and failed. In that case the server may already hold the
    /// report (a timed-out request can still have landed), so the draft and
    /// its requestID are kept and restored next time, keeping a retry
    /// idempotent.
    func cancel() {
        if case .failed = phase { return }
        Task { try? await client.discardDraft() }
    }
}
