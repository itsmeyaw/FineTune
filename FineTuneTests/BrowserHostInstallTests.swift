// FineTuneTests/BrowserHostInstallTests.swift
import Testing
import Foundation
import CryptoKit
@testable import FineTune

private func makeHome() throws -> URL {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("ft-home-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    return home
}

private func appSupport(_ home: URL, _ relative: String) -> URL {
    home.appendingPathComponent("Library/Application Support/\(relative)")
}

private func mkdir(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
}

@Suite("SupportedBrowser — locations")
struct SupportedBrowserTests {

    @Test("Native messaging directories match each browser's documented user-level path")
    func hostDirectories() {
        let home = URL(fileURLWithPath: "/Users/x")
        let expected: [SupportedBrowser: String] = [
            .chrome: "/Users/x/Library/Application Support/Google/Chrome/NativeMessagingHosts",
            .edge: "/Users/x/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
            .brave: "/Users/x/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
            .arc: "/Users/x/Library/Application Support/Arc/User Data/NativeMessagingHosts",
            .vivaldi: "/Users/x/Library/Application Support/Vivaldi/NativeMessagingHosts",
            .chromium: "/Users/x/Library/Application Support/Chromium/NativeMessagingHosts",
        ]
        for browser in SupportedBrowser.allCases {
            #expect(browser.nativeMessagingHostsDirectory(home: home).path == expected[browser])
        }
    }

    @Test("Ids match what the extension reports in hello")
    func ids() {
        #expect(SupportedBrowser(helloID: "edge") == .edge)
        #expect(SupportedBrowser(helloID: "chrome") == .chrome)
        #expect(SupportedBrowser(helloID: "netscape") == nil)
    }

    @Test("Only browsers with a user data directory count as installed")
    func installedDetection() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try mkdir(appSupport(home, "Google/Chrome"))
        try mkdir(appSupport(home, "Vivaldi"))
        #expect(SupportedBrowser.installed(home: home) == [.chrome, .vivaldi])
    }
}

@Suite("HostManifestInstaller")
struct HostManifestInstallerTests {

    private func manifestURL(_ browser: SupportedBrowser, home: URL) -> URL {
        browser.nativeMessagingHostsDirectory(home: home)
            .appendingPathComponent("\(BrowserExtensionIdentity.hostName).json")
    }

    @Test("Writes an absolute-path stdio manifest allowing only the pinned extension")
    func writesManifest() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try mkdir(appSupport(home, "Google/Chrome"))

        let written = HostManifestInstaller(home: home).install(executablePath: "/Applications/FineTune.app/Contents/MacOS/FineTune")
        #expect(written == [.chrome])

        let data = try Data(contentsOf: manifestURL(.chrome, home: home))
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["name"] as? String == "com.finetuneapp.finetune")
        #expect(object["type"] as? String == "stdio")
        #expect(object["path"] as? String == "/Applications/FineTune.app/Contents/MacOS/FineTune")
        #expect(object["allowed_origins"] as? [String] == ["chrome-extension://jhnijagbnendhkhdgakpcjkcikphpdfo/"])
    }

    @Test("Skips browsers that are not installed")
    func skipsMissing() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try mkdir(appSupport(home, "Google/Chrome"))
        _ = HostManifestInstaller(home: home).install(executablePath: "/x/FineTune")
        #expect(!FileManager.default.fileExists(atPath: appSupport(home, "Microsoft Edge").path))
    }

    @Test("Rewrites when the app moved, leaves an up-to-date manifest alone")
    func rewritesWhenMoved() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try mkdir(appSupport(home, "Arc/User Data"))
        let installer = HostManifestInstaller(home: home)

        #expect(installer.install(executablePath: "/a/FineTune") == [.arc])
        #expect(installer.install(executablePath: "/a/FineTune").isEmpty)
        #expect(installer.install(executablePath: "/b/FineTune") == [.arc])

        let object = try #require(
            try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL(.arc, home: home))) as? [String: Any]
        )
        #expect(object["path"] as? String == "/b/FineTune")
    }
}

@Suite("BrowserExtensionIdentity")
struct BrowserExtensionIdentityTests {

    /// Chrome derives an extension ID from the first 16 bytes of SHA-256 over the DER public key,
    /// mapping each hex digit 0-f to a-p. Recomputing it from the `key` in manifest.json proves
    /// the Swift constant matches what Chrome will actually assign.
    @Test("extensionID matches the key pinned in BrowserExtension/manifest.json")
    func idMatchesManifestKey() throws {
        let manifestURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("BrowserExtension/manifest.json")
        let manifest = try #require(
            try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any]
        )
        let key = try #require(manifest["key"] as? String)
        let der = try #require(Data(base64Encoded: key))
        let hex = SHA256.hash(data: der).prefix(16).map { String(format: "%02x", $0) }.joined()
        let derived = String(hex.map { Character(UnicodeScalar(UInt8(ascii: "a") + UInt8(String($0), radix: 16)!)) })
        #expect(BrowserExtensionIdentity.extensionID == derived)
    }
}

@Suite("BrowserExtensionDetector")
struct BrowserExtensionDetectorTests {

    private let id = BrowserExtensionIdentity.extensionID

    @Test("Finds a store-installed extension in a profile's Extensions folder")
    func storeInstall() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try mkdir(appSupport(home, "Google/Chrome/Profile 2/Extensions/\(id)/0.1.0_0"))
        #expect(BrowserExtensionDetector(home: home).isExtensionInstalled(in: .chrome))
    }

    @Test("Finds an unpacked extension listed in a profile's Preferences")
    func unpackedInstall() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = appSupport(home, "BraveSoftware/Brave-Browser/Default")
        try mkdir(profile)
        try Data(#"{"extensions":{"settings":{"\#(id)":{"path":"/dev/ext"}}}}"#.utf8)
            .write(to: profile.appendingPathComponent("Preferences"))
        #expect(BrowserExtensionDetector(home: home).isExtensionInstalled(in: .brave))
    }

    @Test("Reports not installed when no profile has it")
    func absent() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = appSupport(home, "Google/Chrome/Default")
        try mkdir(profile)
        try Data(#"{"extensions":{"settings":{}}}"#.utf8).write(to: profile.appendingPathComponent("Preferences"))
        #expect(!BrowserExtensionDetector(home: home).isExtensionInstalled(in: .chrome))
    }
}
