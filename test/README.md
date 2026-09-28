# FIT Plugin Tests

This directory contains test files and data for the FIT plugin.

## E2E Tests

### Overview
End-to-end tests use WebdriverIO with wdio-obsidian-service to validate the plugin in a real Obsidian environment.

### Running Tests

#### Desktop E2E Tests
```shell
npm run test:e2e
```

#### Mobile Emulation Tests (Recommended for Development)
```shell
npm run test:mobile
```

#### Real Android E2E Tests (Advanced)
```shell
npm run install:android  # Install Android dependencies first
npm run test:android
```

**Mobile Emulation:**
- Runs mobile UI on desktop Obsidian (no Android setup needed)
- Tests mobile viewport and UI layout
- Faster and easier for local development

**Real Android Requirements:**
- Android Studio with Android Virtual Device (AVD) named `obsidian_test`
- Appium and Appium UiAutomator2 driver (auto-installed via `npm run install:android`)
- For CI: Automatically set up via GitHub Actions workflow

### Test Structure
- **Test files**: `test/e2e/*.e2e.ts` - WebdriverIO test specifications
- **Test data**: `test/vaults/basic/` - Minimal test vault with sample markdown files
- **Screenshots**: `test-results/` - Screenshots captured during test execution

### Test Outputs

#### Screenshots
- **Location**: `test-results/` directory
- **Naming**: `fit-sync-result-YYYY-MM-DDTHH-MM-SS-SSSZ.png`
- **Created**: Each test run saves screenshots with timestamps

#### Console Logs
- **Local runs**: Output directly to terminal
- **CI runs**: Available in GitHub Actions logs
- **Debug info**: Test progress and notices printed to console

#### CI Artifacts
- **Desktop Tests**: `e2e-test-results` artifact
- **Mobile Emulation**: `mobile-test-results` artifact
- **Android Tests**: `android-test-results-latest` and `android-test-results-earliest` artifacts
- **Contents**: Screenshots from test runs (e.g., `fit-sync-result-*.png`) in zip archive
- **Retention**: 30 days
- **Access**: Downloadable from "Actions" tab → click on workflow run → "Artifacts" section
- **Note**: GitHub Actions always zips artifacts, even single files

#### Allure Report (step timeline, timing)
Every E2E job also emits raw Allure results (`allure-results-desktop`,
`allure-results-android-latest`, `allure-results-android-earliest` artifacts). A combined
HTML report — with a per-test step timeline and durations — is built by the
`allure-report` job in `e2e.yml` and uploaded as the `allure-report` build artifact.
(Not published anywhere yet — download and view locally for now; see below.)

- **Human debugging**: download the `allure-report` artifact from the run's Actions
  page, unzip it, then serve it locally — Allure's report loads its data via `fetch()`,
  which browsers block over `file://`, so opening `index.html` directly won't work:
  ```shell
  gh run download <run-id> -n allure-report -D /tmp/allure-report
  npx allure-commandline open /tmp/allure-report
  ```
  Each test shows its steps (command execution, DOM queries, screenshots) with timing,
  so you can see exactly which step stalled or failed without re-reading raw CI logs.
- **Debugging without the HTML report** (e.g. scripted/agent investigation): download
  the raw `allure-results-*` artifact instead and read the `*-result.json` files
  directly — each one has `name`, `status`, `statusDetails.message`/`trace`,
  `start`/`stop` timestamps, and a `steps[]` array with per-step timing. That's usually
  faster than navigating the rendered report when you already know what you're looking
  for:
  ```shell
  gh run download <run-id> -n allure-results-desktop -D /tmp/allure
  jq '{name, status, start, stop, steps: [.steps[] | {name, status}]}' /tmp/allure/*-result.json
  ```

### Troubleshooting
When E2E tests fail:
1. Check console output for error messages
2. Download `e2e-test-results` artifacts from CI for screenshots
3. Verify test vault structure in `test/vaults/basic/`
4. Ensure plugin builds successfully with `npm run build`

### Current Test Coverage

#### Desktop (Electron)
- Plugin loading and initialization
- FIT sync command execution
- Notice system validation
- Screenshot capture workflow

#### Mobile Emulation (Desktop + Mobile UI)
- Mobile viewport testing
- Plugin loading in mobile mode
- FIT sync command execution
- Notice system validation
- Screenshot capture workflow

#### Real Android (Mobile App)
- Plugin loading and initialization
- FIT sync command execution
- Notice system validation
- Screenshot capture workflow
- Platform-specific behavior validation

#### Platform Matrix
- **Desktop**: Ubuntu (CI), Windows/macOS (manual)
- **Mobile Emulation**: Ubuntu (CI), any platform (manual)
- **Android**: API Level 36, Pixel profile (CI + manual)
- **Versions**: Latest and earliest (minAppVersion)
