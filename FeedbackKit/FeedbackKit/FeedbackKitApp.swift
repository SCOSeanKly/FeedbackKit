//
//  FeedbackKitApp.swift
//  FeedbackKitExample
//
//  Minimal host app. One FeedbackClient lives for the app's lifetime and is
//  handed to any view that needs it.
//

import FeedbackKit
import SwiftUI

@main
struct FeedbackKitExampleApp: App {
    /// Point `baseURL` at `wrangler dev` while developing, or at your deployed
    /// Worker. `appID` must match a row in the `apps` table.
    private let client = FeedbackClient(
        configuration: FeedbackConfiguration(
            baseURL: URL(string: "http://localhost:8787")!,
            appID: "example"
        )
    )

    var body: some Scene {
        WindowGroup {
            ContentView(client: client)
        }
    }
}
