// FineTune/Views/Settings/Components/BrowsersSection.swift
import SwiftUI

@MainActor
struct BrowsersSection: View {
    let bridge: BrowserBridge

    var body: some View {
        SettingsSection("Browsers") {
            if bridge.entries.isEmpty {
                SettingsRow(
                    "No supported browsers found",
                    description: "Chrome, Edge, Brave, Arc, Vivaldi and Chromium are supported"
                ) { EmptyView() }
            }
            ForEach(bridge.entries) { entry in
                if entry.id != bridge.entries.first?.id { SettingsRowDivider() }
                SettingsRow(entry.browser.displayName, description: Self.description(for: entry.status)) {
                    if entry.status != .connected {
                        Button("Install extension") {
                            NSWorkspace.shared.open(BrowserExtensionIdentity.storeURL)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    } else {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                }
            }
        }
        .onAppear { bridge.refresh() }
    }

    private static func description(for status: BrowserExtensionStatus) -> String {
        switch status {
        case .notInstalled: "Not installed"
        case .installedNotConnected: "Installed, not connected"
        case .connected: "Connected"
        }
    }
}
