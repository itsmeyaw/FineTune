// FineTune/BrowserBridge/BrowserBridge.swift
import Foundation
import Observation
import os

private let logger = Logger(subsystem: "com.finetuneapp.FineTune", category: "BrowserBridge")

enum BrowserExtensionStatus: Equatable {
    case notInstalled
    case installedNotConnected
    case connected
}

/// App-side end of the Browser Extension bridge: owns the socket server and tracks which Browsers are connected.
@MainActor
@Observable
final class BrowserBridge {
    struct Entry: Equatable, Identifiable {
        let browser: SupportedBrowser
        let status: BrowserExtensionStatus
        var id: SupportedBrowser { browser }
    }

    static var defaultSocketPath: String {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("FineTune/browser-bridge.sock").path
    }

    /// Installed Browsers (plus any that are connected), with their extension status.
    private(set) var entries: [Entry] = []

    @ObservationIgnored private let home: URL
    @ObservationIgnored private let socketPath: String
    @ObservationIgnored private var server: BrowserBridgeServer?
    /// One entry per live host connection; the value is the Browser its `hello` named, once known.
    @ObservationIgnored private var connections: [UUID: SupportedBrowser?] = [:]

    init(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        socketPath: String = BrowserBridge.defaultSocketPath
    ) {
        self.home = home
        self.socketPath = socketPath
        refresh()
    }

    func status(for browser: SupportedBrowser) -> BrowserExtensionStatus {
        entries.first { $0.browser == browser }?.status ?? .notInstalled
    }

    func start() throws {
        let server = BrowserBridgeServer(socketPath: socketPath) { event in
            // Strict FIFO onto the main actor so open/message/close can't reorder.
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.handle(event) }
            }
        }
        try server.start()
        self.server = server
    }

    func stop() {
        server?.stop()
        server = nil
        connections.removeAll()
        refresh()
    }

    /// Re-scans installed Browsers and extension presence. Cheap enough to call when Settings appears.
    func refresh() {
        let connected = Set(connections.values.compactMap { $0 })
        let detector = BrowserExtensionDetector(home: home)
        let browsers = Set(SupportedBrowser.installed(home: home)).union(connected)
        entries = SupportedBrowser.allCases.filter(browsers.contains).map { browser in
            if connected.contains(browser) { return Entry(browser: browser, status: .connected) }
            let installed = detector.isExtensionInstalled(in: browser)
            return Entry(browser: browser, status: installed ? .installedNotConnected : .notInstalled)
        }
    }

    private func handle(_ event: BrowserBridgeServer.Event) {
        switch event {
        case let .opened(id):
            connections[id] = .some(nil)
        case let .message(id, message):
            guard connections[id] != nil else { return }
            switch message {
            case let .hello(extensionVersion, browser):
                logger.info("Extension \(extensionVersion) connected from \(browser)")
                connections[id] = .some(SupportedBrowser(helloID: browser))
                refresh()
            case .ping:
                server?.send(.pong, to: id)
            case .pong, .unknown:
                break
            }
        case let .closed(id):
            connections.removeValue(forKey: id)
            refresh()
        }
    }
}
