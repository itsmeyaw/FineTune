// FineTune/BrowserBridge/BrowserExtensionIdentity.swift
import Foundation

/// Names shared by the Browser Extension and the native messaging host manifest.
enum BrowserExtensionIdentity {
    /// Native messaging host name. Chrome allows only lowercase letters, digits, `_` and `.`.
    static let hostName = "com.finetuneapp.finetune"

    /// ID derived from the `key` pinned in `BrowserExtension/manifest.json`. A test recomputes it
    /// from that key, so the two cannot drift apart.
    static let extensionID = "jhnijagbnendhkhdgakpcjkcikphpdfo"

    /// Socket the app listens on and the host process connects to.
    static var socketPath: String {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("FineTune/browser-bridge.sock").path
    }

    static let allowedOrigin = "chrome-extension://\(extensionID)/"

    // shortcut: placeholder URL, replace with the real Web Store listing once it is published.
    static let storeURL = URL(string: "https://chromewebstore.google.com/detail/\(extensionID)")!
}
