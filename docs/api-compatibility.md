# API Compatibility & Dependency Safety

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

**⚠️ CRITICAL: Avoid spread operator with large Uint8Arrays**

```typescript
// ❌ STACK OVERFLOW for arrays > ~128KB
const str = String.fromCharCode(...uint8Array);

// ✅ SAFE: Use Array.from or iterate
const str = Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
```

**Why:** JavaScript engines limit function arguments (~128,000). Spreading large arrays exceeds this limit, causing "Maximum call stack size exceeded" errors. This applies to ANY function call with spread on large arrays, not just `String.fromCharCode()`.

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
// Note: wrap in try-catch to handle file-not-found and I/O errors
const arrayBuffer = await vault.adapter.readBinary(path);
// ... decode as needed
```

**Example:** [src/localVault.ts:310-340](../src/localVault.ts#L310-L340) - `readFileContentDirect()` implements this pattern

**Related:** Issue #169 - Baseline tracking for untracked files requires reading hidden files for SHA comparison

## Automated Validation

Compatibility issues are caught mechanically by:
1. ✅ **ESLint rules for plugin source** (`eslint.config.js`, `src/**` excluding tests), each checked by a snippet test in [src/apiCompatibility.test.ts](../src/apiCompatibility.test.ts):
   - `no-restricted-globals`: `Buffer`, `require`, `process`
   - `no-restricted-imports` and a dynamic-`import()` selector: every Node built-in, with or without the `node:` prefix
   - `new TextDecoder()` must pass a literal `{ fatal: true }`
   - no spreading into `String.fromCharCode(...)` (stack overflow on large arrays)
   - no `vault.read()` / `vault.cachedRead()` (use `readBinary()`, or `adapter.read()` for non-indexed paths)
2. ✅ **Bundle check** (same test file): the plugin entry point is bundled for a browser target, with Node built-ins resolvable nowhere, so a transitive dependency pulling one in fails the test. The real build marks built-ins external, which would hide such an import until it fails on mobile.
3. ✅ **CI test matrix** - Detects missing Node.js APIs at runtime
4. ⚠️ **Manual code review** - Catches everything else (for example Node-only globals other than the three above, or runtime behavior that differs per platform)

### Desktop-only exceptions

None exist today, and an exception is a special case, not a convenience. It is acceptable only when the Node access is loaded conditionally and is load-bearing in exactly the situations where the API exists, so the fallbacks cover every other case:

- It is never reached at module load, only lazily, behind a gate that is false on mobile (an `instanceof FileSystemAdapter` check).
- Everything it enables degrades gracefully without it: the feature is skipped or reports "unsupported", and nothing else depends on its result.
- Every failure path (API absent, module fails to resolve, call throws) takes that same fallback.

Real symlink detection is the motivating example, since `DataAdapter` cannot do it. Isolate such code in one module, then allow that one file in both mechanical checks, instead of adding inline disables:

1. In `eslint.config.js`, add a per-file block after the `src/**` block (see the comment there).
2. In `src/apiCompatibility.test.ts`, let the bundle check treat built-ins as external only when imported from that file.
3. List the file and the modules it may use here.

Use `require('fs')` for the load: in Obsidian's renderer a bare `import('fs')` is left as a native dynamic import and fails to resolve, while `require` works.

### Remaining TODOs

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
