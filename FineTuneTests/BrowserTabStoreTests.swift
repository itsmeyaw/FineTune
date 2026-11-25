// FineTuneTests/BrowserTabStoreTests.swift
import Testing
import Foundation
@testable import FineTune

@MainActor
private final class FakeClock {
    var now = Date(timeIntervalSince1970: 1_000)
    func advance(_ seconds: TimeInterval) { now.addTimeInterval(seconds) }
}

private func tab(_ id: Int, title: String = "T", muted: Bool = false) -> BrowserTab {
    BrowserTab(id: id, title: title, site: "a.com", favicon: nil, isMuted: muted, isWindowFocused: false)
}

@Suite("BrowserTabStore — Tab list per Browser")
@MainActor
struct BrowserTabStoreTests {
    private let clock = FakeClock()
    let a = UUID()
    let b = UUID()

    private func makeStore() -> BrowserTabStore {
        BrowserTabStore(gracePeriod: 5, now: { [clock] in clock.now })
    }

    private func ids(_ store: BrowserTabStore, _ browser: SupportedBrowser) -> [Int] {
        store.items(for: browser).map(\.tab.id)
    }

    @Test("A snapshot replaces the connection's Tabs")
    func snapshotReplaces() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.apply(.tabs([tab(1), tab(2)]), connection: a)
        #expect(ids(store, .chrome) == [1, 2])
        store.apply(.tabs([tab(2), tab(3)]), connection: a)
        #expect(ids(store, .chrome).sorted() == [1, 2, 3])  // 1 is in its grace period
        clock.advance(5)
        store.prune()
        #expect(ids(store, .chrome) == [2, 3])
    }

    @Test("An update adds a Tab or changes a listed one in place")
    func updates() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.apply(.tabUpdated(tab(1, title: "old")), connection: a)
        store.apply(.tabUpdated(tab(1, title: "new")), connection: a)
        #expect(store.items(for: .chrome).map(\.tab.title) == ["new"])
    }

    @Test("A Tab that stops being audible stays for the grace period, then goes")
    func gracePeriod() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.apply(.tabUpdated(tab(1)), connection: a)
        store.apply(.tabRemoved(tabID: 1, closed: false), connection: a)
        #expect(ids(store, .chrome) == [1])
        #expect(store.nextExpiry == clock.now.addingTimeInterval(5))

        clock.advance(4.9)
        store.prune()
        #expect(ids(store, .chrome) == [1])

        clock.advance(0.1)
        store.prune()
        #expect(ids(store, .chrome).isEmpty)
        #expect(store.nextExpiry == nil)
    }

    @Test("A Tab that resumes during the grace period is no longer expiring")
    func resumeCancelsGrace() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.apply(.tabUpdated(tab(1)), connection: a)
        store.apply(.tabRemoved(tabID: 1, closed: false), connection: a)
        clock.advance(3)
        store.apply(.tabUpdated(tab(1)), connection: a)
        clock.advance(10)
        store.prune()
        #expect(ids(store, .chrome) == [1])
        #expect(store.nextExpiry == nil)
    }

    @Test("A muted Tab stays listed for as long as it is muted")
    func mutedTabStays() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.apply(.tabUpdated(tab(1, muted: true)), connection: a)
        clock.advance(3600)
        store.prune()
        #expect(ids(store, .chrome) == [1])
        #expect(store.items(for: .chrome).first?.tab.isMuted == true)
    }

    @Test("A closed Tab goes at once; removing an unknown Tab does nothing")
    func closedTab() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.apply(.tabUpdated(tab(1)), connection: a)
        store.apply(.tabRemoved(tabID: 99, closed: false), connection: a)
        store.apply(.tabRemoved(tabID: 1, closed: true), connection: a)
        #expect(ids(store, .chrome).isEmpty)
        #expect(store.nextExpiry == nil)
    }

    @Test("A Tab in its grace period is not re-extended by a repeated removal")
    func repeatedRemoval() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.apply(.tabUpdated(tab(1)), connection: a)
        store.apply(.tabRemoved(tabID: 1, closed: false), connection: a)
        clock.advance(3)
        store.apply(.tabRemoved(tabID: 1, closed: false), connection: a)
        #expect(store.nextExpiry == clock.now.addingTimeInterval(2))
    }

    @Test("Disconnect clears the connection's Tabs at once, grace period included")
    func disconnectClears() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.apply(.tabs([tab(1), tab(2)]), connection: a)
        store.apply(.tabRemoved(tabID: 2, closed: false), connection: a)
        store.close(connection: a)
        #expect(ids(store, .chrome).isEmpty)
        #expect(store.nextExpiry == nil)
    }

    @Test("Browsers keep separate lists; one Browser's profiles merge into one flat list")
    func browsersAndProfiles() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.open(connection: b, browser: .chrome)
        let c = UUID()
        store.open(connection: c, browser: .edge)
        store.apply(.tabs([tab(1)]), connection: a)
        store.apply(.tabs([tab(2)]), connection: b)
        store.apply(.tabs([tab(3)]), connection: c)
        #expect(ids(store, .chrome) == [1, 2])
        #expect(ids(store, .edge) == [3])
        #expect(ids(store, .brave).isEmpty)

        store.apply(.tabs([]), connection: a)
        store.close(connection: b)
        #expect(ids(store, .edge) == [3])
    }

    @Test("Items know their connection, so commands reach the right profile")
    func itemsCarryConnection() {
        let store = makeStore()
        store.open(connection: a, browser: .chrome)
        store.open(connection: b, browser: .chrome)
        store.apply(.tabs([tab(7)]), connection: a)
        store.apply(.tabs([tab(7)]), connection: b)
        let items = store.items(for: .chrome)
        #expect(items.count == 2)
        #expect(Set(items.map(\.connection)) == [a, b])
        #expect(Set(items.map(\.id)).count == 2)
    }

    @Test("Messages for a connection that never opened are ignored")
    func unknownConnection() {
        let store = makeStore()
        store.apply(.tabs([tab(1)]), connection: a)
        store.apply(.tabUpdated(tab(1)), connection: a)
        #expect(ids(store, .chrome).isEmpty)
    }
}
