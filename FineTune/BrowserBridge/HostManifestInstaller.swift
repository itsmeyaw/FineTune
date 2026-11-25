// FineTune/BrowserBridge/HostManifestInstaller.swift
import Foundation
import os

private let logger = Logger(subsystem: "com.finetuneapp.FineTune", category: "HostManifestInstaller")

/// Writes the native messaging host manifest into each installed Browser so it can launch FineTune in host mode.
struct HostManifestInstaller {
    var home: URL = FileManager.default.homeDirectoryForCurrentUser

    /// Writes or refreshes the manifest. Returns the Browsers whose manifest changed.
    @discardableResult
    func install(executablePath: String) -> [SupportedBrowser] {
        let manifest: [String: Any] = [
            "name": BrowserExtensionIdentity.hostName,
            "description": "FineTune per-tab audio bridge",
            "path": executablePath,
            "type": "stdio",
            "allowed_origins": [BrowserExtensionIdentity.allowedOrigin],
        ]
        let data = try! JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])

        var changed: [SupportedBrowser] = []
        for browser in SupportedBrowser.installed(home: home) {
            let directory = browser.nativeMessagingHostsDirectory(home: home)
            let file = directory.appendingPathComponent("\(BrowserExtensionIdentity.hostName).json")
            if (try? Data(contentsOf: file)) == data { continue }
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: file, options: .atomic)
                changed.append(browser)
            } catch {
                logger.error("Failed to write host manifest for \(browser.displayName): \(error.localizedDescription)")
            }
        }
        return changed
    }
}
