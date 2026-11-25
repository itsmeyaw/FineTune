// FineTune/BrowserBridge/SupportedBrowser.swift
import Foundation

/// A Chromium-based browser that can host the Browser Extension.
enum SupportedBrowser: String, CaseIterable, Identifiable {
    case chrome, edge, brave, arc, vivaldi, chromium

    var id: String { rawValue }

    /// Browser name the extension reports in `hello`.
    init?(helloID: String) {
        self.init(rawValue: helloID)
    }

    /// The Browser's main app bundle ID, which is also its App Row's bundle ID.
    var bundleID: String {
        switch self {
        case .chrome: "com.google.Chrome"
        case .edge: "com.microsoft.edgemac"
        case .brave: "com.brave.Browser"
        case .arc: "company.thebrowser.Browser"
        case .vivaldi: "com.vivaldi.Vivaldi"
        case .chromium: "org.chromium.Chromium"
        }
    }

    init?(bundleID: String) {
        guard let browser = Self.allCases.first(where: { $0.bundleID == bundleID }) else { return nil }
        self = browser
    }

    var displayName: String {
        switch self {
        case .chrome: "Google Chrome"
        case .edge: "Microsoft Edge"
        case .brave: "Brave"
        case .arc: "Arc"
        case .vivaldi: "Vivaldi"
        case .chromium: "Chromium"
        }
    }

    /// Path under `~/Library/Application Support`, relative.
    private var userDataPath: String {
        switch self {
        case .chrome: "Google/Chrome"
        case .edge: "Microsoft Edge"
        case .brave: "BraveSoftware/Brave-Browser"
        case .arc: "Arc/User Data"
        case .vivaldi: "Vivaldi"
        case .chromium: "Chromium"
        }
    }

    func userDataDirectory(home: URL) -> URL {
        home.appendingPathComponent("Library/Application Support/\(userDataPath)", isDirectory: true)
    }

    func nativeMessagingHostsDirectory(home: URL) -> URL {
        userDataDirectory(home: home).appendingPathComponent("NativeMessagingHosts", isDirectory: true)
    }

    /// Browsers that have been run on this Mac (their user data directory exists).
    static func installed(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [SupportedBrowser] {
        allCases.filter { FileManager.default.fileExists(atPath: $0.userDataDirectory(home: home).path) }
    }
}
