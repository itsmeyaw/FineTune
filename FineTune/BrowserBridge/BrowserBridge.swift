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

    /// Installed Browsers (plus any that are connected), with their extension status.
    private(set) var entries: [Entry] = []

    /// Tabs of the connected Browsers.
    let tabs: BrowserTabStore

    @ObservationIgnored private let home: URL
    @ObservationIgnored private let socketPath: String
    @ObservationIgnored private var server: BrowserBridgeServer?
    @ObservationIgnored private var pruneTask: Task<Void, Never>?
    /// One entry per live host connection.
    @ObservationIgnored private var connections: [UUID: Connection] = [:]
    @ObservationIgnored private let ownerBundleID: (pid_t) -> String?

    private struct Connection {
        /// The Browser that launched the host, when it could be read and is a supported Browser.
        var owner: SupportedBrowser?
        /// The Browser this connection speaks for, once `hello` arrived: the owner, else the one `hello` named.
        var browser: SupportedBrowser?
    }

    /// - Parameter ownerBundleID: bundle ID of the app that launched the host process with the given pid.
    ///   Arc and Chromium call themselves Chrome in `hello`; the launching process doesn't.
    init(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        socketPath: String = BrowserExtensionIdentity.socketPath,
        ownerBundleID: @escaping (pid_t) -> String? = BrowserHostOwner.bundleID(ofHostProcess:),
        tabGracePeriod: TimeInterval = 5
    ) {
        self.home = home
        self.socketPath = socketPath
        self.ownerBundleID = ownerBundleID
        self.tabs = BrowserTabStore(gracePeriod: tabGracePeriod)
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

    /// App-launch entry point: serves the socket and points each installed Browser's host manifest at this executable.
    /// Failures are logged only; FineTune works the same without the bridge.
    func launch(executablePath: String) {
        do {
            try start()
        } catch {
            logger.error("Browser bridge not started: \(String(describing: error))")
        }
        let home = home
        Task.detached(priority: .utility) {
            HostManifestInstaller(home: home).install(executablePath: executablePath)
            await self.refresh()
        }
    }

    func stop() {
        server?.stop()
        server = nil
        for id in connections.keys { tabs.close(connection: id) }
        connections.removeAll()
        refresh()
    }

    func setMuted(_ item: BrowserTabStore.Item, to muted: Bool) {
        server?.send(.setMuted(tabID: item.tab.id, muted: muted), to: item.connection)
    }

    /// Brings the Tab to the front in its Browser.
    func focus(_ item: BrowserTabStore.Item) {
        server?.send(.focus(tabID: item.tab.id), to: item.connection)
    }

    /// Re-scans installed Browsers and extension presence. Cheap enough to call when Settings appears.
    func refresh() {
        let connected = Set(connections.values.compactMap(\.browser))
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
        case let .opened(id, peerPID):
            let owner = peerPID.flatMap(ownerBundleID).flatMap { SupportedBrowser(bundleID: $0) }
            connections[id] = Connection(owner: owner, browser: nil)
        case let .message(id, message):
            guard let connection = connections[id] else { return }
            switch message {
            case let .hello(extensionVersion, browser):
                logger.info("Extension \(extensionVersion) connected from \(browser)")
                let resolved = connection.owner ?? SupportedBrowser(helloID: browser)
                connections[id]?.browser = resolved
                if let resolved { tabs.open(connection: id, browser: resolved) }
                refresh()
            case .ping:
                server?.send(.pong, to: id)
            case .tabs, .tabUpdated, .tabRemoved:
                tabs.apply(message, connection: id)
                schedulePrune()
            case .pong, .setMuted, .focus, .unknown:
                break
            }
        case let .closed(id):
            connections.removeValue(forKey: id)
            tabs.close(connection: id)
            schedulePrune()
            refresh()
        }
    }

    /// Wakes at the next grace-period expiry to drop Tabs that stayed silent.
    private func schedulePrune() {
        pruneTask?.cancel()
        pruneTask = nil
        guard let expiry = tabs.nextExpiry else { return }
        pruneTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self else { return }
            tabs.prune()
            schedulePrune()
        }
    }
}
