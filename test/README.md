# FIT Plugin Tests

This directory contains test files and data for the FIT plugin.

## E2E Tests

### Overview
End-to-end tests use WebdriverIO with wdio-obsidian-service to validate the plugin in a real Obsidian environment.

### Running Tests
```shell
npm run test:e2e
```

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
- **Location**: GitHub Actions artifacts (named `e2e-test-results`)
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
- Plugin loading and initialization
- FIT sync command execution
- Notice system validation
- Screenshot capture workflow
