/**
 * Semantic JSON merge for Fit sync.
 *
 * Merges two JSON values using a {@link JsonMergeSpec} that describes which
 * array paths are id-keyed sets (unordered, merged by identity key) and which
 * paths are excluded from sync entirely. Everything else is last-write-wins
 * (remote wins on conflict).
 *
 * Entry point: {@link mergeJson}
 * Canvas default spec: {@link CANVAS_MERGE_SPEC}
 *
 * Design notes: docs/sync-logic.md § Semantic JSON Merge
 *
 * Future extension points (tracked in .fitattributes FR):
 * - Order-significance selectors (opt arrays IN to ordered/index-based merge)
 * - Field exclusion selectors (ignore specific JSON paths during comparison)
 * - Text-mode policy (always-local, always-remote, clash) for non-JSON files
 */

/**
 * Describes how to merge a specific JSON structure.
 *
 * - `keyedArrays`: dot-notation paths to arrays that should be merged as
 *   id-keyed sets. Each entry names the identity key field (e.g. "id").
 *   Remote order is preserved; local-only items are appended.
 *   Per-element conflict (same key, different content): remote wins.
 */
export interface JsonMergeSpec {
	/**
	 * Map of dot-notation JSON path → identity key field name.
	 * Example: { "nodes": "id", "edges": "id" }
	 *
	 * Paths are relative to the root object. Nested paths not yet supported
	 * (deferred to .fitattributes implementation).
	 */
	keyedArrays: Record<string, string>;
}

/** Result of a merge operation. */
export type MergeResult =
	| { merged: true; value: unknown }
	| { merged: false; reason: string };

/**
 * Merge two JSON strings using the given spec.
 *
 * @param localText  - Local file content (UTF-8 JSON string)
 * @param remoteText - Remote file content (UTF-8 JSON string)
 * @param spec       - Merge spec describing keyed arrays and exclusions
 * @returns MergeResult: merged JSON string on success, or reason for failure
 */
export function mergeJson(
	baseText: string | null,
	localText: string,
	remoteText: string,
	spec: JsonMergeSpec,
): MergeResult {
	let local: unknown;
	let remote: unknown;
	try {
		local = JSON.parse(localText);
	} catch {
		return { merged: false, reason: 'local content is not valid JSON' };
	}
	try {
		remote = JSON.parse(remoteText);
	} catch {
		return { merged: false, reason: 'remote content is not valid JSON' };
	}

	if (typeof local !== 'object' || local === null || Array.isArray(local)) {
		return { merged: false, reason: 'local JSON root is not an object' };
	}
	if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) {
		return { merged: false, reason: 'remote JSON root is not an object' };
	}

	let base: unknown = null;
	if (baseText !== null) {
		try { base = JSON.parse(baseText); } catch { /* unparseable base → no-base behaviour */ }
	}
	const baseObj = (typeof base === 'object' && base !== null && !Array.isArray(base))
		? base as Record<string, unknown>
		: null;

	return mergeObjects(
		baseObj,
		local as Record<string, unknown>,
		remote as Record<string, unknown>,
		spec,
	);
}

type ArrayMergeResult =
	| { ok: true; value: unknown[] }
	| { ok: false; conflictId: unknown };

/**
 * Merge two JSON objects.
 * - Keys in spec.keyedArrays → id-keyed set merge
 * - Other keys present in both, equal → include unchanged
 * - Other keys present in both, different → conflict (merged: false); no silent data loss
 * - Keys/arrays present on only one side → conflict (no base available to distinguish addition from deletion)
 *   Base-aware three-way resolution is implemented in the next PR (powpvpwx).
 */
function mergeObjects(
	base: Record<string, unknown> | null,
	local: Record<string, unknown>,
	remote: Record<string, unknown>,
	spec: JsonMergeSpec,
): MergeResult {
	const result: Record<string, unknown> = {};
	const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);

	for (const key of allKeys) {
		if (key in spec.keyedArrays) continue; // handled below

		const inLocal = key in local;
		const inRemote = key in remote;

		if (inLocal && inRemote) {
			if (!deepEqual(local[key], remote[key])) {
				return { merged: false, reason: `conflicting values for key "${key}"` };
			}
			result[key] = remote[key];
		} else if (inLocal !== inRemote) {
			return { merged: false, reason: `ambiguous one-sided presence of key "${key}" (no merge base available)` };
		}
	}

	for (const [path, idKey] of Object.entries(spec.keyedArrays)) {
		// Only root-level paths supported for now (no dot-navigation needed yet)
		const key = path;
		const localArr = local[key];
		const remoteArr = remote[key];

		if (!Array.isArray(remoteArr) && !Array.isArray(localArr)) continue;
		if (!Array.isArray(remoteArr) || !Array.isArray(localArr)) {
			return { merged: false, reason: `ambiguous one-sided presence of array "${key}" (no merge base available)` };
		}

		const arrayResult = mergeKeyedArrays(localArr, remoteArr, idKey);
		if (!arrayResult.ok) {
			return { merged: false, reason: `conflicting edits to element with ${idKey}=${String(arrayResult.conflictId)} in "${key}"` };
		}
		result[key] = arrayResult.value;
	}

	return { merged: true, value: result };
}

/**
 * Merge two arrays as id-keyed sets.
 *
 * Algorithm:
 * 1. Start with remote array in remote order
 * 2. Append local-only items (items whose id key is absent from remote)
 * 3. If same id exists in both but content differs → conflict (caller falls back to clash file)
 *
 * Items without the id key field are kept from remote only (conservative).
 */
function mergeKeyedArrays(
	local: unknown[],
	remote: unknown[],
	idKey: string,
): ArrayMergeResult {
	const remoteById = new Map<unknown, unknown>();
	for (const item of remote) {
		if (isObject(item) && idKey in item) {
			remoteById.set((item as Record<string, unknown>)[idKey], item);
		}
	}

	const localOnly: unknown[] = [];
	for (const item of local) {
		if (!isObject(item)) continue;
		const id = (item as Record<string, unknown>)[idKey];
		if (id === undefined) continue;
		if (!remoteById.has(id)) {
			localOnly.push(item);
		} else if (!deepEqual(item, remoteById.get(id))) {
			return { ok: false, conflictId: id };
		}
	}

	return { ok: true, value: [...remote, ...localOnly] };
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	if (Array.isArray(a) || Array.isArray(b)) return false;
	if (typeof a === 'object' && typeof b === 'object') {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const aKeys = Object.keys(ao);
		const bKeys = Object.keys(bo);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every(k => k in bo && deepEqual(ao[k], bo[k]));
	}
	return false;
}

/**
 * Serialises a merged value back to a JSON string.
 * Uses tab indentation to match Obsidian's canvas file format.
 */
export function serialiseMerged(value: unknown): string {
	return JSON.stringify(value, null, '\t');
}

/**
 * Default merge spec for Obsidian `.canvas` files.
 *
 * Canvas schema: { nodes: [{id, ...}], edges: [{id, ...}] }
 * Both arrays are id-keyed sets — element order is not meaningful
 * (position on the canvas is encoded in x/y fields, not array index).
 *
 * Unknown top-level keys (future canvas schema additions) fall through
 * to remote-wins, which is conservative and correct.
 */
export const CANVAS_MERGE_SPEC: JsonMergeSpec = {
	keyedArrays: {
		nodes: 'id',
		edges: 'id',
	},
};
