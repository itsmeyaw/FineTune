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
        case let .unknown(type):
            object["type"] = type
        }
        // Dictionary of JSON-safe values: serialization can't fail.
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}
