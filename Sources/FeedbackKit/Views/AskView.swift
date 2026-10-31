//
//  AskView.swift
//  FeedbackKit
//
//  The in-app helper: a chat that answers "how do I do X?" from the app's own
//  knowledge. Not a general chatbot: the server only answers about the app,
//  and says so when it cannot find something.
//
//  Place it inside your own NavigationStack, like the other views:
//
//      NavigationStack {
//          AskView(client: feedbackClient,
//                  guideURL: { URL(string: "https://example.com/docs/\($0).html") },
//                  onContactSupport: { showFeedbackForm = true })
//      }
//
//  `guideURL` turns a guide slug into a page, so an answer can offer "Read the
//  guide". `onContactSupport` adds a "Still stuck? Send feedback" button under
//  answers; the host decides what that opens.
//

import SwiftUI

public struct AskView: View {
    @State private var model: AskModel
    @FocusState private var inputFocused: Bool

    private let guideURL: ((String) -> URL?)?
    private let onContactSupport: (() -> Void)?

    public init(
        client: FeedbackClient,
        guideURL: ((String) -> URL?)? = nil,
        onContactSupport: (() -> Void)? = nil
    ) {
        _model = State(initialValue: AskModel(client: client))
        self.guideURL = guideURL
        self.onContactSupport = onContactSupport
    }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(model.messages) { message in
                            AskMessageRow(
                                message: message,
                                guideURL: guideURL.flatMap { resolve in
                                    message.guide.flatMap { resolve($0) }
                                },
                                onRate: { helpful in model.rate(message.id, helpful: helpful) },
                                onRetry: { model.retry() },
                                onContactSupport: message.role == .assistant ? onContactSupport : nil
                            )
                            .id(message.id)
                        }
                        if model.isSending {
                            AskTypingIndicator().id("typing")
                        }
                    }
                    .padding()
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.messages.count) { scrollToEnd(proxy) }
                .onChange(of: model.isSending) { scrollToEnd(proxy) }
            }

            if model.showsSuggestions {
                AskSuggestions(suggestions: model.suggestions) { question in
                    model.send(question)
                }
            }

            AskInputBar(
                text: $model.draft,
                isSending: model.isSending,
                focused: $inputFocused,
                onSend: { model.send(model.draft) }
            )

            VStack(spacing: 4) {
                Text("AI helper. It can be wrong, and it never changes anything on your device.", bundle: .module)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                FeedbackBrandBadge()
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
        .navigationTitle(Text(verbatim: model.title))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.startOver()
                } label: {
                    Label {
                        Text("New Chat", bundle: .module)
                    } icon: {
                        Image(systemName: "square.and.pencil")
                    }
                }
                .disabled(model.messages.isEmpty)
            }
        }
        .task { await model.loadConfiguration() }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        withAnimation {
            if model.isSending {
                proxy.scrollTo("typing", anchor: .bottom)
            } else if let last = model.messages.last {
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
    }
}

// MARK: - Model

struct AskMessage: Identifiable, Equatable {
    enum Role { case user, assistant, error }
    let id = UUID()
    let role: Role
    let text: String
    var guide: String?
    var guideTitle: String?
    var logID: String?
    var rating: Bool?
}

@MainActor
@Observable
final class AskModel {
    let client: FeedbackClient
    var messages: [AskMessage] = []
    var draft = ""
    var isSending = false
    private(set) var title = "Ask"
    private(set) var suggestions: [String] = []
    private var lastQuestion: String?

    init(client: FeedbackClient) {
        self.client = client
    }

    var showsSuggestions: Bool { messages.isEmpty && !suggestions.isEmpty }

    func loadConfiguration() async {
        guard suggestions.isEmpty, let configuration = try? await client.askConfiguration() else { return }
        title = configuration.name
        suggestions = configuration.suggestions
    }

    func startOver() {
        messages = []
        lastQuestion = nil
    }

    func send(_ text: String) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !isSending else { return }
        draft = ""
        messages.append(AskMessage(role: .user, text: question))
        ask(question)
    }

    /// Asks the last question again after a failure, without repeating it on screen.
    func retry() {
        guard let question = lastQuestion, !isSending else { return }
        messages.removeAll { $0.role == .error }
        ask(question)
    }

    private func ask(_ question: String) {
        lastQuestion = question
        isSending = true
        // Everything before this question, without error rows.
        let history = messages.dropLast().compactMap { message -> AskTurn? in
            switch message.role {
            case .user: AskTurn(role: .user, content: message.text)
            case .assistant: AskTurn(role: .assistant, content: message.text)
            case .error: nil
            }
        }
        Task {
            do {
                let answer = try await client.ask(question, history: Array(history))
                var reply = AskMessage(role: .assistant, text: answer.answer)
                reply.guide = answer.guide
                reply.guideTitle = answer.guideTitle
                reply.logID = answer.logId
                messages.append(reply)
                lastQuestion = nil
            } catch {
                let text = (error as? LocalizedError)?.errorDescription
                    ?? String(localized: "The helper couldn't be reached. Please try again.", bundle: .module)
                messages.append(AskMessage(role: .error, text: text))
            }
            isSending = false
        }
    }

    func rate(_ id: UUID, helpful: Bool) {
        guard let index = messages.firstIndex(where: { $0.id == id }),
              messages[index].rating == nil, let logID = messages[index].logID else { return }
        messages[index].rating = helpful
        Task { try? await client.rateAskAnswer(logID: logID, helpful: helpful) }
    }
}

// MARK: - Pieces

private enum AskStyle {
    /// The grey of an assistant bubble and the input field.
    static var bubble: Color {
        #if canImport(UIKit)
        Color(.secondarySystemBackground)
        #else
        Color.secondary.opacity(0.15)
        #endif
    }
}

private struct AskMessageRow: View {
    let message: AskMessage
    let guideURL: URL?
    let onRate: (Bool) -> Void
    let onRetry: () -> Void
    let onContactSupport: (() -> Void)?

    var body: some View {
        switch message.role {
        case .user:
            Text(verbatim: message.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .foregroundStyle(.white)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 40)

        case .assistant:
            VStack(alignment: .leading, spacing: 8) {
                Text(Self.formatted(message.text))
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(AskStyle.bubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                HStack(spacing: 10) {
                    if let guideURL {
                        Link(destination: guideURL) {
                            Label {
                                if let title = message.guideTitle {
                                    Text(verbatim: title)
                                } else {
                                    Text("Read the guide", bundle: .module)
                                }
                            } icon: {
                                Image(systemName: "book")
                            }
                        }
                        .font(.footnote.weight(.semibold))
                    }
                    if let onContactSupport {
                        Button(action: onContactSupport) {
                            Text("Still stuck? Send feedback", bundle: .module)
                        }
                        .font(.footnote.weight(.semibold))
                    }
                    Spacer(minLength: 0)
                    if message.logID != nil {
                        ratingButtons
                    }
                }
                .padding(.horizontal, 4)
            }
            .padding(.trailing, 24)

        case .error:
            VStack(alignment: .leading, spacing: 8) {
                Label {
                    Text(verbatim: message.text)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                Button(action: onRetry) {
                    Text("Try Again", bundle: .module)
                }
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 4)
            }
            .padding(.trailing, 24)
        }
    }

    @ViewBuilder
    private var ratingButtons: some View {
        if let rating = message.rating {
            Image(systemName: rating ? "hand.thumbsup.fill" : "hand.thumbsdown.fill")
                .foregroundStyle(.secondary)
                .accessibilityLabel(Text(rating ? "Marked helpful" : "Marked not helpful", bundle: .module))
        } else {
            Button { onRate(true) } label: { Image(systemName: "hand.thumbsup") }
                .accessibilityLabel(Text("Helpful", bundle: .module))
            Button { onRate(false) } label: { Image(systemName: "hand.thumbsdown") }
                .accessibilityLabel(Text("Not helpful", bundle: .module))
        }
    }

    /// The helper writes **bold** and numbered lines; keep the line breaks and render the bold.
    static func formatted(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

private struct AskTypingIndicator: View {
    var body: some View {
        ProgressView()
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(AskStyle.bubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .accessibilityLabel(Text("Thinking", bundle: .module))
    }
}

private struct AskSuggestions: View {
    let suggestions: [String]
    let onPick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { suggestion in
                    Button { onPick(suggestion) } label: {
                        Text(verbatim: suggestion)
                            .font(.footnote)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(AskStyle.bubble, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
    }
}

private struct AskInputBar: View {
    @Binding var text: String
    let isSending: Bool
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(text: $text, axis: .vertical) {
                Text("How do I…?", bundle: .module)
            }
            .lineLimit(1...4)
            .focused(focused)
            #if os(iOS)
            .submitLabel(.send)
            #endif
            .onSubmit(onSend)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(AskStyle.bubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
            }
            .disabled(isSending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel(Text("Send", bundle: .module))
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }
}

#Preview("Ask") {
    NavigationStack {
        AskView(client: FeedbackClient(configuration: FeedbackConfiguration(
            baseURL: URL(string: "https://feedback.example.com")!,
            appID: "demo"
        )))
    }
}
