// FineTune/Views/Rows/BrowserTabRow.swift
import SwiftUI

/// What the Tab Row's volume slider shows and whether it can be used.
struct BrowserTabVolumeControl: Equatable {
    static let unsupportedTooltip = "Volume can't be changed on this page"

    let isEnabled: Bool
    let tooltip: String?
    /// Slider position 0...1, on the same curve as the App Row slider.
    let sliderValue: Double
    var percentage: Int { Int((sliderValue * 100).rounded()) }

    init(tab: BrowserTab) {
        isEnabled = tab.isVolumeSupported
        tooltip = tab.isVolumeSupported ? nil : Self.unsupportedTooltip
        sliderValue = VolumeMapping.gainToSlider(Float(tab.volume))
    }

    /// Tab Volume (0...1, no boost) for a slider position.
    static func volume(forSliderValue slider: Double) -> Double {
        Double(VolumeMapping.sliderToGain(slider))
    }
}

/// A Browser tab listed under its Browser's App Row: site icon (focuses the tab), title, a mute button and the
/// Tab Volume slider. No level meter. Dimmed while the Browser itself is muted.
struct BrowserTabRow: View {
    let tab: BrowserTab
    let isBrowserMuted: Bool
    let isFocused: Bool
    let onMuteChange: (Bool) -> Void
    let onVolumeChange: (Double) -> Void
    let onFocus: () -> Void

    @State private var isHovered = false
    @State private var isIconHovered = false
    /// Decoded once per favicon value, not on every body evaluation.
    @State private var faviconImage: NSImage?
    @State private var dragOverrideValue: Double?

    init(tab: BrowserTab, isBrowserMuted: Bool, isFocused: Bool, onMuteChange: @escaping (Bool) -> Void, onVolumeChange: @escaping (Double) -> Void, onFocus: @escaping () -> Void) {
        self.tab = tab
        self.isBrowserMuted = isBrowserMuted
        self.isFocused = isFocused
        self.onMuteChange = onMuteChange
        self.onVolumeChange = onVolumeChange
        self.onFocus = onFocus
        _faviconImage = State(initialValue: BrowserFavicon.image(from: tab.favicon))
    }

    private var control: BrowserTabVolumeControl { BrowserTabVolumeControl(tab: tab) }

    private var sliderValue: Double { dragOverrideValue ?? control.sliderValue }

    private var sliderBinding: Binding<Double> {
        Binding(
            get: { sliderValue },
            set: { newValue in
                dragOverrideValue = newValue
                onVolumeChange(BrowserTabVolumeControl.volume(forSliderValue: newValue))
            }
        )
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

            volumeControls
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

    private var volumeControls: some View {
        HStack(spacing: DesignTokens.Spacing.sm) {
            LiquidGlassSlider(
                value: sliderBinding,
                showUnityMarker: false,
                onEditingChanged: { editing in
                    if !editing { dragOverrideValue = nil }
                }
            )
            .frame(width: DesignTokens.Dimensions.sliderWidth)
            .scrollWheelStep(sliderBinding, in: 0.0...1.0)

            EditablePercentage(
                percentage: Binding(
                    get: { Int((sliderValue * 100).rounded()) },
                    set: { onVolumeChange(BrowserTabVolumeControl.volume(forSliderValue: Double($0) / 100)) }
                ),
                range: 0...100
            )
        }
        .disabled(!control.isEnabled)
        .opacity(control.isEnabled ? 1.0 : 0.4)
        .help(control.tooltip ?? "")
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
                tab: BrowserTab(id: 1, title: "A very long video title that does not fit in the popup width at all", site: "www.youtube.com", favicon: nil, isMuted: false, isWindowFocused: true, volume: 0.5, isVolumeSupported: true),
                isBrowserMuted: false, isFocused: false, onMuteChange: { _ in }, onVolumeChange: { _ in }, onFocus: {}
            )
            BrowserTabRow(
                tab: BrowserTab(id: 2, title: "Muted tab", site: "open.spotify.com", favicon: nil, isMuted: true, isWindowFocused: false),
                isBrowserMuted: true, isFocused: true, onMuteChange: { _ in }, onVolumeChange: { _ in }, onFocus: {}
            )
        }
    }
}
