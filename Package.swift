// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FeedbackKit",
    defaultLocalization: "en",
    // macOS is listed only so `swift test` runs on the Mac without a simulator;
    // the shipping target is iOS 17+.
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "FeedbackKit", targets: ["FeedbackKit"]),
    ],
    targets: [
        .target(
            name: "FeedbackKit",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "FeedbackKitTests",
            dependencies: ["FeedbackKit"]
        ),
    ]
)
