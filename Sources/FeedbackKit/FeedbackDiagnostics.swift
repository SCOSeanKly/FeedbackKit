//
//  FeedbackDiagnostics.swift
//  FeedbackKit
//
//  A small, deliberately boring set of facts about the app and device that
//  helps reproduce a report. No identifiers, no location, no contacts.
//  The form shows exactly what will be sent and lets the person opt out.
//

import Foundation

public struct FeedbackDiagnostics: Codable, Sendable, Equatable {
    public var appVersion: String
    public var build: String
    public var platform: String
    public var osVersion: String
    public var deviceModel: String
    public var locale: String
    public var timeZone: String
    /// Host-supplied extras, e.g. a feature flag or the screen the person was on.
    /// Keep these free of personal data; they are shown in the consent text.
    public var extras: [String: String]

    public init(
        appVersion: String,
        build: String,
        platform: String,
        osVersion: String,
        deviceModel: String,
        locale: String,
        timeZone: String,
        extras: [String: String] = [:]
    ) {
        self.appVersion = appVersion
        self.build = build
        self.platform = platform
        self.osVersion = osVersion
        self.deviceModel = deviceModel
        self.locale = locale
        self.timeZone = timeZone
        self.extras = extras
    }

    /// Facts about the running app and device.
    public static func current(extras: [String: String] = [:]) -> FeedbackDiagnostics {
        let bundle = Bundle.main
        let os = ProcessInfo.processInfo.operatingSystemVersion
        #if os(iOS)
        let platform = "iOS"
        #elseif os(macOS)
        let platform = "macOS"
        #else
        let platform = "Apple"
        #endif
        return FeedbackDiagnostics(
            appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
            build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            platform: platform,
            osVersion: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            deviceModel: machineIdentifier(),
            locale: Locale.current.identifier,
            timeZone: TimeZone.current.identifier,
            extras: extras
        )
    }

    /// One line for the consent footer, e.g. "App 1.2 (34) · iOS 27.0.1 · iPhone17,1 · en_GB".
    public var summary: String {
        var parts = ["App \(appVersion) (\(build))", "\(platform) \(osVersion)", deviceModel, locale]
        if !extras.isEmpty {
            parts.append(extras.keys.sorted().joined(separator: ", "))
        }
        return parts.joined(separator: " · ")
    }

    private static func machineIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        return withUnsafeBytes(of: &systemInfo.machine) { buffer in
            String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}
