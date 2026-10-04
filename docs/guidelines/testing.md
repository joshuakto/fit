# Testing guidelines

Stack is Vitest + `src/__mocks__/obsidian.ts` (aliased as `'obsidian'` in `vitest.config.ts`). Reviewers, human and automated, apply these guidelines through [`rules/testing.md`](../../rules/testing.md), which points here.

- **One test = one thing.** Use parameterized tests for variations, not near-duplicate tests that hit the same line with a different magic number. If a *shipped default* also matters, assert it flows through unmodified (no override passed) rather than duplicating the same check with a second hardcoded constant.
- **Mock only true external boundaries** (Obsidian's API), not our own internal modules (`src/*.ts`). Mocking an internal collaborator only proves args were forwarded to it — it hides real bugs inside that collaborator instead of catching them.

  Bad — mocking `src/utils.ts`'s `showFileChanges` when testing `fitPlugin.ts`'s call site hides real bugs in `showFileChanges` itself and only proves args were forwarded:
  ```ts
  vi.mock('@/utils', () => ({ showFileChanges: vi.fn(), showUnappliedConflicts: vi.fn() }));
  // ...
  expect(showFileChanges).toHaveBeenCalledWith(changeGroups, expect.any(Map), 30000);
  ```
  Good — mock the real external boundary (`obsidian`'s `Notice`) and let `showFileChanges` run for real, so its own logic stays covered:
  ```ts
  const { NoticeCtor } = vi.hoisted(() => ({ NoticeCtor: vi.fn() }));
  vi.mock('obsidian', async (importOriginal) => {
  	const actual = await importOriginal<typeof import('obsidian')>();
  	class SpyNotice extends actual.Notice {
  		constructor(message: string, duration?: number) {
  			super(message, duration);
  			NoticeCtor(message, duration);
  		}
  	}
  	return { ...actual, Notice: SpyNotice };
  });
  // ...
  expect(NoticeCtor).toHaveBeenCalledWith('', 30000);
  ```
  See `src/fitPlugin.test.ts` describe block `'FitPlugin sync-success notice duration wiring'`.

- **Prefer fakes over mocks/spies for the vault boundary.** `FakeLocalVault`/`FakeRemoteVault` (`src/testUtils.ts`) are real, working implementations of the same `IVault` interface the production vaults implement. Driving a test through them and asserting on the resulting state (`getAllFilesAsRaw()`, `localStoreState`) exercises the real sync decision logic end-to-end. Spying on a fake's own method only proves a call happened, not that the resulting state is correct, and breaks on refactors that preserve behavior but change call shape — reserve spies for proving something was *not* called.
- **Test observable behavior, not internal bookkeeping.** Prefer asserting on what a caller actually observes — file content, the returned result, or a *later* sync's behavior — over an internal cache field. This matters especially for failure-injection tests: a fake vault's failure simulation already blocks the write, so "content unchanged right after the simulated failure" can pass identically whether or not the fix actually works. The assertion that distinguishes correct from buggy behavior is usually whether a *later* sync (after the failure is lifted) successfully retries.
- **Assert the whole result object, not one indexed field.** E.g. assert all of `getAllFilesAsRaw()`, not `getAllFilesAsRaw()['one/path']` — indexing into a single path proves that path is right but says nothing about whether an unrelated file was wrongly touched. Comment *why* each entry is present (or notably absent) inline, on its own line. This doesn't require a literal exact-value match — placeholder matchers (`expect.any(...)`, `expect.objectContaining(...)`, etc.) inside the whole-object assertion are fine; the point is covering every entry, not hardcoding every value.

  ```ts
  // Bad — only proves one path is right, says nothing about the other three:
  expect(localVault.getAllFilesAsRaw()['normal.md']).toBe('Normal file content');

  // Good — whole object, every entry's provenance documented on its own line. Absence is a
  // claim too — say it the same way, on its own comment-only line, where the key would sort:
  expect(localVault.getAllFilesAsRaw()).toEqual({
  	'_fit/conflict.md': 'Remote version saved locally', // Local-only (created in step 1)
  	'_fit/nested/file.md': 'Another conflict',          // Local-only (created in step 1)
  	'normal.md': 'Normal file content',                 // Synced (created in step 1)
  	// '_fit/remote-conflict.md' absent — remote pushed it in step 3, silently ignored (no _fit/_fit/ write)
  	'remote-normal.md': 'Normal remote file'            // Pulled from remote (step 4)
  });
  ```
  See `fitSync.realFit.test.ts` (`_fit/` conflict-preservation test).

- **Assert one complete value, not its pieces.** Prefer `toEqual(expect.objectContaining(...))` over several separate `expect(x.a)` / `expect(x.b)` calls on the same result, and over `toMatchObject` when a sibling field carries diagnostic info (e.g. `SyncResult`'s `success`/`error`) — splitting a logical check loses the full context (e.g. an unexpected `error` field) that would otherwise show up on failure.

  ```ts
  // Bad — two calls, and a failure on the first never shows what error actually happened:
  expect(result.success).toBe(true);
  expect(result.changeGroups).toContainEqual({ path: 'x', type: 'MODIFIED' });

  // Good — one assertion, failure output includes the whole result (error included if it failed):
  expect(result).toEqual(expect.objectContaining({
  	success: true,
  	changeGroups: expect.arrayContaining([{ path: 'x', type: 'MODIFIED' }]),
  }));
  ```

- **Scope-document each test file.** A short header comment stating what the file covers, and how it differs from siblings, saves readers from having to diff two similarly-named test files to find out.
