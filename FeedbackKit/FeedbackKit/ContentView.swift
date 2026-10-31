//
//  ContentView.swift
//  FeedbackKitExample
//
//  Shows every integration point: presenting the FeedbackForm as a sheet,
//  the in-app board with votes and follows, and the person's own reports
//  with private conversations.
//

import FeedbackKit
import SwiftUI

struct ContentView: View {
    let client: FeedbackClient

    var body: some View {
        TabView {
            SendTab(client: client)
                .tabItem { Label("Send", systemImage: "bubble.left.and.text.bubble.right") }

            NavigationStack {
                BoardView(client: client)
            }
            .tabItem { Label("Board", systemImage: "rectangle.3.group") }

            NavigationStack {
                MyReportsView(client: client)
            }
            .tabItem { Label("My Reports", systemImage: "tray") }
        }
    }
}

/// The simplest possible integration: a button that presents the form.
struct SendTab: View {
    let client: FeedbackClient

    @State private var showingFeedback = false
    @State private var lastReceipt: SubmissionReceipt?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        showingFeedback = true
                    } label: {
                        Label("Send Feedback", systemImage: "bubble.left.and.text.bubble.right")
                    }
                    if let lastReceipt {
                        LabeledContent("Last receipt", value: lastReceipt.id)
                            .font(.footnote)
                    }
                } footer: {
                    Text("Reports go to a private inbox. Reviewed items appear on the Board tab; replies show up under My Reports.")
                }
            }
            .navigationTitle("FeedbackKit")
            .sheet(isPresented: $showingFeedback) {
                FeedbackForm(client: client) { receipt in
                    lastReceipt = receipt
                }
            }
        }
    }
}
