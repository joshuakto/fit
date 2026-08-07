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
 * Future extension points (tracked in #337 — .fitattributes):
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
	 * (deferred to #337 — .fitattributes).
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
 * @param baseText   - Base file content (content at last sync); null if unavailable
 * @param localText  - Local file content (UTF-8 JSON string)
 * @param remoteText - Remote file content (UTF-8 JSON string)
 * @param spec       - Merge spec describing keyed arrays and exclusions
 * @returns MergeResult: merged value on success, or reason for failure
 *
 * When baseText is null, one-sided key/array presence is treated as unknown-intent
 * and falls back to merged:false (conservative). When baseText is provided, the
 * base is used to distinguish additions from deletions.
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

	let base: unknown = null;
	if (baseText !== null) {
		try {
			base = JSON.parse(baseText);
		} catch {
			base = null; // unparseable base → fall back to no-base behaviour
		}
	}

	if (typeof local !== 'object' || local === null || Array.isArray(local)) {
		return { merged: false, reason: 'local JSON root is not an object' };
	}
	if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) {
		return { merged: false, reason: 'remote JSON root is not an object' };
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
 * - Keys present in only one side:
 *   - base provided: check whether the absent side deleted it or the present side added it
 *   - base null: unknown intent → conflict (conservative)
 */
function mergeObjects(
	base: Record<string, unknown> | null,
	local: Record<string, unknown>,
	remote: Record<string, unknown>,
	spec: JsonMergeSpec,
): MergeResult {
	const result: Record<string, unknown> = {};
	const allKeys = new Set([
		...Object.keys(local),
		...Object.keys(remote),
		...(base ? Object.keys(base) : []),
	]);

	for (const key of allKeys) {
		if (Object.prototype.hasOwnProperty.call(spec.keyedArrays, key)) continue; // handled below

		const inLocal = Object.prototype.hasOwnProperty.call(local, key);
		const inRemote = Object.prototype.hasOwnProperty.call(remote, key);

		if (inLocal && inRemote) {
			if (!deepEqual(local[key], remote[key])) {
				return { merged: false, reason: `conflicting values for key "${key}"` };
			}
			result[key] = remote[key];
		} else if (inLocal !== inRemote) {
			// One side has the key, the other doesn't
			if (base === null) {
				// Can't distinguish addition from deletion without base
				return { merged: false, reason: `ambiguous one-sided presence of key "${key}" (no base available)` };
			}
			const inBase = Object.prototype.hasOwnProperty.call(base, key);
			if (!inBase) {
				// Key is new on one side → addition, include it
				result[key] = inLocal ? local[key] : remote[key];
			} else if (inLocal) {
				// Remote deleted it, local kept it → conflict
				return { merged: false, reason: `remote deleted key "${key}" but local still has it` };
			} else {
				// Local deleted it, remote kept it → conflict
				return { merged: false, reason: `local deleted key "${key}" but remote still has it` };
			}
		}
		// key in neither local nor remote (was in base, both deleted) → omit from result
	}

	for (const [path, idKey] of Object.entries(spec.keyedArrays)) {
		// Only root-level paths supported for now (no dot-navigation needed yet)
		const key = path;
		const localArr = local[key];
		const remoteArr = remote[key];
		const baseArr = base?.[key];

		const localHas = Array.isArray(localArr);
		const remoteHas = Array.isArray(remoteArr);

		if (!localHas && !remoteHas) continue;

		if (localHas !== remoteHas) {
			// One side missing the array entirely
			if (base === null) {
				return { merged: false, reason: `ambiguous one-sided presence of array "${key}" (no base available)` };
			}
			const baseHas = Array.isArray(baseArr);
			if (!baseHas) {
				// New on one side → addition
				result[key] = localHas ? localArr : remoteArr;
			} else {
				// One side deleted the array entirely → conflict
				return { merged: false, reason: `one side deleted array "${key}" entirely` };
			}
			continue;
		}

		const arrayResult = mergeKeyedArrays(
			localArr as unknown[],
			remoteArr as unknown[],
			Array.isArray(baseArr) ? baseArr as unknown[] : undefined,
			idKey,
		);
		if (!arrayResult.ok) {
			return { merged: false, reason: `conflicting edits to element with ${idKey}=${String(arrayResult.conflictId)} in "${key}"` };
		}
		result[key] = arrayResult.value;
	}

	return { merged: true, value: result };
}

/**
 * Merge two arrays as id-keyed sets with optional three-way resolution.
 *
 * Remote order is preserved. Local-only items (ids absent from remote) are appended.
 * For same-id items with differing content, three-way resolution is attempted when
 * base is available: if only one side changed, that side wins; if both changed, conflict.
 * With no base, any same-id difference is a conflict (two-way fallback).
 *
 * Items without the id key field are kept from remote only (conservative).
 */
function mergeKeyedArrays(
	local: unknown[],
	remote: unknown[],
	base: unknown[] | undefined,
	idKey: string,
): ArrayMergeResult {
	const hasId = (item: unknown): item is Record<string, unknown> =>
		isObject(item) && Object.prototype.hasOwnProperty.call(item, idKey);

	const localById = new Map<unknown, unknown>();
	for (const item of local) {
		if (hasId(item)) localById.set(item[idKey], item);
	}

	const baseById = new Map<unknown, unknown>();
	if (base !== undefined) {
		for (const item of base) {
			if (hasId(item)) baseById.set(item[idKey], item);
		}
	}

	const seenIds = new Set<unknown>();
	const result: unknown[] = [];

	for (const remoteItem of remote) {
		if (!hasId(remoteItem)) { result.push(remoteItem); continue; }
		const id = remoteItem[idKey];
		seenIds.add(id);
		const localItem = localById.get(id);
		if (localItem === undefined || deepEqual(localItem, remoteItem)) {
			result.push(remoteItem);
			continue;
		}
		// Same id, different content — attempt three-way resolution
		const baseItem = baseById.get(id);
		if (baseItem !== undefined) {
			if (deepEqual(baseItem, remoteItem)) { result.push(localItem); continue; } // remote unchanged → local wins
			if (deepEqual(baseItem, localItem))  { result.push(remoteItem); continue; } // local unchanged → remote wins
		}
		return { ok: false, conflictId: id }; // no base or genuine divergence
	}

	for (const item of local) {
		if (!hasId(item)) continue;
		if (!seenIds.has(item[idKey])) result.push(item);
	}

	return { ok: true, value: result };
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
