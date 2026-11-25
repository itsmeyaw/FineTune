// FineTuneTests/BrowserTabVolumeControlTests.swift
import Testing
@testable import FineTune

@Suite("BrowserTabVolumeControl — Tab Row volume slider state")
struct BrowserTabVolumeControlTests {
    private func tab(volume: Double = 1, supported: Bool) -> BrowserTab {
        BrowserTab(id: 1, title: "T", site: "a.com", favicon: nil, isMuted: false, isWindowFocused: false, volume: volume, isVolumeSupported: supported)
    }

    @Test("A page the extension can't script gets a disabled slider with the explaining tooltip")
    func unsupported() {
        let control = BrowserTabVolumeControl(tab: tab(supported: false))
        #expect(control.isEnabled == false)
        #expect(control.tooltip == "Volume can't be changed on this page")
    }

    @Test("A supported page gets an enabled slider and no tooltip")
    func supported() {
        let control = BrowserTabVolumeControl(tab: tab(supported: true))
        #expect(control.isEnabled)
        #expect(control.tooltip == nil)
    }

    @Test("The slider position follows the App Row curve and the percentage is the position")
    func position() {
        #expect(BrowserTabVolumeControl(tab: tab(volume: 1, supported: true)).percentage == 100)
        let half = BrowserTabVolumeControl(tab: tab(volume: 0.25, supported: true))
        #expect(half.sliderValue == 0.5)
        #expect(half.percentage == 50)
        #expect(BrowserTabVolumeControl(tab: tab(volume: 0, supported: true)).percentage == 0)
    }

    @Test("A slider position becomes a Tab Volume on the same curve, never above 1")
    func volumeForPosition() {
        #expect(BrowserTabVolumeControl.volume(forSliderValue: 0.5) == 0.25)
        #expect(BrowserTabVolumeControl.volume(forSliderValue: 1) == 1)
        #expect(BrowserTabVolumeControl.volume(forSliderValue: 3) == 1)
        #expect(BrowserTabVolumeControl.volume(forSliderValue: -1) == 0)
    }
}
