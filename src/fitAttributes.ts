/**
 * .fitattributes.json recipe schema: parsing and validation only.
 * Design notes + rationale: docs/sync-logic.md § `.fitattributes.json` (#337)
 *
 * A path's presence here does NOT opt it into sync — the trigger is git, not
 * FIT. A path becomes tracked purely because content for it exists in the
 * remote git tree; this file only modulates how an already-tracked path is
 * handled (merge hints, whole-file text-mode designation). A rule for a path
 * with no remote content is inert.
 *
 * TODO(#337): field-level JSON masking (which fields within a tracked JSON
 * path actually move) is a later change, not this module.
 */

import { hasExtension } from '@/util/filePath';

export interface FitAttributeRule {
	/**
	 * "text": opts this tracked path into whole-file sync — full content
	 * replace, ordinary `_fit/` clash on both-sides-changed, no merge attempt
	 * yet. Required for any non-JSON tracked path (e.g. .obsidian/snippets/
	 * *.css) to actually sync; without it, a tracked non-JSON path is
	 * detected/logged but never read or written.
	 * "json": opts this tracked path into structural JSON merge (src/util/jsonMerge.ts)
	 * instead of whole-file opaque replace — concurrent edits to different keys (or,
	 * for `.canvas`, different id-keyed array elements) merge automatically instead of
	 * clashing to `_fit/`. For a protected `.obsidian/` path, `format: "json"` alone is
	 * incomplete — pair it with an explicit `scope` (see below) to actually activate it.
	 */
	format?: 'json' | 'text';
	/**
	 * "full": every key syncs, no field-level masking.
	 * "subset": syncs only the top-level keys currently present in the tracked git blob
	 * at this path — every other local key (device-local state) is left untouched,
	 * never read for push, never overwritten by pull. The tracked field set comes purely
	 * from remote git content — a device can't add a newly-tracked field on its own,
	 * only pick up one that already exists in git. Default for a protected `.obsidian/`
	 * json path when unspecified.
	 */
	scope?: 'full' | 'subset';
}

/**
 * Path → rule. Presence as a key here configures how a path is handled *if*
 * it is independently tracked (has remote git content) — it never causes
 * tracking by itself.
 */
export type FitAttributesFile = Record<string, FitAttributeRule>;

export const FITATTRIBUTES_PATH = '.fitattributes.json';

/**
 * Filetype extensions whose sync format is detectable without an explicit
 * .fitattributes.json entry — a tracked `.obsidian/` path with no explicit config
 * falls back to this instead of staying detection-only. .css is the original
 * motivating case (#358, CSS snippets); .md/.txt are the same "plainly plaintext,
 * no reason to require boilerplate config" reasoning, same as how ordinary
 * (non-`.obsidian/`) files of these types are already always treated as text.
 */
const HEURISTIC_TEXT_EXTENSIONS = ['.css', '.md', '.txt'];

/**
 * Filetype extensions whose sync format defaults to structural JSON merge
 * (src/util/jsonMerge.ts) — applied uniformly, protected `.obsidian/` paths
 * included. `.canvas` was already always merged this way (hardcoded in
 * fitSync.ts before this became a general filetype default); plain `.json`
 * files get the same treatment.
 */
const HEURISTIC_JSON_EXTENSIONS = ['.json', '.canvas'];

/**
 * The sync format a path's filetype implies on its own, with no `.fitattributes.json`
 * entry — `null` if unknown (stays detection-only until explicitly configured).
 * Applied the same way for every path, protected or not: `.json`/`.canvas` default to
 * `"json"` (structural merge), `.css`/`.md`/`.txt` default to `"text"`.
 */
export function detectSyncFormat(path: string): FitAttributeRule['format'] | null {
	if (HEURISTIC_JSON_EXTENSIONS.some(ext => hasExtension(path, ext))) return 'json';
	if (HEURISTIC_TEXT_EXTENSIONS.some(ext => hasExtension(path, ext))) return 'text';
	return null;
}

/**
 * Pure form of Fit.resolveSyncFormat/resolveScope — takes a rule set instead of
 * reading `this.fitAttributes`, so the same resolution logic applies to a rule
 * set parsed from *either* side of a sync (local's live config, or remote's
 * currently-fetched .fitattributes.json blob). See docs/sync-logic.md §
 * Cross-device rule disagreement.
 */
export function resolveSyncFormat(path: string, rules: FitAttributesFile): FitAttributeRule['format'] | null {
	const configuredFormat = rules[path]?.format;
	return configuredFormat ?? detectSyncFormat(path);
}

/** Pure form of Fit.resolveScope — see resolveSyncFormat above. */
export function resolveScope(path: string, rules: FitAttributesFile): FitAttributeRule['scope'] | null {
	const configuredScope = rules[path]?.scope;
	if (configuredScope) return configuredScope;
	if (!path.startsWith(".obsidian/")) return "full";
	const format = resolveSyncFormat(path, rules);
	if (format === "text") return "full";
	if (format === "json") return "subset";
	return null;
}

export type ParseFitAttributesResult =
	| { ok: true; value: FitAttributesFile }
	| { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRule(path: string, rawRule: unknown): { ok: true; rule: FitAttributeRule } | { ok: false; error: string } {
	if (!isPlainObject(rawRule)) {
		return { ok: false, error: `rule for "${path}" must be an object` };
	}

	let format: 'json' | 'text' | undefined;
	if ('format' in rawRule && rawRule.format !== undefined) {
		if (rawRule.format !== 'json' && rawRule.format !== 'text') {
			return { ok: false, error: `rule for "${path}": "format" must be "json" or "text" if present` };
		}
		format = rawRule.format;
	}

	let scope: 'full' | 'subset' | undefined;
	if ('scope' in rawRule && rawRule.scope !== undefined) {
		if (rawRule.scope !== 'full' && rawRule.scope !== 'subset') {
			return { ok: false, error: `rule for "${path}": "scope" must be "full" or "subset" if present` };
		}
		scope = rawRule.scope;
	}

	const rule: FitAttributeRule = {};
	if (format) rule.format = format;
	if (scope) rule.scope = scope;
	return { ok: true, rule };
}

/**
 * Parses and validates .fitattributes.json content. Never throws — malformed
 * input (bad JSON, non-object root, invalid rule shape) is reported via the
 * `ok: false` branch so the caller (Fit) can surface it loudly instead of
 * silently treating it as "nothing configured".
 */
export function parseFitAttributes(text: string): ParseFitAttributesResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}

	if (!isPlainObject(parsed)) {
		return { ok: false, error: 'root value must be a JSON object mapping paths to rules' };
	}

	// TODO(#337): one invalid rule currently invalidates the entire file — every
	// .obsidian/ path stops syncing until the single bad entry is fixed, even if every
	// other rule is well-formed. Should be strict per-rule (an invalid rule is dropped/
	// treated as unconfigured for just that path) but loose at the file level (other
	// valid entries keep working) — see docs/sync-logic.md § .fitattributes.json (#337)
	// "Malformed .fitattributes.json". Not changed yet: needs a way to surface a
	// per-path warning (not just the current file-wide Fit.fitAttributesWarning) so a
	// silently-dropped rule doesn't become a *silently* silently-dropped rule.
	const value: FitAttributesFile = {};
	for (const [path, rawRule] of Object.entries(parsed)) {
		const result = validateRule(path, rawRule);
		if (!result.ok) return result;
		value[path] = result.rule;
	}

	return { ok: true, value };
}
