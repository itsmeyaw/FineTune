// FineTune/Views/Rows/BrowserTabRow.swift
import SwiftUI

/// A Browser tab listed under its Browser's App Row: site icon (focuses the tab), title and a mute button.
/// No level meter. Dimmed while the Browser itself is muted.
struct BrowserTabRow: View {
    let tab: BrowserTab
    let isBrowserMuted: Bool
    let isFocused: Bool
    let onMuteChange: (Bool) -> Void
    let onFocus: () -> Void

    @State private var isHovered = false
    @State private var isIconHovered = false
    /// Decoded once per favicon value, not on every body evaluation.
    @State private var faviconImage: NSImage?

    init(tab: BrowserTab, isBrowserMuted: Bool, isFocused: Bool, onMuteChange: @escaping (Bool) -> Void, onFocus: @escaping () -> Void) {
        self.tab = tab
        self.isBrowserMuted = isBrowserMuted
        self.isFocused = isFocused
        self.onMuteChange = onMuteChange
        self.onFocus = onFocus
        _faviconImage = State(initialValue: BrowserFavicon.image(from: tab.favicon))
    }

    private static let iconSize: CGFloat = 16
    private static let indent: CGFloat = DesignTokens.Spacing.xl

    var body: some View {
        HStack(spacing: DesignTokens.Spacing.sm) {
            Button(action: onFocus) {
                siteIcon
                    .frame(width: Self.iconSize, height: Self.iconSize)
                    .opacity(isIconHovered ? 0.7 : 1.0)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show tab \(tab.title)")
            .onHover { hovering in
                isIconHovered = hovering
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }

            Text(tab.title.isEmpty ? tab.site : tab.title)
                .font(.system(size: 12))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(tab.site.isEmpty ? tab.title : "\(tab.title)\n\(tab.site)")

            MuteButton(isMuted: tab.isMuted) { onMuteChange(!tab.isMuted) }
        }
        .frame(height: DesignTokens.Dimensions.rowContentHeight - 4)
        .padding(.leading, Self.indent)
        .padding(.trailing, DesignTokens.Spacing.sm)
        .padding(.horizontal, DesignTokens.Spacing.sm)
        .padding(.vertical, 2)
        .opacity(isBrowserMuted ? 0.5 : 1.0)
        .background {
            RoundedRectangle(cornerRadius: DesignTokens.Dimensions.rowRadius)
                .fill(isHovered || isFocused ? DesignTokens.Colors.hoverSurface : Color.clear)
                .padding(.vertical, 1)
                .allowsHitTesting(false)
        }
        .onHover { isHovered = $0 }
        .onChange(of: tab.favicon) { _, favicon in faviconImage = BrowserFavicon.image(from: favicon) }
        .animation(DesignTokens.Animation.hover, value: isHovered)
        .animation(DesignTokens.Animation.hover, value: isFocused)
    }

    @ViewBuilder
    private var siteIcon: some View {
        if let faviconImage {
            Image(nsImage: faviconImage).resizable().aspectRatio(contentMode: .fit)
        } else {
            fallbackIcon
        }
    }

    private var fallbackIcon: some View {
        Image(systemName: "globe")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .foregroundStyle(DesignTokens.Colors.textTertiary)
    }
}

#Preview("Browser Tab Row") {
    PreviewContainer {
        VStack(spacing: 4) {
            BrowserTabRow(
                tab: BrowserTab(id: 1, title: "A very long video title that does not fit in the popup width at all", site: "www.youtube.com", favicon: nil, isMuted: false, isWindowFocused: true),
                isBrowserMuted: false, isFocused: false, onMuteChange: { _ in }, onFocus: {}
            )
            BrowserTabRow(
                tab: BrowserTab(id: 2, title: "Muted tab", site: "open.spotify.com", favicon: nil, isMuted: true, isWindowFocused: false),
                isBrowserMuted: true, isFocused: true, onMuteChange: { _ in }, onFocus: {}
            )
        }
    }
}
