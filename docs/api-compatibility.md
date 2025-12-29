# API Compatibility & Dependency Safety

**Last Updated:** 2025-12-24

This document tracks Web APIs and patterns that may have compatibility issues across Obsidian's supported platforms (Desktop/Mobile) and provides guidelines for safe usage.

## Overview

FitPlugin runs in:
- **Desktop**: Electron environment (Chromium + Node.js APIs)
- **Mobile**: iOS/Android (WebView environment, NO Node.js APIs)

Obsidian updates Electron versions periodically, and users update sporadically. See [Obsidian Typings Electron Changelog](https://fevol.github.io/obsidian-typings/resources/electron-changelog/) for version history.

## Safe Web APIs in Use

### ✅ TextEncoder / TextDecoder (with `fatal` option)

**Status:** Safe - Available since January 2020

- **Usage:** [src/util/contentEncoding.ts:97](../src/util/contentEncoding.ts#L97), [src/util/obsidianHelpers.ts:50](../src/util/obsidianHelpers.ts#L50)
- **Browser support:** Chrome 38+, Safari 10.1+, Firefox 36+
- **Mobile:** Full support on iOS/Android WebView
- **Critical option:** `fatal: true` - Throws TypeError on invalid UTF-8 instead of silently inserting replacement characters (`U+FFFD`)
- **Obsidian compatibility:**
  - **Verified:** Works in Obsidian 1.4.13+ (Electron 25, September 2023)
  - **minAppVersion 1.4.0:** Likely safe (July 2023, Electron version unclear but TextDecoder widely supported since 2018)
  - **Risk:** LOW - TextDecoder with `fatal` option standardized before Obsidian 1.0 (October 2022)

**Example:**
```typescript
// SAFE: Throws on invalid UTF-8, prevents silent data corruption
const text = new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
```

**Documentation:**
- [MDN: TextDecoder](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder)
- [MDN: fatal property](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/fatal)

### ✅ atob() / btoa()

**Status:** Safe - Widely available

- **Usage:** [src/util/contentEncoding.ts:92](../src/util/contentEncoding.ts#L92)
- **Browser support:** Universal
- **Note:** Only handles Latin1 strings, use with TextEncoder/TextDecoder for UTF-8

### ✅ Obsidian API Functions

**Status:** Safe - Cross-platform guaranteed by Obsidian

- `arrayBufferToBase64()` - [src/util/obsidianHelpers.ts:9](../src/util/obsidianHelpers.ts#L9)
- `base64ToArrayBuffer()` - [src/util/obsidianHelpers.ts:5](../src/util/obsidianHelpers.ts#L5)
- `Vault.readBinary()` - Always use this instead of `vault.read()` for reliable binary detection

## Unsafe Patterns to Avoid

### ❌ Node.js APIs (Desktop Only)

**NEVER use Node.js built-ins** - they break on mobile:

```typescript
// ❌ BREAKS ON MOBILE
const fs = require('fs');
const { TextDecoder } = require('util');  // Node's TextDecoder != Browser's TextDecoder
const Buffer = require('buffer');
```

**Why:** Obsidian mobile doesn't include Node.js runtime.

**Alternative:** Use Web APIs (TextEncoder, TextDecoder, Blob, etc.) or Obsidian's platform abstractions.

### ❌ TextDecoder without `fatal: true`

**DANGEROUS:** Silently corrupts binary data

```typescript
// ❌ DANGEROUS: Silently creates replacement characters for invalid UTF-8
const text = new TextDecoder().decode(binaryData);
// Result: "����JFIF��..." - original bytes are LOST

// ✅ SAFE: Throws TypeError if data isn't valid UTF-8
const text = new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
```

**Current enforcements:**
- [src/util/contentEncoding.ts:97](../src/util/contentEncoding.ts#L97) - Enforced in `decodeFromBase64()`
- [src/util/obsidianHelpers.ts:54](../src/util/obsidianHelpers.ts#L54) - Enforced in `readFileContent()`

### ❌ Obsidian `vault.read()` for Binary Detection

**UNRELIABLE:** May succeed on binary files (platform-dependent)

```typescript
// ❌ UNRELIABLE: May return corrupted string on iOS
const content = await vault.read(file);

// ✅ RELIABLE: Always read as binary first, then detect via null bytes
const arrayBuffer = await vault.readBinary(file);
const hasNullByte = new Uint8Array(arrayBuffer).some(b => b === 0);
```

**Issue:** Issue #156 - `vault.read()` succeeded on JPEG files on iOS, returning corrupted text.

**Fix:** [src/util/obsidianHelpers.ts:26-60](../src/util/obsidianHelpers.ts#L26-L60) - Always use `readBinary()` + null byte heuristic

### ⚠️ Reading Untracked Files (Hidden Files)

**Issue:** `vault.getAbstractFileByPath()` only returns files tracked in Obsidian's vault index

Hidden files (starting with `.`) are excluded from `vault.getFiles()` and aren't tracked in the index, so:

```typescript
// ❌ FAILS for hidden files: Returns null even when file exists
const file = vault.getAbstractFileByPath('.hidden');
// file === null, even though .hidden exists on disk

// ✅ WORKS: stat() and adapter.readBinary() can see all filesystem files
const stat = await vault.adapter.stat('.hidden');  // Returns {type: 'file', ...}
const content = await vault.adapter.readBinary('.hidden');  // Reads successfully
```

**When to use adapter APIs:**
- Reading files that may not be in Obsidian's index (e.g., hidden files for baseline SHA comparison)
- Checking file existence on filesystem independent of Obsidian's tracking

**Best practice:** Try indexed read first (faster), fall back to adapter:

```typescript
// Try indexed read first (faster when available)
const file = vault.getAbstractFileByPath(path);
if (file && file instanceof TFile) {
    return readFileContent(vault, path);  // Standard path
}

// File not in index - use adapter (handles hidden files)
const arrayBuffer = await vault.adapter.readBinary(path);
// ... decode as needed
```

**Example:** [src/localVault.ts:310-340](../src/localVault.ts#L310-L340) - `readFileContentDirect()` implements this pattern

**Related:** Issue #169 - Baseline tracking for untracked files requires reading hidden files for SHA comparison

## Automated Validation (TODO)

Currently, compatibility issues are caught by:
1. ✅ **CI test matrix** - Detects missing Node.js APIs at runtime
2. ⚠️ **Manual code review** - Detects unsafe patterns

### Future Improvements

**TODO:** Add eslint rule to detect Node.js imports:
```javascript
// .eslintrc.js
rules: {
  'no-restricted-imports': ['error', {
    patterns: ['util', 'fs', 'path', 'buffer', 'stream']
  }]
}
```

**TODO:** Add eslint rule to detect TextDecoder without fatal:
```javascript
// Custom rule to enforce `fatal: true` in TextDecoder constructor
// Pattern: new TextDecoder() or new TextDecoder('utf-8')
// Should require: new TextDecoder('utf-8', { fatal: true })
```

**TODO:** Add CI check for Electron/Chromium minimum version assumptions:
- Document minimum Electron version supported
- Add test to verify APIs used are available in that version
- Reference: [Can I Use TextEncoder](https://caniuse.com/textencoder)

## Known Electron Compatibility Issues

### TextDecoder Global Shadowing (Electron Renderer)

**Issue:** In Electron, browser's `TextDecoder` may shadow Node's `util.TextDecoder`

**Impact:** Low - We use browser global, which is correct for our use case

**Reference:** [electron/electron#18733](https://github.com/electron/electron/issues/18733)

**Resolution:** No action needed - we explicitly use browser API, not Node API

## Testing Strategy

### Current Coverage

- ✅ Binary detection via `fatal: true` ([src/localVault.test.ts:206-221](../src/localVault.test.ts#L206-L221))
- ✅ Base64 encoding/decoding round-trips ([src/util/contentEncoding.test.ts](../src/util/contentEncoding.test.ts))
- ✅ Large file handling (multi-MB text) ([src/util/contentEncoding.test.ts:45-70](../src/util/contentEncoding.test.ts#L45-L70))
- ✅ Implicit `fatal: true` validation - Tests pass on binary files, confirming exception handling works

### Missing Coverage (TODO)

**TODO:** Add explicit test for `fatal: true` throwing on binary data:
```typescript
it('should throw when decoding binary data with fatal:true', () => {
  const binaryData = new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]); // JPEG header
  const decoder = new TextDecoder('utf-8', { fatal: true });
  expect(() => decoder.decode(binaryData)).toThrow(TypeError);
});
```

**TODO:** Verify minAppVersion 1.4.0 compatibility
- Test on Obsidian 1.4.0 installer (July 2023) if possible
- Verify TextDecoder `fatal` option works on that Electron version
- Risk is LOW (API standardized 2018+) but explicit verification preferred

**TODO:** Add test for cross-platform compatibility (if mobile CI available)

## References

### Web API Documentation

- [TextEncoder & TextDecoder Browser Support](https://caniuse.com/textencoder)
- [MDN: TextDecoder Constructor](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/TextDecoder)
- [MDN: atob() Unicode Handling](https://developer.mozilla.org/en-US/docs/Web/API/atob#unicode_strings)

### Obsidian-Specific

- [Obsidian Changelog](https://obsidian.md/changelog/)
- [Obsidian Typings Electron Changelog](https://fevol.github.io/obsidian-typings/resources/electron-changelog/)
- [Obsidian Forum: Electron Version Discussion](https://forum.obsidian.md/t/electron-version-as-of-v-13-30-13-31/33712)

### Related Issues

- Issue #156 - Binary file corruption from `vault.read()` succeeding on JPEGs
- Issue #51 - UTF-8 to GBK encoding corruption (Turkish characters)
- PR #161 - Initial binary detection fix (had false positives on iOS)
