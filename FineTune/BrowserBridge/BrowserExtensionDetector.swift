// FineTune/BrowserBridge/BrowserExtensionDetector.swift
import Foundation

/// Looks inside a Browser's profiles for the Browser Extension, whether or not it is currently running.
struct BrowserExtensionDetector {
    var home: URL = FileManager.default.homeDirectoryForCurrentUser

    func isExtensionInstalled(in browser: SupportedBrowser) -> Bool {
        let fileManager = FileManager.default
        let root = browser.userDataDirectory(home: home)
        let profiles = (try? fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        let id = BrowserExtensionIdentity.extensionID
        return profiles.contains { profile in
            // Web Store installs get an Extensions/<id> folder; unpacked ones appear only in the profile's preferences.
            fileManager.fileExists(atPath: profile.appendingPathComponent("Extensions/\(id)").path)
                || ["Preferences", "Secure Preferences"].contains { name in
                    guard let data = try? Data(contentsOf: profile.appendingPathComponent(name)) else { return false }
                    return data.range(of: Data("\"\(id)\"".utf8)) != nil
                }
        }
    }
}
