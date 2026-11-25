// FineTune/BrowserBridge/BrowserFavicon.swift
import AppKit

/// Decodes a Tab's favicon. Only `data:image/...;base64,` values are accepted, so the app never
/// makes a network request for a favicon; anything else falls back to the generic icon.
enum BrowserFavicon {
    /// Same limit as the extension; longer values are ignored.
    static let maxLength = 16 * 1024

    static func image(from value: String?) -> NSImage? {
        guard let value, value.count <= maxLength, value.hasPrefix("data:image/"),
              let comma = value.firstIndex(of: ","),
              value[..<comma].hasSuffix(";base64"),
              let data = Data(base64Encoded: String(value[value.index(after: comma)...])),
              let image = NSImage(data: data), image.isValid else {
            return nil
        }
        return image
    }
}
