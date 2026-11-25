// FineTune/BrowserBridge/BrowserMessage.swift
import Foundation

enum BrowserMessageError: Error, Equatable {
    case malformed
    case unsupportedVersion(Int)
}

/// One message of the Browser Extension ↔ FineTune protocol (see `BrowserExtension/PROTOCOL.md`).
/// Every message is a JSON object `{"v": <int>, "type": <string>, ...payload}`.
enum BrowserMessage: Equatable {
    case hello(extensionVersion: String, browser: String)
    case ping
    case pong
    /// Full list of the connection's Tabs. Replaces everything reported before.
    case tabs([BrowserTab])
    case tabUpdated(BrowserTab)
    /// `closed`: the tab was closed, as opposed to no longer being audible.
    case tabRemoved(tabID: Int, closed: Bool)
    case setMuted(tabID: Int, muted: Bool)
    case focus(tabID: Int)
    /// Sets the Tab Volume, 0...1.
    case setVolume(tabID: Int, volume: Double)
    /// A well-formed message of a type this build doesn't know. Ignored by receivers.
    case unknown(type: String)

    static let currentVersion = 1

    init(decoding data: Data) throws {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["v"] as? Int else {
            throw BrowserMessageError.malformed
        }
        guard version == Self.currentVersion else {
            throw BrowserMessageError.unsupportedVersion(version)
        }
        guard let type = object["type"] as? String else {
            throw BrowserMessageError.malformed
        }
        switch type {
        case "hello":
            guard let extensionVersion = object["extensionVersion"] as? String,
                  let browser = object["browser"] as? String else {
                throw BrowserMessageError.malformed
            }
            self = .hello(extensionVersion: extensionVersion, browser: browser)
        case "ping":
            self = .ping
        case "pong":
            self = .pong
        case "tabs":
            guard let raw = object["tabs"] as? [Any] else { throw BrowserMessageError.malformed }
            let tabs = raw.compactMap { BrowserTab(json: $0) }
            guard tabs.count == raw.count else { throw BrowserMessageError.malformed }
            self = .tabs(tabs)
        case "tabUpdated":
            guard let tab = BrowserTab(json: object["tab"]) else { throw BrowserMessageError.malformed }
            self = .tabUpdated(tab)
        case "tabRemoved":
            guard let tabID = object["tabId"] as? Int, let closed = object["closed"] as? Bool else {
                throw BrowserMessageError.malformed
            }
            self = .tabRemoved(tabID: tabID, closed: closed)
        case "setMuted":
            guard let tabID = object["tabId"] as? Int, let muted = object["muted"] as? Bool else {
                throw BrowserMessageError.malformed
            }
            self = .setMuted(tabID: tabID, muted: muted)
        case "focus":
            guard let tabID = object["tabId"] as? Int else { throw BrowserMessageError.malformed }
            self = .focus(tabID: tabID)
        case "setVolume":
            guard let tabID = object["tabId"] as? Int, let volume = object["volume"] as? Double else {
                throw BrowserMessageError.malformed
            }
            self = .setVolume(tabID: tabID, volume: min(1, max(0, volume)))
        default:
            self = .unknown(type: type)
        }
    }

    func encoded() -> Data {
        var object: [String: Any] = ["v": Self.currentVersion]
        switch self {
        case let .hello(extensionVersion, browser):
            object["type"] = "hello"
            object["extensionVersion"] = extensionVersion
            object["browser"] = browser
        case .ping:
            object["type"] = "ping"
        case .pong:
            object["type"] = "pong"
        case let .tabs(tabs):
            object["type"] = "tabs"
            object["tabs"] = tabs.map(\.jsonObject)
        case let .tabUpdated(tab):
            object["type"] = "tabUpdated"
            object["tab"] = tab.jsonObject
        case let .tabRemoved(tabID, closed):
            object["type"] = "tabRemoved"
            object["tabId"] = tabID
            object["closed"] = closed
        case let .setMuted(tabID, muted):
            object["type"] = "setMuted"
            object["tabId"] = tabID
            object["muted"] = muted
        case let .focus(tabID):
            object["type"] = "focus"
            object["tabId"] = tabID
        case let .setVolume(tabID, volume):
            object["type"] = "setVolume"
            object["tabId"] = tabID
            object["volume"] = volume
        case let .unknown(type):
            object["type"] = type
        }
        // Dictionary of JSON-safe values: serialization can't fail.
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}
