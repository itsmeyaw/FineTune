// FineTune/BrowserBridge/BrowserBridgeServer.swift
import Foundation
import os

private let logger = Logger(subsystem: "com.finetuneapp.FineTune", category: "BrowserBridgeServer")

enum BrowserBridgeServerError: Error {
    case pathTooLong
    case socketInUse
    case posix(String, Int32)
}

/// Unix domain socket server. Each accepted connection is one native messaging host process
/// relaying frames for one Browser Extension instance. Everything runs on a private serial queue.
final class BrowserBridgeServer: @unchecked Sendable {
    enum Event {
        case opened(UUID, peerPID: pid_t?)
        case message(UUID, BrowserMessage)
        case closed(UUID)
    }

    private final class Connection {
        let fd: Int32
        let source: DispatchSourceRead
        var reader = NativeMessagingFrameReader()
        init(fd: Int32, source: DispatchSourceRead) {
            self.fd = fd
            self.source = source
        }
    }

    private let socketPath: String
    private let onEvent: @Sendable (Event) -> Void
    private let queue = DispatchQueue(label: "com.finetuneapp.FineTune.BrowserBridgeServer")
    private var listenSource: DispatchSourceRead?
    private var connections: [UUID: Connection] = [:]

    init(socketPath: String, onEvent: @escaping @Sendable (Event) -> Void) {
        self.socketPath = socketPath
        self.onEvent = onEvent
    }

    func start() throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw BrowserBridgeServerError.pathTooLong
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            pathBytes.withUnsafeBytes { buffer.copyMemory(from: $0) }
        }
        let addressLength = socklen_t(MemoryLayout<sockaddr_un>.size)

        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: socketPath).deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw BrowserBridgeServerError.posix("socket", errno) }

        // A connectable socket file means another FineTune is serving it; anything else is a stale leftover.
        let probe = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, addressLength) }
        }
        if probe == 0 {
            close(fd)
            throw BrowserBridgeServerError.socketInUse
        }
        unlink(socketPath)

        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, addressLength) }
        }
        guard bound == 0, chmod(socketPath, 0o600) == 0, listen(fd, 8) == 0 else {
            let code = errno
            close(fd)
            throw BrowserBridgeServerError.posix("bind/listen", code)
        }
        Self.setNonBlocking(fd)

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptPending(on: fd) }
        source.setCancelHandler { close(fd) }
        queue.sync { listenSource = source }
        source.resume()
    }

    func stop() {
        queue.sync {
            listenSource?.cancel()
            listenSource = nil
            for id in Array(connections.keys) { closeConnection(id) }
            unlink(socketPath)
        }
    }

    func send(_ message: BrowserMessage, to id: UUID) {
        let frame = NativeMessagingFrame.encode(message.encoded())
        queue.async { [self] in
            guard let connection = connections[id] else { return }
            let written = frame.withUnsafeBytes { write(connection.fd, $0.baseAddress, frame.count) }
            // Frames are tiny; a short write means the peer is gone or stuck.
            if written != frame.count { closeConnection(id) }
        }
    }

    // MARK: - Private (serial queue)

    private func acceptPending(on listenFD: Int32) {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 { return }
            Self.setNonBlocking(fd)
            var noSigPipe: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

            let id = UUID()
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self] in self?.readAvailable(from: id) }
            source.setCancelHandler { close(fd) }
            connections[id] = Connection(fd: fd, source: source)
            source.resume()
            onEvent(.opened(id, peerPID: Self.peerPID(of: fd)))
        }
    }

    private func readAvailable(from id: UUID) {
        guard let connection = connections[id] else { return }
        var buffer = [UInt8](repeating: 0, count: 65536)
        let count = read(connection.fd, &buffer, buffer.count)
        if count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR) {
            closeConnection(id)
            return
        }
        guard count > 0 else { return }

        let frames: [Data]
        do {
            frames = try connection.reader.append(buffer.prefix(count))
        } catch {
            logger.error("Dropping connection: \(error.localizedDescription)")
            closeConnection(id)
            return
        }
        for frame in frames {
            do {
                onEvent(.message(id, try BrowserMessage(decoding: frame)))
            } catch {
                logger.warning("Ignoring undecodable message: \(String(describing: error))")
            }
        }
    }

    private func closeConnection(_ id: UUID) {
        guard let connection = connections.removeValue(forKey: id) else { return }
        connection.source.cancel()
        onEvent(.closed(id))
    }

    private static func peerPID(of fd: Int32) -> pid_t? {
        var pid: pid_t = 0
        var length = socklen_t(MemoryLayout<pid_t>.size)
        return getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0 ? pid : nil
    }

    private static func setNonBlocking(_ fd: Int32) {
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    }
}
