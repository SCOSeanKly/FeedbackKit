//
//  MyReportsView.swift
//  FeedbackKit
//
//  Everything this installation has sent, with the status of the public
//  issue it became and an unread badge when the developer has replied.
//  Tapping a report opens its private conversation.
//
//  Place it inside your own NavigationStack (it pushes ConversationView):
//
//      NavigationStack { MyReportsView(client: feedbackClient) }
//

import SwiftUI

public struct MyReportsView: View {
    @State private var model: MyReportsModel

    public init(client: FeedbackClient) {
        _model = State(initialValue: MyReportsModel(client: client))
    }

    public var body: some View {
        List {
            ForEach(model.reports) { report in
                // Closure-based link on purpose: a value link needs a
                // `navigationDestination` registered on the stack, and when
                // this view is itself pushed from a host screen SwiftUI can
                // resolve that lookup to the wrong view and re-push this list.
                NavigationLink {
                    ConversationView(client: model.client, submission: report)
                } label: {
                    ReportRow(report: report)
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
        }
        .navigationTitle(Text("My Reports", bundle: .module))
        .overlay {
            if model.reports.isEmpty {
                if model.isLoading {
                    ProgressView()
                } else if let error = model.error {
                    ContentUnavailableView {
                        Label {
                            Text("Couldn't Load Reports", bundle: .module)
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
                            Text("No Reports Yet", bundle: .module)
                        } icon: {
                            Image(systemName: "tray")
                        }
                    } description: {
                        Text("Reports you send will appear here, along with any replies.", bundle: .module)
                    }
                }
            }
        }
        .refreshable { await model.reload() }
        .task { await model.loadIfNeeded() }
    }
}

// MARK: - Row

struct ReportRow: View {
    let report: Submission

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: report.kind.systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 22)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(report.title)
                    .font(.headline)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if let issue = report.issue {
                        Text("#\(issue.number)")
                            .monospacedDigit()
                        Text("·")
                        Text(issue.status.title)
                    } else {
                        Text(report.state.title)
                    }
                    Text("·")
                    Text(report.createdAt, format: .relative(presentation: .named))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
            if report.unreadCount > 0 {
                Text("\(report.unreadCount)")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(.tint, in: Capsule())
                    .foregroundStyle(.white)
                    .accessibilityLabel(Text("\(report.unreadCount) unread replies", bundle: .module))
            } else if report.messageCount > 0 {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Model

@MainActor
@Observable
final class MyReportsModel {
    let client: FeedbackClient

    private(set) var reports: [Submission] = []
    private(set) var hasMore = false
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var hasLoaded = false
    private(set) var error: FeedbackError?

    init(client: FeedbackClient) {
        self.client = client
    }

    func loadIfNeeded() async {
        guard !hasLoaded, !isLoading else { return }
        await reload()
    }

    func reload() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await client.myReports()
            reports = page.submissions
            hasMore = page.hasMore
            error = nil
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
            let page = try await client.myReports(offset: reports.count)
            reports.append(contentsOf: page.submissions.filter { new in !reports.contains { $0.id == new.id } })
            hasMore = page.hasMore
        } catch let failure as FeedbackError {
            error = failure
        } catch {
            self.error = .server(status: 0, message: error.localizedDescription)
        }
    }
}
