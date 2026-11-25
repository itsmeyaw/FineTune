// FineTune/BrowserBridge/BrowserTab.swift
import Foundation

/// A Browser tab that is playing sound or is muted in the Browser, as reported by the Browser Extension.
struct BrowserTab: Equatable, Identifiable {
    /// Browser tab id; unique within one browser session.
    let id: Int
    let title: String
    /// Hostname of the tab's URL, e.g. `www.youtube.com`. Empty when unknown.
    let site: String
    /// `data:image/...` URL of the tab's favicon; `BrowserFavicon` ignores any other value.
    let favicon: String?
    let isMuted: Bool
    let isWindowFocused: Bool
    /// Tab Volume, 0...1 (only lowers). The Browser's App Row volume applies on top.
    var volume: Double
    /// False on pages the extension can't script (`chrome://`, the Web Store, the PDF viewer).
    let isVolumeSupported: Bool

    init(
        id: Int, title: String, site: String, favicon: String?, isMuted: Bool, isWindowFocused: Bool,
        volume: Double = 1, isVolumeSupported: Bool = false
    ) {
        self.id = id
        self.title = title
        self.site = site
        self.favicon = favicon
        self.isMuted = isMuted
        self.isWindowFocused = isWindowFocused
        self.volume = min(1, max(0, volume))
        self.isVolumeSupported = isVolumeSupported
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
        // Older extensions don't send the volume fields: full volume, and not changeable.
        let volume: Double
        if let raw = object["volume"] {
            guard let number = raw as? Double else { return nil }
            volume = number
        } else {
            volume = 1
        }
        self.init(
            id: id, title: title, site: site, favicon: object["favicon"] as? String, isMuted: muted,
            isWindowFocused: windowFocused, volume: volume,
            isVolumeSupported: object["volumeSupported"] as? Bool ?? false
        )
    }

    var jsonObject: [String: Any] {
        var object: [String: Any] = [
            "id": id, "title": title, "site": site, "muted": isMuted, "windowFocused": isWindowFocused,
            "volume": volume, "volumeSupported": isVolumeSupported,
        ]
        object["favicon"] = favicon
        return object
    }
}
