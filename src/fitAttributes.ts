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

export interface FitAttributeRule {
	/**
	 * "text": opts this tracked path into whole-file sync — full content
	 * replace, ordinary `_fit/` clash on both-sides-changed, no merge attempt
	 * yet. Required for any non-JSON tracked path (e.g. .obsidian/snippets/
	 * *.css) to actually sync; without it, a tracked non-JSON path is
	 * detected/logged but never read or written.
	 * "json": reserved, not yet implemented — will opt a path into
	 * field-level JSON masking once that lands.
	 */
	format?: 'json' | 'text';
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
 * The sync format a path's filetype implies on its own, with no `.fitattributes.json`
 * entry — `null` if unknown (stays detection-only until explicitly configured).
 * Mirrors how ordinary (non-`.obsidian/`) files are handled implicitly today: plain
 * text by default, `.canvas` a JSON-shaped special case (though that one is handled
 * entirely by its own merge-spec selection in fitSync.ts, not through this function —
 * ordinary files are always eligible regardless of detected format, only `.obsidian/`
 * paths gate on it via `Fit.isEligibleForTracking`).
 */
export function detectSyncFormat(path: string): FitAttributeRule['format'] | null {
	const lowerPath = path.toLowerCase();
	if (HEURISTIC_TEXT_EXTENSIONS.some(ext => lowerPath.endsWith(ext))) return 'text';
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

	const rule: FitAttributeRule = {};
	if (format) rule.format = format;
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

	const value: FitAttributesFile = {};
	for (const [path, rawRule] of Object.entries(parsed)) {
		const result = validateRule(path, rawRule);
		if (!result.ok) return result;
		value[path] = result.rule;
	}

	return { ok: true, value };
}
