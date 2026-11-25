// FineTune/BrowserBridge/BrowserTabStore.swift
import Foundation
import Observation

/// The Tabs of every connected Browser, as reported by the Browser Extension.
///
/// A Tab that stops being audible stays listed for `gracePeriod`; a Tab that is muted in the Browser
/// stays for as long as it is muted (the extension keeps reporting it). Closing a connection clears its Tabs.
/// Expiry is lazy: callers run `prune()` at `nextExpiry`.
@MainActor
@Observable
final class BrowserTabStore {
    struct Item: Identifiable, Equatable {
        struct ID: Hashable {
            let connection: UUID
            let tabID: Int
        }
        let connection: UUID
        let tab: BrowserTab
        var id: ID { ID(connection: connection, tabID: tab.id) }
    }

    private struct Entry {
        var tab: BrowserTab
        var expiresAt: Date?
    }

    private struct ConnectionTabs {
        let browser: SupportedBrowser
        var entries: [Int: Entry] = [:]

        /// Starts the grace period of a listed Tab; one already expiring keeps its deadline.
        mutating func startGrace(of tabID: Int, until expiry: Date) {
            guard var entry = entries[tabID] else { return }
            entry.expiresAt = entry.expiresAt ?? expiry
            entries[tabID] = entry
        }
    }

    @ObservationIgnored private let gracePeriod: TimeInterval
    @ObservationIgnored private let now: () -> Date
    private var connections: [UUID: ConnectionTabs] = [:]

    init(gracePeriod: TimeInterval = 5, now: @escaping () -> Date = Date.init) {
        self.gracePeriod = gracePeriod
        self.now = now
    }

    /// One flat list across a Browser's connections (profiles), ordered by tab id.
    func items(for browser: SupportedBrowser) -> [Item] {
        connections
            .filter { $0.value.browser == browser }
            .flatMap { connection, state in state.entries.values.map { Item(connection: connection, tab: $0.tab) } }
            .sorted { ($0.tab.id, $0.connection.uuidString) < ($1.tab.id, $1.connection.uuidString) }
    }

    /// When the earliest expiring Tab goes, or nil when none is expiring.
    var nextExpiry: Date? {
        connections.values.flatMap { $0.entries.values.compactMap(\.expiresAt) }.min()
    }

    func open(connection: UUID, browser: SupportedBrowser) {
        connections[connection] = ConnectionTabs(browser: browser)
    }

    func close(connection: UUID) {
        connections.removeValue(forKey: connection)
    }

    /// Applies the Tab messages of a connection that has said hello; anything else is ignored.
    func apply(_ message: BrowserMessage, connection: UUID) {
        guard var state = connections[connection] else { return }
        let expiry = now().addingTimeInterval(gracePeriod)
        switch message {
        case let .tabs(tabs):
            let listed = Set(tabs.map(\.id))
            for id in Array(state.entries.keys) where !listed.contains(id) {
                state.startGrace(of: id, until: expiry)
            }
            for tab in tabs { state.entries[tab.id] = Entry(tab: tab) }
        case let .tabUpdated(tab):
            state.entries[tab.id] = Entry(tab: tab)
        case let .tabRemoved(tabID, closed):
            if closed {
                state.entries.removeValue(forKey: tabID)
            } else {
                state.startGrace(of: tabID, until: expiry)
            }
        default:
            return
        }
        connections[connection] = state
    }

    /// Drops Tabs whose grace period is over.
    func prune() {
        let current = now()
        for (connection, state) in connections {
            let kept = state.entries.filter { ($0.value.expiresAt ?? .distantFuture) > current }
            if kept.count != state.entries.count { connections[connection]?.entries = kept }
        }
    }
}
