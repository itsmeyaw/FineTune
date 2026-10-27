# FineTune — agent notes

macOS 15.4+ menu-bar app (SwiftUI + AppKit, Core Audio process taps). One Xcode project, no SPM package / Makefile / linter config. SPM deps resolve through Xcode: Sparkle, KeyboardShortcuts, FluidMenuBarExtra, swift-snapshot-testing.

## Commands (mirror `.github/workflows/ci.yml`)

```bash
xcodebuild build -project FineTune.xcodeproj -scheme FineTune -configuration Debug CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO
xcodebuild test  -project FineTune.xcodeproj -scheme FineTune -configuration Debug -skip-testing:FineTuneUITests CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO
# focused: replace -skip-testing with -only-testing:FineTuneTests/<SuiteStructName>
```

- Always pass `-skip-testing:FineTuneUITests`: the target is still in the pbxproj, but `FineTuneUITests/` is gitignored, so the folder isn't there.
- Unit tests are hosted in `FineTune.app` (`TEST_HOST`), so the app target has to build before any test runs.

## Project quirks

- Targets use `PBXFileSystemSynchronizedRootGroup`: adding a file under `FineTune/` or `FineTuneTests/` is enough. Don't hand-edit the pbxproj to register files.
- Run `./scripts/install-git-filters.sh` once per clone. `.gitattributes` runs a clean filter on `project.pbxproj` that strips `DEVELOPMENT_TEAM[sdk=macosx*]`. Without it, every Xcode build marks the pbxproj as changed. Never commit a team ID.
- Swift 6 with approachable concurrency. **Only the test target** defaults to `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`. The app target does not, so app code needs explicit `@MainActor` (the convention for `@Observable` state).
- The app is not sandboxed (hardened runtime only) and is built with `-D ENABLE_TCC_SPI` (private TCC calls in `Audio/Permission/AudioRecordingPermission.swift`).
- Tests use Swift Testing (`import Testing`, `@Suite`/`@Test`) with `@testable import FineTune`, not XCTest.
- `SettingsManager` persists a versioned `settings.json` (currently `version: 12`). Schema changes need a migration plus a fixture/test like `FineTuneTests/Fixtures/settings-v10.json` / `settings-v11.json`.

## Real-time audio rule (from CONTRIBUTING.md)

Code on the audio callback path (`processAudio()` in `Audio/Engine/ProcessTapController.swift`, and the EQ/limiter/loudness processors it calls) must be RT-safe. That means no allocations (including `Array.append`), no locks or semaphores, no ObjC messaging, and no logging, `print`, or file I/O.

## Release (don't run by hand)

- Pushing a `v*` tag triggers `release.yml`. It rewrites `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` from the tag, signs, builds and notarizes the DMG (it does not use `scripts/build-dmg.sh`), and commits an updated `appcast.xml` to `main`. Don't bump versions or edit `appcast.xml` yourself.
- `ExportOptions.plist` keeps `TEAM_ID_PLACEHOLDER` on purpose. CI fills it in.

## Ignored paths

- `CLAUDE.md`, `docs/`, `.claude/`, `reference/` (vendored Apple headers, not redistributable), and `scripts/spikes/` are gitignored. Never commit them.
