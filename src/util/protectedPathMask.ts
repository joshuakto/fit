/**
 * git-as-mask extraction/overlay for `scope: "subset"` `.obsidian/` JSON paths.
 *
 * The git-tracked blob AT THE PATH'S OWN LOCATION is the mask: whatever top-level
 * keys are present in it are the tracked fields. Everything else in the real local
 * file (device-local state, fields no device tracks) is never read for push, and
 * never touched by pull. There is no separate shadow file — the real path's git
 * content IS the masked subset.
 *
 * Design notes: docs/sync-logic.md § `.fitattributes.json` (#337)
 * Wired into sync: src/fitSync.ts (syncSubsetScopePaths)
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type JsonParseResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: string };

export function parseJsonObject(text: string): JsonParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	if (!isPlainObject(parsed)) {
		return { ok: false, error: 'root value must be a JSON object' };
	}
	return { ok: true, value: parsed };
}

/**
 * Extraction (push direction): project local's current values for exactly the
 * tracked fields, dropping everything else. Result is pushed as-is — it's the
 * full intended git blob content, not an overlay onto anything, because the git
 * blob at a subset-scope path only ever contains tracked fields to begin with.
 *
 * A tracked field absent from the local file is simply omitted from the result
 * (not an error) — e.g. a field this device has never populated.
 */
export function extractMask(localFullText: string, trackedFields: string[]): JsonParseResult {
	const local = parseJsonObject(localFullText);
	if (!local.ok) return local;
	const projected: Record<string, unknown> = {};
	for (const field of trackedFields) {
		// hasOwnProperty, not `in`: `in` also sees inherited Object.prototype members
		// (constructor, toString, ...) as "present" even when absent as an own key.
		if (Object.prototype.hasOwnProperty.call(local.value, field)) projected[field] = local.value[field];
	}
	return { ok: true, value: projected };
}

/**
 * Overlay (pull direction / clash-preview reconstruction): merge incoming tracked
 * field values into the real local file, by key, leaving every other local key —
 * including untracked fields and device-local state — untouched.
 *
 * `localFullText === null` (path doesn't exist locally yet) starts from `{}`, so
 * the result is exactly the tracked fields — correct for first-pull file creation.
 */
export function overlayMask(localFullText: string | null, trackedValues: Record<string, unknown>): JsonParseResult {
	const base = localFullText === null ? { ok: true as const, value: {} } : parseJsonObject(localFullText);
	if (!base.ok) return base;
	return { ok: true, value: { ...base.value, ...trackedValues } };
}
