// FineTune/BrowserBridge/NativeMessagingHost.swift
import Foundation

/// Host mode: the browser launches the FineTune executable as a native messaging host, passing the
/// extension origin as its first argument. The process only pipes the browser's stdio frames to and
/// from the running app's socket; it never starts the UI and never decodes a message.
enum NativeMessagingHost {
    static func isHostInvocation(_ arguments: [String]) -> Bool {
        arguments.dropFirst().first?.hasPrefix("chrome-extension://") == true
    }

    /// Runs the relay on stdin/stdout. Returns the process exit code.
    static func run(socketPath: String = BrowserExtensionIdentity.socketPath) -> Int32 {
        // The browser can close its pipe while we write; handle EPIPE as an ordinary end of stream.
        signal(SIGPIPE, SIG_IGN)
        guard let peer = connect(socketPath: socketPath) else { return 1 }
        defer { close(peer) }
        relay(input: STDIN_FILENO, output: STDOUT_FILENO, peer: peer)
        return 0
    }

    /// Connects to the app's socket, or returns nil when FineTune isn't running.
    static func connect(socketPath: String) -> Int32? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            pathBytes.withUnsafeBytes { buffer.copyMemory(from: $0) }
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            close(fd)
            return nil
        }
        return fd
    }

    /// Copies `input` → `peer` and `peer` → `output` until either side reaches end of stream.
    static func relay(input: Int32, output: Int32, peer: Int32) {
        var buffer = [UInt8](repeating: 0, count: 65536)
        var fds = [pollfd(fd: input, events: Int16(POLLIN), revents: 0), pollfd(fd: peer, events: Int16(POLLIN), revents: 0)]
        while true {
            if poll(&fds, 2, -1) < 0 {
                if errno == EINTR { continue }
                return
            }
            for (index, destination) in [(0, peer), (1, output)] where fds[index].revents != 0 {
                let count = read(fds[index].fd, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                guard count > 0, writeAll(buffer, count: count, to: destination) else { return }
            }
        }
    }

    private static func writeAll(_ buffer: [UInt8], count: Int, to fd: Int32) -> Bool {
        var offset = 0
        while offset < count {
            let written = buffer.withUnsafeBytes { write(fd, $0.baseAddress! + offset, count - offset) }
            if written < 0 && errno == EINTR { continue }
            guard written > 0 else { return false }
            offset += written
        }
        return true
    }
}
