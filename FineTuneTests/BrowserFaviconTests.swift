// FineTuneTests/BrowserFaviconTests.swift
import AppKit
import Testing
@testable import FineTune

@Suite("BrowserFavicon")
struct BrowserFaviconTests {
    private static let png: String = {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return "data:image/png;base64," + rep.representation(using: .png, properties: [:])!.base64EncodedString()
    }()

    @Test("Decodes a PNG data URL")
    func decodesDataURL() throws {
        let image = try #require(BrowserFavicon.image(from: Self.png))
        #expect(image.size.width > 0)
    }

    @Test(
        "Ignores anything that is not an image data URL",
        arguments: [
            "https://www.youtube.com/favicon.ico", "http://a.com/f.png", "file:///etc/passwd",
            "data:text/html;base64,PGI+aGk8L2I+", "data:image/png,notbase64", "data:image/png;base64,!!!not base64!!!",
            "data:image/png;base64,AAAA", "",
        ]
    )
    func ignoresOthers(value: String) {
        #expect(BrowserFavicon.image(from: value) == nil)
    }

    @Test("Ignores nil and oversized values")
    func ignoresNilAndOversized() {
        #expect(BrowserFavicon.image(from: nil) == nil)
        #expect(BrowserFavicon.image(from: Self.png + String(repeating: "A", count: BrowserFavicon.maxLength)) == nil)
    }
}
