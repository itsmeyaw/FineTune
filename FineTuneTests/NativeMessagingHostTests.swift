// FineTuneTests/NativeMessagingHostTests.swift
import Testing
import Foundation
@testable import FineTune

@Suite("NativeMessagingHost")
struct NativeMessagingHostTests {

    @Test("Chrome's origin argument selects host mode; a normal launch does not")
    func detection() {
        #expect(NativeMessagingHost.isHostInvocation(["/App/FineTune", "chrome-extension://abc/"]))
        #expect(NativeMessagingHost.isHostInvocation(["/App/FineTune", "chrome-extension://abc/", "--parent-window=0"]))
        #expect(!NativeMessagingHost.isHostInvocation(["/App/FineTune"]))
        #expect(!NativeMessagingHost.isHostInvocation(["/App/FineTune", "-NSDocumentRevisionsDebugMode", "YES"]))
        #expect(!NativeMessagingHost.isHostInvocation(["chrome-extension://abc/"]))
    }

    @Test("Relay copies bytes both ways and ends when the browser closes stdin")
    func relay() throws {
        var stdin: [Int32] = [0, 0], stdout: [Int32] = [0, 0], sockets: [Int32] = [0, 0]
        #expect(pipe(&stdin) == 0)
        #expect(pipe(&stdout) == 0)
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0)
        defer { [stdin[0], stdout[0], stdout[1], sockets[0], sockets[1]].forEach { _ = close($0) } }

        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            NativeMessagingHost.relay(input: stdin[0], output: stdout[1], peer: sockets[0])
            finished.signal()
        }

        _ = write(stdin[1], "to-app", 6)
        var buffer = [UInt8](repeating: 0, count: 16)
        #expect(read(sockets[1], &buffer, 16) == 6)
        #expect(String(decoding: buffer.prefix(6), as: UTF8.self) == "to-app")

        _ = write(sockets[1], "to-browser", 10)
        #expect(read(stdout[0], &buffer, 16) == 10)
        #expect(String(decoding: buffer.prefix(10), as: UTF8.self) == "to-browser")

        close(stdin[1])
        #expect(finished.wait(timeout: .now() + 3) == .success)
    }

    @Test("Relay ends when FineTune closes the socket")
    func relayEndsOnAppExit() {
        var stdin: [Int32] = [0, 0], stdout: [Int32] = [0, 0], sockets: [Int32] = [0, 0]
        _ = pipe(&stdin)
        _ = pipe(&stdout)
        _ = socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets)
        defer { [stdin[0], stdin[1], stdout[0], stdout[1], sockets[0]].forEach { _ = close($0) } }

        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            NativeMessagingHost.relay(input: stdin[0], output: stdout[1], peer: sockets[0])
            finished.signal()
        }
        close(sockets[1])
        #expect(finished.wait(timeout: .now() + 3) == .success)
    }

    @Test("Connecting fails cleanly when FineTune isn't running")
    func connectWithoutApp() {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("ft-\(UUID().uuidString.prefix(8)).sock").path
        #expect(NativeMessagingHost.connect(socketPath: path) == nil)
    }

    @Test("Frames from stdin reach the app through a real server")
    @MainActor
    func endToEnd() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("ft-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: home.appendingPathComponent("Library/Application Support/Microsoft Edge"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: home) }
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("ft-\(UUID().uuidString.prefix(8)).sock").path
        let bridge = BrowserBridge(home: home, socketPath: path)
        try bridge.start()
        defer { bridge.stop() }

        var stdin: [Int32] = [0, 0], stdout: [Int32] = [0, 0]
        _ = pipe(&stdin)
        _ = pipe(&stdout)
        defer { [stdin[0], stdout[0], stdout[1]].forEach { _ = close($0) } }
        let peer = try #require(NativeMessagingHost.connect(socketPath: path))
        DispatchQueue.global().async {
            NativeMessagingHost.relay(input: stdin[0], output: stdout[1], peer: peer)
            close(peer)
        }

        let hello = NativeMessagingFrame.encode(
            BrowserMessage.hello(extensionVersion: "0.1.0", browser: "edge").encoded()
        )
        _ = hello.withUnsafeBytes { write(stdin[1], $0.baseAddress, hello.count) }

        var connected = false
        for _ in 0..<300 where !connected {
            connected = bridge.status(for: .edge) == .connected
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(connected)

        close(stdin[1])
        var disconnected = false
        for _ in 0..<300 where !disconnected {
            disconnected = bridge.status(for: .edge) != .connected
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(disconnected)
    }
}
