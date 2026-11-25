// FineTuneTests/BrowserBridgeTests.swift
import Testing
import Foundation
@testable import FineTune

/// Minimal blocking Unix-socket client standing in for the native messaging host.
private final class SocketClient {
    let fd: Int32
    private var reader = NativeMessagingFrameReader()
    private var pending: [BrowserMessage] = []

    init(path: String) throws {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            path.utf8CString.withUnsafeBytes { buffer.copyMemory(from: $0) }
        }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { Darwin.close(fd); throw POSIXError(.ECONNREFUSED) }
    }

    func send(_ message: BrowserMessage) {
        let frame = NativeMessagingFrame.encode(message.encoded())
        _ = frame.withUnsafeBytes { write(fd, $0.baseAddress, frame.count) }
    }

    /// Polls without blocking so the main actor stays free to process the server's events.
    func receive(timeout: TimeInterval = 10) async throws -> BrowserMessage? {
        let deadline = Date().addingTimeInterval(timeout)
        // Poll before checking the deadline: a stalled main actor must not turn buffered data into a timeout.
        while true {
            if !pending.isEmpty { return pending.removeFirst() }
            var pollFD = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            if poll(&pollFD, 1, 0) > 0 {
                var bytes = [UInt8](repeating: 0, count: 4096)
                let count = read(fd, &bytes, bytes.count)
                guard count > 0 else { return nil }
                // A read can end mid-frame or carry several frames; keep the extras for the next call.
                pending += try reader.append(bytes.prefix(count)).map { try BrowserMessage(decoding: $0) }
                continue
            }
            if Date() >= deadline { return nil }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func close() { Darwin.close(fd) }
}

private func tempHome() throws -> URL {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("ft-home-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
        at: home.appendingPathComponent("Library/Application Support/Google/Chrome"),
        withIntermediateDirectories: true
    )
    return home
}

private func shortSocketPath() -> String {
    FileManager.default.temporaryDirectory.appendingPathComponent("ft-\(UUID().uuidString.prefix(8)).sock").path
}

@MainActor
private func waitUntil(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<300 {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

@Suite("BrowserBridge")
@MainActor
struct BrowserBridgeTests {

    @Test("Hello over the socket marks that Browser connected; closing the socket disconnects it")
    func connectAndDisconnect() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path)
        try bridge.start()
        defer { bridge.stop() }

        #expect(bridge.status(for: .chrome) == .notInstalled)

        let client = try SocketClient(path: path)
        client.send(.hello(extensionVersion: "0.1.0", browser: "chrome"))
        #expect(await waitUntil { bridge.status(for: .chrome) == .connected })

        client.close()
        #expect(await waitUntil { bridge.status(for: .chrome) == .notInstalled })
    }

    @Test("Ping is answered with pong")
    func pingPong() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path)
        try bridge.start()
        defer { bridge.stop() }

        let client = try SocketClient(path: path)
        defer { client.close() }
        client.send(.ping)
        #expect(try await client.receive() == .pong)
    }

    @Test("Garbage and unknown messages are ignored, the connection stays usable")
    func tolerantReader() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path)
        try bridge.start()
        defer { bridge.stop() }

        let client = try SocketClient(path: path)
        defer { client.close() }
        for raw in ["not json", #"{"v":9,"type":"ping"}"#, #"{"v":1,"type":"future"}"#] {
            let frame = NativeMessagingFrame.encode(Data(raw.utf8))
            _ = frame.withUnsafeBytes { write(client.fd, $0.baseAddress, frame.count) }
        }
        client.send(.ping)
        #expect(try await client.receive() == .pong)
    }

    @Test("A Browser stays connected until its last connection closes")
    func multipleConnections() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path)
        try bridge.start()
        defer { bridge.stop() }

        let first = try SocketClient(path: path)
        let second = try SocketClient(path: path)
        first.send(.hello(extensionVersion: "0.1.0", browser: "chrome"))
        second.send(.hello(extensionVersion: "0.1.0", browser: "chrome"))
        #expect(await waitUntil { bridge.status(for: .chrome) == .connected })

        first.close()
        try await Task.sleep(for: .milliseconds(200))
        #expect(bridge.status(for: .chrome) == .connected)
        second.close()
        #expect(await waitUntil { bridge.status(for: .chrome) != .connected })
    }

    @Test("A hello from an unknown browser name connects nothing")
    func unknownBrowser() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path)
        try bridge.start()
        defer { bridge.stop() }

        let client = try SocketClient(path: path)
        defer { client.close() }
        client.send(.hello(extensionVersion: "0.1.0", browser: "netscape"))
        client.send(.ping)
        #expect(try await client.receive() == .pong)
        #expect(bridge.entries.allSatisfy { $0.status != .connected })
    }

    @Test("Installed browsers report installed-not-connected once the extension is present")
    func statusLevels() throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let bridge = BrowserBridge(home: home, socketPath: shortSocketPath())
        #expect(bridge.entries.map(\.browser) == [.chrome])
        #expect(bridge.entries.first?.status == .notInstalled)

        try FileManager.default.createDirectory(
            at: home.appendingPathComponent(
                "Library/Application Support/Google/Chrome/Default/Extensions/\(BrowserExtensionIdentity.extensionID)"
            ),
            withIntermediateDirectories: true
        )
        bridge.refresh()
        #expect(bridge.status(for: .chrome) == .installedNotConnected)
    }

    @Test("A second server refuses to steal a live socket")
    func liveSocketNotStolen() throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let first = BrowserBridge(home: home, socketPath: path)
        try first.start()
        defer { first.stop() }

        let second = BrowserBridge(home: home, socketPath: path)
        #expect(throws: BrowserBridgeServerError.self) { try second.start() }
        _ = try SocketClient(path: path)
    }

    @Test("A stale socket file from a crashed run is replaced")
    func staleSocketReplaced() throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        FileManager.default.createFile(atPath: path, contents: Data())
        let bridge = BrowserBridge(home: home, socketPath: path)
        try bridge.start()
        defer { bridge.stop() }
        _ = try SocketClient(path: path)
    }

    private func tab(_ id: Int, muted: Bool = false) -> BrowserTab {
        BrowserTab(id: id, title: "T\(id)", site: "a.com", favicon: nil, isMuted: muted, isWindowFocused: false)
    }

    @Test("Tabs reported over the socket are listed under that Browser and cleared on disconnect")
    func tabsLifecycle() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path, ownerBundleID: { _ in nil })
        try bridge.start()
        defer { bridge.stop() }

        let client = try SocketClient(path: path)
        client.send(.tabs([tab(1)]))  // before hello: ignored
        client.send(.hello(extensionVersion: "0.1.0", browser: "chrome"))
        client.send(.tabs([tab(1), tab(2)]))
        #expect(await waitUntil { bridge.tabs.items(for: .chrome).count == 2 })

        client.send(.tabUpdated(tab(2, muted: true)))
        #expect(await waitUntil { bridge.tabs.items(for: .chrome).last?.tab.isMuted == true })

        client.close()
        #expect(await waitUntil { bridge.tabs.items(for: .chrome).isEmpty })
    }

    @Test("The process that launched the host decides the Browser, so Arc isn't mistaken for Chrome")
    func ownerWinsOverHello() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path, ownerBundleID: { _ in "company.thebrowser.Browser" })
        try bridge.start()
        defer { bridge.stop() }

        let client = try SocketClient(path: path)
        defer { client.close() }
        client.send(.hello(extensionVersion: "0.1.0", browser: "chrome"))
        client.send(.tabs([tab(1)]))
        #expect(await waitUntil { bridge.tabs.items(for: .arc).count == 1 })
        #expect(bridge.tabs.items(for: .chrome).isEmpty)
        #expect(bridge.status(for: .arc) == .connected)
    }

    @Test("An unrecognised owner falls back to the Browser named in hello")
    func unknownOwnerFallsBack() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path, ownerBundleID: { _ in "com.apple.Terminal" })
        try bridge.start()
        defer { bridge.stop() }

        let client = try SocketClient(path: path)
        defer { client.close() }
        client.send(.hello(extensionVersion: "0.1.0", browser: "edge"))
        client.send(.tabs([tab(1)]))
        #expect(await waitUntil { bridge.tabs.items(for: .edge).count == 1 })
    }

    @Test("Mute and focus commands reach the connection that owns the Tab")
    func commands() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path, ownerBundleID: { _ in nil })
        try bridge.start()
        defer { bridge.stop() }

        let client = try SocketClient(path: path)
        defer { client.close() }
        client.send(.hello(extensionVersion: "0.1.0", browser: "chrome"))
        client.send(.tabs([tab(9)]))
        #expect(await waitUntil { !bridge.tabs.items(for: .chrome).isEmpty })
        let item = try #require(bridge.tabs.items(for: .chrome).first)

        bridge.setMuted(item, to: true)
        #expect(try await client.receive() == .setMuted(tabID: 9, muted: true))
        bridge.focus(item)
        #expect(try await client.receive() == .focus(tabID: 9))
    }

    @Test("A Tab that stops being audible disappears once its grace period ends")
    func graceExpiresOnItsOwn() async throws {
        let home = try tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let path = shortSocketPath()
        let bridge = BrowserBridge(home: home, socketPath: path, ownerBundleID: { _ in nil }, tabGracePeriod: 0.2)
        try bridge.start()
        defer { bridge.stop() }

        let client = try SocketClient(path: path)
        defer { client.close() }
        client.send(.hello(extensionVersion: "0.1.0", browser: "chrome"))
        client.send(.tabs([tab(1)]))
        #expect(await waitUntil { !bridge.tabs.items(for: .chrome).isEmpty })
        client.send(.tabRemoved(tabID: 1, closed: false))
        try await Task.sleep(for: .milliseconds(80))
        #expect(bridge.tabs.items(for: .chrome).count == 1)
        #expect(await waitUntil { bridge.tabs.items(for: .chrome).isEmpty })
    }
}
