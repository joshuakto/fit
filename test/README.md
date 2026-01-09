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
