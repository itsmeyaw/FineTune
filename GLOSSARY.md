# FineTune

A macOS menu-bar mixer that controls audio volume, mute, EQ and output routing for each app.

## Language

### Apps

**App Row**:
A row in the Apps section that controls one app's audio as a single stream.
_Avoid_: App card, app entry

### Browser tabs

**Browser**:
A Chromium-based browser (Chrome, Edge, Brave, Arc, Vivaldi) that can host the Browser Extension.
_Avoid_: Chrome (when meaning any supported browser)

**Browser Extension**:
FineTune's companion extension that runs inside a Browser and applies per-tab mute and volume on FineTune's behalf.
_Avoid_: Plugin, add-on, companion app

**Tab**:
A Browser tab that is playing sound, or that is muted in the Browser.
_Avoid_: Page, site

**Tab Row**:
A row nested under a Browser's App Row that controls one Tab's mute and volume.
_Avoid_: Sub-app, child app

**Tab Volume**:
A Tab's own volume (0–100%), applied on top of the Browser's App Row volume; the Tab's loudness is the two multiplied.
_Avoid_: Tab gain
