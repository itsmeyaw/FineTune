// FineTune/BrowserBridge/BrowserTab.swift
import Foundation

/// A Browser tab that is playing sound or is muted in the Browser, as reported by the Browser Extension.
struct BrowserTab: Equatable, Identifiable {
    /// Browser tab id; unique within one browser session.
    let id: Int
    let title: String
    /// Hostname of the tab's URL, e.g. `www.youtube.com`. Empty when unknown.
    let site: String
    /// `http(s)` or `data:` URL of the tab's favicon.
    let favicon: String?
    let isMuted: Bool
    let isWindowFocused: Bool

    init(id: Int, title: String, site: String, favicon: String?, isMuted: Bool, isWindowFocused: Bool) {
        self.id = id
        self.title = title
        self.site = site
        self.favicon = favicon
        self.isMuted = isMuted
        self.isWindowFocused = isWindowFocused
    }

    init?(json object: Any?) {
        guard let object = object as? [String: Any],
              let id = object["id"] as? Int,
              let title = object["title"] as? String,
              let site = object["site"] as? String,
              let muted = object["muted"] as? Bool,
              let windowFocused = object["windowFocused"] as? Bool else {
            return nil
        }
        self.init(id: id, title: title, site: site, favicon: object["favicon"] as? String, isMuted: muted, isWindowFocused: windowFocused)
    }

    var jsonObject: [String: Any] {
        var object: [String: Any] = [
            "id": id, "title": title, "site": site, "muted": isMuted, "windowFocused": isWindowFocused,
        ]
        object["favicon"] = favicon
        return object
    }
}
