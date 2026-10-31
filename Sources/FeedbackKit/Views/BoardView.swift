//
//  BoardView.swift
//  FeedbackKit
//
//  The public board inside the app: reviewed issues with their status, and
//  vote / follow toggles for this installation. Place it inside your own
//  NavigationStack; it pushes a detail view.
//

import SwiftUI

public struct BoardView: View {
    @State private var model: BoardModel

    public init(client: FeedbackClient) {
        _model = State(initialValue: BoardModel(client: client))
    }

    public var body: some View {
        List {
            ForEach(model.issues) { issue in
                // Closure-based link; see MyReportsView for why not a value link.
                NavigationLink {
                    BoardIssueDetail(model: model, issueID: issue.id)
                } label: {
                    BoardIssueRow(issue: issue) {
                        Task { await model.toggleVote(issue) }
                    }
                }
            }
            if model.hasMore {
                Button {
                    Task { await model.loadMore() }
                } label: {
                    if model.isLoadingMore {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("Load More", bundle: .module).frame(maxWidth: .infinity)
                    }
                }
            }
            Section {
                EmptyView()
            } footer: {
                FeedbackBrandBadge()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
        }
        .navigationTitle(Text("Feedback Board", bundle: .module))
        .searchable(text: $model.query, prompt: Text("Search", bundle: .module))
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Menu {
                    Picker(selection: $model.sort) {
                        ForEach(BoardSort.allCases) { sort in
                            Text(sort.title).tag(sort)
                        }
                    } label: {
                        Text("Sort", bundle: .module)
                    }
                    Picker(selection: $model.status) {
                        Text("All Statuses", bundle: .module).tag(IssueStatus?.none)
                        ForEach(IssueStatus.allCases) { status in
                            Text(status.title).tag(IssueStatus?.some(status))
                        }
                    } label: {
                        Text("Status", bundle: .module)
                    }
                } label: {
                    Label {
                        Text("Filter", bundle: .module)
                    } icon: {
                        Image(systemName: model.status == nil && model.sort == .recent
                            ? "line.3.horizontal.decrease.circle"
                            : "line.3.horizontal.decrease.circle.fill")
                    }
                }
            }
        }
        .overlay {
            if model.issues.isEmpty {
                if model.isLoading {
                    ProgressView()
                } else if let error = model.error {
                    ContentUnavailableView {
                        Label {
                            Text("Couldn't Load the Board", bundle: .module)
                        } icon: {
                            Image(systemName: "exclamationmark.triangle")
                        }
                    } description: {
                        Text(error.localizedDescription)
                    } actions: {
                        Button {
                            Task { await model.reload() }
                        } label: {
                            Text("Try Again", bundle: .module)
                        }
                    }
                } else if model.hasLoaded {
                    ContentUnavailableView {
                        Label {
                            Text("Nothing Here Yet", bundle: .module)
                        } icon: {
                            Image(systemName: "rectangle.3.group")
                        }
                    } description: {
                        Text("Reviewed issues and ideas will appear here.", bundle: .module)
                    }
                }
            }
        }
        .refreshable { await model.reload() }
        .task(id: model.filterKey) { await model.reload(debounce: model.hasLoaded) }
        .alert(
            Text("Something Went Wrong", bundle: .module),
            isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
        ) {
            Button {
                model.actionError = nil
            } label: {
                Text("OK", bundle: .module)
            }
        } message: {
            Text(model.actionError?.localizedDescription ?? "")
        }
    }
}

// MARK: - Row

struct BoardIssueRow: View {
    let issue: BoardIssue
    let onVote: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: onVote) {
                VStack(spacing: 2) {
                    Image(systemName: issue.voted ? "arrowtriangle.up.fill" : "arrowtriangle.up")
                    Text("\(issue.votes)")
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                }
                .frame(width: 36)
                .padding(.vertical, 4)
                .foregroundStyle(issue.voted ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(issue.voted ? Text("Remove vote", bundle: .module) : Text("Vote", bundle: .module))
            .accessibilityValue(Text("\(issue.votes) votes", bundle: .module))

            VStack(alignment: .leading, spacing: 4) {
                Text(issue.title)
                    .font(.headline)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text("#\(issue.number)").monospacedDigit()
                    Text("·")
                    Label(issue.status.title, systemImage: issue.status.systemImage)
                    if let release = issue.release {
                        Text("·")
                        Text(release)
                    }
                    if issue.following {
                        Text("·")
                        Image(systemName: "bell.fill")
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Detail

struct BoardIssueDetail: View {
    @Bindable var model: BoardModel
    let issueID: String

    private var issue: BoardIssue? { model.issues.first { $0.id == issueID } }

    var body: some View {
        if let issue {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 8) {
                        Text("#\(issue.number)").monospacedDigit()
                        Label(issue.status.title, systemImage: issue.status.systemImage)
                        if let release = issue.release { Text(release) }
                        if let lane = issue.roadmapLane {
                            Text("·")
                            Text("Roadmap: \(lane.title)", bundle: .module)
                        }
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                    Text(issue.title)
                        .font(.title2.weight(.semibold))

                    if !issue.body.isEmpty {
                        Text(issue.body)
                    } else {
                        Text("No further details.", bundle: .module)
                            .foregroundStyle(.secondary)
                    }

                    HStack(spacing: 12) {
                        Button {
                            Task { await model.toggleVote(issue) }
                        } label: {
                            Label {
                                if issue.voted {
                                    Text("Voted · \(issue.votes)", bundle: .module)
                                } else {
                                    Text("Vote · \(issue.votes)", bundle: .module)
                                }
                            } icon: {
                                Image(systemName: issue.voted ? "arrowtriangle.up.fill" : "arrowtriangle.up")
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(issue.voted ? Color.accentColor : Color.secondary)

                        Button {
                            Task { await model.toggleFollow(issue) }
                        } label: {
                            Label {
                                if issue.following {
                                    Text("Following", bundle: .module)
                                } else {
                                    Text("Follow", bundle: .module)
                                }
                            } icon: {
                                Image(systemName: issue.following ? "bell.fill" : "bell")
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(issue.following ? Color.accentColor : Color.secondary)
                    }
                    .padding(.top, 4)

                    Text("Updated \(issue.updatedAt, format: .relative(presentation: .named)) · \(issue.follows) following", bundle: .module)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(Text("#\(issue.number)"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        } else {
            ContentUnavailableView {
                Text("This item is no longer available.", bundle: .module)
            }
        }
    }
}

// MARK: - Model

@MainActor
@Observable
final class BoardModel {
    let client: FeedbackClient

    private(set) var issues: [BoardIssue] = []
    private(set) var hasMore = false
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var hasLoaded = false
    private(set) var error: FeedbackError?
    var actionError: FeedbackError?

    var query = ""
    var status: IssueStatus?
    var sort: BoardSort = .recent

    /// Changes whenever a reload is needed; drives `.task(id:)`.
    var filterKey: String { "\(query)|\(status?.rawValue ?? "")|\(sort.rawValue)" }

    init(client: FeedbackClient) {
        self.client = client
    }

    func reload(debounce: Bool = false) async {
        if debounce {
            // Typing in the search field triggers this per keystroke; wait a beat.
            try? await Task.sleep(for: .milliseconds(300))
            if Task.isCancelled { return }
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await client.board(status: status, query: query, sort: sort)
            if Task.isCancelled { return }
            issues = page.issues
            hasMore = page.hasMore
            error = nil
        } catch is CancellationError {
            return
        } catch let failure as FeedbackError {
            error = failure
        } catch {
            self.error = .server(status: 0, message: error.localizedDescription)
        }
        hasLoaded = true
    }

    func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await client.board(status: status, query: query, sort: sort, offset: issues.count)
            issues.append(contentsOf: page.issues.filter { new in !issues.contains { $0.id == new.id } })
            hasMore = page.hasMore
        } catch let failure as FeedbackError {
            actionError = failure
        } catch {
            actionError = .server(status: 0, message: error.localizedDescription)
        }
    }

    func toggleVote(_ issue: BoardIssue) async {
        await toggle(issue, keyPath: \.voted, countPath: \.votes) { client, on in
            try await client.vote(issueNumber: issue.number, on: on)
        }
    }

    func toggleFollow(_ issue: BoardIssue) async {
        await toggle(issue, keyPath: \.following, countPath: \.follows) { client, on in
            try await client.follow(issueNumber: issue.number, on: on)
        }
    }

    /// Optimistic toggle: flip locally, call the server, then adopt its counts
    /// (or roll back on failure).
    private func toggle(
        _ issue: BoardIssue,
        keyPath: WritableKeyPath<BoardIssue, Bool>,
        countPath: WritableKeyPath<BoardIssue, Int>,
        perform: (FeedbackClient, Bool) async throws -> Engagement
    ) async {
        guard let index = issues.firstIndex(where: { $0.id == issue.id }) else { return }
        let original = issues[index]
        let newValue = !original[keyPath: keyPath]
        issues[index][keyPath: keyPath] = newValue
        issues[index][keyPath: countPath] = max(0, original[keyPath: countPath] + (newValue ? 1 : -1))

        do {
            let result = try await perform(client, newValue)
            if let current = issues.firstIndex(where: { $0.id == issue.id }) {
                issues[current].votes = result.votes
                issues[current].voted = result.voted
                issues[current].follows = result.follows
                issues[current].following = result.following
            }
        } catch {
            if let current = issues.firstIndex(where: { $0.id == issue.id }) {
                issues[current] = original
            }
            actionError = (error as? FeedbackError) ?? .server(status: 0, message: error.localizedDescription)
        }
    }
}
