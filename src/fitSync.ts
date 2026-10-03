import { Fit } from "./fit";
import { FileChange, FileClash, FileStates, compareFileStates, determineLocalChecksNeeded, resolveAllChanges, resolveUntrackedState } from "./util/changeTracking";
import { LocalStores } from "@/localStores";
import FitNotice from "./fitNotice";
import { SyncResult, SyncErrors, SyncError } from "./syncResult";
import { fitLogger } from "./logger";
import { ApplyChangesResult, VaultError } from "./vault";
import { Base64Content, FileContent } from "./util/contentEncoding";
import { detectNormalizationMismatches } from "./util/filePath";
import { BlobSha, CommitSha, computeGitBlobSha } from "./util/hashing";
import { LocalVault } from "./localVault";
import * as Encryption from "./encryption";
import { buildStatusExplanation, StatusExplanation, SyncStatusSnapshot } from '@/fitStatusExplainer';
import { mergeJson, mergeSpecForPath, GENERIC_JSON_MERGE_SPEC, serialiseMerged, MergeResult } from './util/jsonMerge';
import { tryLineMerge } from './util/lineMerge';
import { hasNullByte } from './util/obsidianHelpers';
import { extractMask, overlayMask, parseJsonObject } from './util/protectedPathMask';
import { UNIVERSAL_SECRET_FIELD_DENYLIST } from './util/protectedPaths';
import { isUnderAnyPrefix } from './util/filePath';
import { FitAttributesFile, FITATTRIBUTES_PATH, parseFitAttributes, resolveSyncFormat as resolveSyncFormatPure, resolveScope as resolveScopePure } from '@/fitAttributes';

/** Resolution outcome for one scope:"subset" path — see FitSync.resolveSubsetScopePath. */
type SubsetPathAction =
	| { path: string; kind: 'skip' }
	| { path: string; kind: 'in-sync'; trackedObj: Record<string, unknown>; rawLocalContent: string }
	| { path: string; kind: 'push'; trackedObj: Record<string, unknown>; rawLocalContent: string }
	| { path: string; kind: 'pull'; trackedObj: Record<string, unknown>; localFullContent: string; localOpType: 'ADDED' | 'MODIFIED' }
	| { path: string; kind: 'push-and-pull'; trackedObj: Record<string, unknown>; localFullContent: string }
	| { path: string; kind: 'clash'; previewContent: string }
	| { path: string; kind: 'delete' };

/**
 * Deterministic JSON serialization for masked-view SHA comparisons only — never
 * compared against a real git blob SHA, so it doesn't need to match git's own
 * serialization, just be stable across calls regardless of source key order.
 *
 * Recurses to sort keys at every nesting level. `JSON.stringify(obj, Object.keys(obj).sort())`
 * looks equivalent but isn't: an array replacer is applied at every level of the object, not
 * just the top level, so a nested object's own keys get filtered against the *top-level* key
 * list and silently dropped (`JSON.stringify({a:{x:1}}, ['a'])` → `'{"a":{}}'`).
 */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const entries = Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value);
}

// Helper to log SHA cache updates with provenance tracking
function logCacheUpdate(
	source: string,
	oldLocalShas: FileStates,
	newLocalShas: FileStates,
	oldRemoteShas: FileStates,
	newRemoteShas: FileStates,
	oldCommitSha: CommitSha | null | undefined,
	newCommitSha: CommitSha,
	extraContext?: Record<string, unknown>
) {
	const oldLocalCount = Object.keys(oldLocalShas).length;
	const newLocalCount = Object.keys(newLocalShas).length;
	const localShasAdded = Object.keys(newLocalShas).filter(k => !oldLocalShas[k]);
	const localShasRemoved = Object.keys(oldLocalShas).filter(k => !newLocalShas[k]);
	const warnings: string[] = [];

	// Warn if cache went from non-empty to empty (possible data loss)
	if (oldLocalCount > 0 && newLocalCount === 0) {
		warnings.push(`Local SHA cache dropped from ${oldLocalCount} to 0 files - possible data corruption`);
	}

	// Warn if large number of files suddenly appeared (possible cache was cleared then repopulated)
	if (oldLocalCount === 0 && newLocalCount > 10) {
		warnings.push(`Local SHA cache jumped from 0 to ${newLocalCount} files - possible recovery from empty cache or first sync`);
	}

	const totalChanges = localShasAdded.length + localShasRemoved.length +
		Object.keys(newRemoteShas).filter(k => !oldRemoteShas[k]).length +
		Object.keys(oldRemoteShas).filter(k => !newRemoteShas[k]).length;

	if (totalChanges > 0 || oldCommitSha !== newCommitSha || warnings.length > 0) {
		fitLogger.log(`.. 📦 [Cache] Updating SHA cache after ${source}`, {
			localChanges: localShasAdded.length + localShasRemoved.length,
			remoteChanges: Object.keys(newRemoteShas).filter(k => !oldRemoteShas[k]).length + Object.keys(oldRemoteShas).filter(k => !newRemoteShas[k]).length,
			commitChanged: oldCommitSha !== newCommitSha,
			...(warnings.length > 0 && { warnings }),
			...extraContext
		});
	}
}

/**
 * Interface for the sync orchestrator.
 *
 * FitSync is the high-level coordinator for all sync operations between local
 * vault and remote GitHub repository. It's the main entry point for triggering
 * sync and handles all the decision logic about what type of sync to perform.
 *
 * @see FitSync - The concrete implementation
 */
export interface IFitSync {
	fit: Fit;
	explainStatus(): Promise<StatusExplanation>;
}

/**
 * Result of sync execution (Phase 3) including operations applied and any conflicts.
 *
 * Returned by executeSync() after pushing local changes, pulling remote changes,
 * and persisting state. The `conflicts` field contains clashes that were written to _fit/.
 */
type SyncExecutionResult = {
	/** Operations applied to local vault (from remote changes) */
	localOps: FileChange[];
	/** Operations applied to remote (from local changes) */
	remoteOps: FileChange[];
	/** Unresolved conflicts (context-dependent: new conflicts or all conflicts) */
	conflicts: FileClash[];
	/** Paths freshly added to unpushedFiles this sync (not previously known) */
	newlySkippedPaths: string[];
	/** Pre-built first-encounter notice for newly skipped files */
	skippedWarning?: string;
	/** Paths not uploaded due to a transient failure (localShas cleared so they retry next sync) */
	rateLimitedPaths: string[];
	localFailedPaths: string[];
};

export type ConflictResolutionResult = {
	path: string;
	conflictFile?: { path: string; content: FileContent; }; // Conflict to write to _fit/ (always _fit/ prefixed)
};

/**
 * Sync orchestrator - coordinates all sync operations between local and remote.
 *
 * FitSync is the **main entry point** for synchronization. It:
 * - Detects local and remote changes
 * - Coordinates conflict resolution when both sides changed the same files
 * - Categorizes errors into user-friendly messages
 *
 * Architecture:
 * - **Role**: High-level orchestrator and decision maker
 * - **Used by**: FitPlugin (main.ts) - the Obsidian plugin entry point
 * - **Uses**: Fit (data access)
 *
 * Key responsibilities:
 * - Change detection: Scan local and remote for changes
 * - Conflict detection: Identify files changed on both sides
 * - Conflict resolution: Write conflicting files to _fit/ for user review
 * - Error handling: Catch all errors and categorize them (network, auth, filesystem, etc.)
 * - State updates: Update cached SHAs after successful sync
 *
 * @see sync() - The main entry point method
 * @see Fit - Data access layer for local and remote storage
 */
export class FitSync implements IFitSync {
	fit: Fit;
	saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>;
	private syncPromise: Promise<SyncResult> | null = null;

	get isActive(): boolean { return this.syncPromise !== null; }

	constructor(fit: Fit, saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>) {
		this.fit = fit;
		this.saveLocalStoreCallback = saveLocalStoreCallback;
	}

	/**
	 * Prepare conflict file for writing to _fit/ directory.
	 * Returns the ORIGINAL path (not prefixed) - caller adds to clashPaths set.
	 * This enables correct SHA keying by original path (issue #169).
	 */
	private prepareConflictFile(path: string, content: Base64Content): { path: string, content: FileContent } {
		return {
			path: path,  // Return original path, not _fit/ prefixed
			content: FileContent.fromBase64(content)
		};
	}

	/**
	 * Dedicated lane for scope:"subset" `.obsidian/` json paths — excluded from the
	 * normal SHA-diff pipeline (`Fit.shouldSyncPath`) because whole-file SHA comparison
	 * can't work when local always carries untracked fields the remote blob doesn't.
	 *
	 * - `localShas[path]` here means exactly what it means for every other path — the raw
	 *   whole-file git-blob SHA, used only as a coarse "did the file move" flag (see
	 *   docs/sync-logic.md § Baseline model for scope:"subset"). `lastFetchedRemoteShas[path]`
	 *   keeps its normal meaning too — a subset-scope git blob only ever holds tracked fields.
	 * - Both-changed reuses the generic JSON merge engine (src/util/jsonMerge.ts) on the
	 *   masked view, then overlays the result onto local's real full file
	 *   (src/util/protectedPathMask.ts) so untracked local fields are never touched.
	 *
	 * Known limitations: docs/sync-logic.md § .fitattributes.json (#337).
	 *
	 * Returns the local/remote ops actually applied plus any new clashes, so the caller can
	 * fold them into the same post-sync Notice (changeGroups) and SyncResult.clash that the
	 * normal pipeline's localOps/remoteOps/conflicts feed — a push/pull/clash on a
	 * subset-scope path is reported through the same Notice text and conflict handling as
	 * any other path, not just logged.
	 */
	/**
	 * Fetches and parses remote's currently-committed .fitattributes.json at this sync's
	 * tree snapshot (once per sync, not per-candidate) — the counterpart to Fit.fitAttributes,
	 * which only ever reflects *local's* live config. Needed so a path's scope can be resolved
	 * from either side's actual rule, not just local's — see syncSubsetScopePaths' candidate
	 * filter below for why this matters (docs/sync-logic.md § Known risk).
	 *
	 * Malformed/missing/unreadable all degrade to {} (same "nothing configured" fallback local's
	 * own copy uses) — this is read-only diagnostic input for routing decisions, not something
	 * that itself needs a user-visible warning; local's own fitAttributesWarning already covers
	 * the "config is broken" case for local's copy.
	 */
	private async resolveRemoteFitAttributes(remoteTreeSha: FileStates): Promise<FitAttributesFile> {
		const sha = remoteTreeSha[FITATTRIBUTES_PATH];
		if (!sha) return {};
		try {
			const content = await this.fit.remoteVault.readFileBlobBySha(sha);
			const parsed = parseFitAttributes(content.toPlainText());
			return parsed.ok ? parsed.value : {};
		} catch (e) {
			fitLogger.log('[FitSync] Failed to fetch/parse remote .fitattributes.json this sync, treating as empty', { error: String(e) });
			return {};
		}
	}

	private async syncSubsetScopePaths(
		remoteTreeSha: FileStates,
		remoteFitAttributes: FitAttributesFile,
		previouslyPendingClashPaths: Set<string>
	): Promise<{
		localOps: FileChange[]; remoteOps: FileChange[]; clashes: FileClash[];
		commitSha?: CommitSha;
		handledPaths: string[];
	}> {
		// Cross-device rule disagreement, rule-based half — full mechanism in
		// docs/sync-logic.md § .fitattributes.json. Gated to remote's EXPLICIT rule
		// (`path in remoteFitAttributes`), not its bare default: the default heuristic is a
		// pure function of the path alone, so it can never itself disagree with local's
		// default — treating an empty remote ruleset as a disagreement was a real false-positive
		// regression this gate exists to prevent.
		const ruleBasedCandidates = Object.keys(remoteTreeSha).filter(path =>
			path.startsWith('.obsidian/') &&
			!this.fit.isHardDenylistedPath(path) &&
			(
				(this.fit.resolveSyncFormat(path) === 'json' && this.fit.resolveScope(path) === 'subset') ||
				(path in remoteFitAttributes &&
					resolveSyncFormatPure(path, remoteFitAttributes) === 'json' &&
					resolveScopePure(path, remoteFitAttributes) === 'subset')
			)
		);

		// Cross-device rule disagreement, content-based half (catches what the rule-based
		// candidates above can't — remote with no .fitattributes.json entry at all). Full
		// mechanism in docs/sync-logic.md § .fitattributes.json; see needsMaskedOverlayForPull
		// below for the actual check. Bounded to paths whose remote SHA actually changed this
		// sync and not already caught above.
		const contentCheckCandidates = Object.keys(remoteTreeSha).filter(path =>
			path.startsWith('.obsidian/') &&
			!this.fit.isHardDenylistedPath(path) &&
			!ruleBasedCandidates.includes(path) &&
			remoteTreeSha[path] !== this.fit.lastFetchedRemoteShas[path]
		);
		const contentCheckResults = await Promise.all(
			contentCheckCandidates.map(async path => ({
				path, needed: await this.needsMaskedOverlayForPull(path),
			}))
		);
		const contentBasedCandidates = contentCheckResults.filter(r => r.needed).map(r => r.path);

		const candidates = [...ruleBasedCandidates, ...contentBasedCandidates];
		if (candidates.length === 0) return { localOps: [], remoteOps: [], clashes: [], handledPaths: [] };

		const actions = await Promise.all(
			candidates.map(path => {
				// Phase 0 (run by the caller before this) already re-checked _fit/<path>'s
				// existence against this sync's real, current filesystem state and removed
				// path from this.fit.pendingClashes if the user resolved it (deleted _fit/,
				// optionally edited local). previouslyPendingClashPaths is a snapshot taken
				// before Phase 0 mutated that list — a path present there but absent from the
				// live list right now was JUST resolved this sync.
				const justResolved = previouslyPendingClashPaths.has(path) && !this.fit.pendingClashes.includes(path);
				return this.resolveSubsetScopePath(path, remoteTreeSha[path], justResolved);
			})
		);

		const pushes: Array<{ path: string, content: FileContent }> = [];
		const deletions: string[] = [];
		const localWrites: Array<{ path: string, content: FileContent }> = [];
		const clashPreviews: Array<{ path: string, content: FileContent }> = [];
		const clashPaths = new Set<string>();
		// Raw whole-file content each path ends this sync with, hashed into localShas[path]
		// below — only for paths that actually landed (see docs/sync-logic.md § Baseline
		// model for scope:"subset" for the don't-advance-past-confirmed invariant this follows).
		const rawShaUpdates = new Map<string, string>();
		// Remote-baseline updates for pull-type actions are deferred until local write
		// success is confirmed below — a 'pull'/'push-and-pull' whose local write fails must
		// not advance lastFetchedRemoteShas, or the pulled content is lost with no retry.
		const pendingRemoteShaUpdates = new Map<string, BlobSha>();
		const localOps: FileChange[] = [];
		const remoteOps: FileChange[] = [];
		const clashes: FileClash[] = [];

		for (const action of actions) {
			switch (action.kind) {
				case 'skip':
					continue;
				case 'in-sync':
					rawShaUpdates.set(action.path, action.rawLocalContent);
					this.fit.lastFetchedRemoteShas[action.path] = remoteTreeSha[action.path];
					break;
				case 'push':
					pushes.push({ path: action.path, content: FileContent.fromPlainText(serialiseMerged(action.trackedObj)) });
					rawShaUpdates.set(action.path, action.rawLocalContent);
					remoteOps.push({ path: action.path, type: 'MODIFIED' });
					break;
				case 'pull':
					localWrites.push({ path: action.path, content: FileContent.fromPlainText(action.localFullContent) });
					rawShaUpdates.set(action.path, action.localFullContent);
					pendingRemoteShaUpdates.set(action.path, remoteTreeSha[action.path]);
					localOps.push({ path: action.path, type: action.localOpType });
					break;
				case 'push-and-pull':
					pushes.push({ path: action.path, content: FileContent.fromPlainText(serialiseMerged(action.trackedObj)) });
					localWrites.push({ path: action.path, content: FileContent.fromPlainText(action.localFullContent) });
					rawShaUpdates.set(action.path, action.localFullContent);
					remoteOps.push({ path: action.path, type: 'MODIFIED' });
					localOps.push({ path: action.path, type: 'MODIFIED' });
					break;
				case 'clash':
					// Resolution (user deletes _fit/<path>, keeps a local edit) is handled in
					// resolveSubsetScopePath's justResolved branch, not here - by the time an
					// action is 'clash' here, Phase 0 (which runs before this) has already
					// confirmed the path is still genuinely unresolved this sync.
					clashPreviews.push({ path: action.path, content: FileContent.fromPlainText(action.previewContent) });
					clashPaths.add(action.path);
					if (!this.fit.pendingClashes.includes(action.path)) this.fit.pendingClashes.push(action.path);
					clashes.push({ path: action.path, localState: 'MODIFIED', remoteOp: 'MODIFIED' });
					fitLogger.log('[FitSync] subset-scope path clash, written to _fit/', { path: action.path });
					break;
				case 'delete':
					// Confirmed prior baseline + local file now absent — a real deletion,
					// propagated to remote the same way a format:"text" .obsidian/ path or an
					// ordinary tracked file would (compareFileStates' REMOVED case). Deletions
					// never get skipped/rate-limited by RemoteGitHubVault (only content writes
					// can be, on size/rate limits), so this is treated as unconditionally
					// successful once the commit below succeeds.
					deletions.push(action.path);
					remoteOps.push({ path: action.path, type: 'REMOVED' });
					break;
			}
		}

		if (localWrites.length > 0 || clashPreviews.length > 0) {
			// clashPaths (original, unprefixed paths) tells LocalVault.applyChanges to write
			// each entry to _fit/<path> instead of <path> directly — same convention used
			// everywhere else clash files are written (see applyRemoteChanges below).
			const localResult = await this.fit.localVault.applyChanges([...localWrites, ...clashPreviews], [], { clashPaths });
			const localFailedPaths = new Set(localResult.failedPaths ?? []);
			if (localFailedPaths.size > 0) {
				fitLogger.log('[FitSync] subset-scope: local write failed for some path(s), will retry next sync', {
					paths: [...localFailedPaths],
				});
				for (const path of localFailedPaths) {
					rawShaUpdates.delete(path);
					pendingRemoteShaUpdates.delete(path);
				}
			}
		}
		for (const [path, sha] of pendingRemoteShaUpdates) {
			this.fit.lastFetchedRemoteShas[path] = sha;
		}

		let commitSha: CommitSha | undefined;
		if (pushes.length > 0 || deletions.length > 0) {
			const result = await this.fit.remoteVault.applyChanges(pushes, deletions, { clashPaths: new Set() });
			commitSha = result.commitSha;
			for (const { path } of pushes) {
				const newSha = result.newState[path];
				if (newSha) this.fit.lastFetchedRemoteShas[path] = newSha;
			}
			// Skipped/rate-limited paths must not advance localShas — see docs/sync-logic.md
			// § Baseline model for scope:"subset" (mirrors ApplyChangesResult<"remote">'s
			// documented contract in src/vault.ts, minus the normal pipeline's unpushedFiles UX).
			// Deletions are never skipped/rate-limited (only content writes can be, on
			// size/rate limits), so every path in `deletions` is treated as confirmed here.
			const failedPushPaths = new Set([...(result.skippedPaths ?? []), ...(result.rateLimitedPaths ?? [])]);
			if (failedPushPaths.size > 0) {
				fitLogger.log('[FitSync] subset-scope: push skipped or rate-limited for some path(s), will retry next sync', {
					paths: [...failedPushPaths],
				});
				for (const path of failedPushPaths) {
					rawShaUpdates.delete(path);
				}
			}
			for (const path of deletions) {
				delete this.fit.localShas[path];
				delete this.fit.lastFetchedRemoteShas[path];
			}
		}

		for (const [path, content] of rawShaUpdates) {
			this.fit.localShas[path] = await computeGitBlobSha(new TextEncoder().encode(content));
		}

		if (actions.some(a => a.kind !== 'skip')) {
			fitLogger.log('[FitSync] subset-scope paths resolved', {
				pushed: pushes.length, pulled: localWrites.length, clashed: clashPreviews.length, deleted: deletions.length,
			});
		}

		return { localOps, remoteOps, clashes, commitSha, handledPaths: candidates };
	}

	/**
	 * Content-level cross-device disagreement signal for syncSubsetScopePaths' candidate
	 * filter (see the comment there) - would an opaque whole-file pull (the normal pipeline's
	 * behavior) drop a top-level key local's current file has that remote's blob doesn't? Not
	 * itself a decision about push, both-changed, or first-contact: those either can't lose
	 * data this way (push just uploads everything local has; first-contact has no local
	 * content to lose) or are already handled correctly by the caller's other checks. `false`
	 * on any read/parse failure - nothing to protect if either side isn't a readable JSON
	 * object, and the normal pipeline's own error handling covers a genuine fetch failure.
	 */
	private async needsMaskedOverlayForPull(path: string): Promise<boolean> {
		let localText: string;
		try {
			localText = (await this.fit.localVault.readFileContent(path)).toPlainText();
		} catch {
			return false; // no local content yet - nothing an opaque pull could drop
		}
		let remoteText: string;
		try {
			remoteText = (await this.fit.remoteVault.readFileContent(path)).toPlainText();
		} catch {
			return false; // let the normal pipeline's own fetch attempt/error handling take it
		}
		const localParsed = parseJsonObject(localText);
		const remoteParsed = parseJsonObject(remoteText);
		if (!localParsed.ok || !remoteParsed.ok) return false; // masking is JSON-object-only
		const remoteKeys = new Set(Object.keys(remoteParsed.value));
		return Object.keys(localParsed.value).some(k => !remoteKeys.has(k));
	}

	private async resolveSubsetScopePath(path: string, remoteSha: BlobSha, justResolved = false): Promise<SubsetPathAction> {
		let remoteText: string;
		try {
			remoteText = (await this.fit.remoteVault.readFileContent(path)).toPlainText();
		} catch (e) {
			fitLogger.log('[FitSync] subset-scope: failed to read remote content, skipping this sync', { path, error: String(e) });
			return { path, kind: 'skip' };
		}
		const remoteParsed = parseJsonObject(remoteText);
		if (!remoteParsed.ok) {
			fitLogger.log('[FitSync] subset-scope: remote content is not a JSON object, skipping this sync', { path, error: remoteParsed.error });
			return { path, kind: 'skip' };
		}
		// Strip denylisted keys before anything below reads remoteObj, regardless of what
		// the git blob claims is tracked (UNIVERSAL_SECRET_FIELD_DENYLIST + per-path).
		const denylist: readonly string[] = [...UNIVERSAL_SECRET_FIELD_DENYLIST, ...(this.fit.safeFieldDenylist(path) ?? [])];
		const remoteObj = Object.fromEntries(Object.entries(remoteParsed.value).filter(([k]) => !denylist.includes(k)));
		const trackedFields = Object.keys(remoteObj).sort();

		let localText: string | null;
		try {
			localText = (await this.fit.localVault.readFileContent(path)).toPlainText();
		} catch {
			localText = null;
		}

		const localMaskedResult = extractMask(localText ?? '{}', trackedFields);
		const localMaskedObj = localMaskedResult.ok ? localMaskedResult.value : {};

		const priorRemoteSha = this.fit.lastFetchedRemoteShas[path];
		// Raw whole-file SHA, same meaning as every other path — see docs/sync-logic.md
		// § Baseline model for scope:"subset". Only a coarse "has the file moved" flag; the
		// actual tracked-field decision is made below from real masked content.
		const priorRawSha = this.fit.localShas[path];

		const buildClashPreview = (): SubsetPathAction => {
			const overlaid = overlayMask(localText, remoteObj);
			const previewObj = overlaid.ok ? overlaid.value : remoteObj;
			return { path, kind: 'clash', previewContent: JSON.stringify(previewObj, null, '\t') };
		};

		// Masked view already matches remote — nothing to do regardless of raw bytes (which can
		// differ due to untracked fields) or either baseline.
		if (stableStringify(localMaskedObj) === stableStringify(remoteObj)) {
			return { path, kind: 'in-sync', trackedObj: remoteObj, rawLocalContent: localText ?? '{}' };
		}

		// A just-resolved clash pushes local's masked view unconditionally, rather than
		// re-deriving against the stale pre-clash baseline (which would just re-clash forever).
		if (justResolved && localText !== null) {
			return { path, kind: 'push', trackedObj: localMaskedObj, rawLocalContent: localText };
		}

		// Classify via the normal pipeline's own machinery, not hand-rolled booleans — see
		// docs/sync-logic.md § .fitattributes.json, Architecture note. No SHA-identity skip
		// (localShas/remoteShas omitted): raw whole-file SHAs essentially never match here
		// (local always carries untracked fields); the masked-equality check above already
		// covers the equivalent case.
		const currentRawSha = localText !== null ? await computeGitBlobSha(new TextEncoder().encode(localText)) : undefined;
		const localState = currentRawSha !== undefined ? { [path]: currentRawSha } : {};
		const localBaseline = priorRawSha !== undefined ? { [path]: priorRawSha } : {};
		const remoteState = { [path]: remoteSha };
		const remoteBaseline = priorRemoteSha !== undefined ? { [path]: priorRemoteSha } : {};
		const { safeLocal, safeRemote, clashes } = resolveAllChanges(
			compareFileStates(localState, localBaseline),
			compareFileStates(remoteState, remoteBaseline),
			new Set(), new Set()
		);

		if (clashes.length > 0) {
			if (localText === null) return buildClashPreview();

			// Both changed — attempt a 3-way merge on the masked view, same engine .canvas/
			// ordinary format:"json" paths already use. Also reached on a genuine first sync
			// (no baseline, so baseText below stays null) — confirmed safe, doesn't merge over
			// a real conflict: mergeJson with a null base is conservative enough to still clash.
			let baseText: string | null = null;
			if (priorRemoteSha) {
				try {
					baseText = (await this.fit.remoteVault.readFileBlobBySha(priorRemoteSha)).toPlainText();
				} catch (e) {
					fitLogger.log('[FitSync] subset-scope: base blob fetch failed, falling back to clash', { path, error: String(e) });
				}
			}
			let mergeResult: MergeResult;
			try {
				mergeResult = mergeJson(baseText, stableStringify(localMaskedObj), stableStringify(remoteObj), GENERIC_JSON_MERGE_SPEC);
			} catch (e) {
				fitLogger.log('[FitSync] subset-scope: merge threw, falling back to clash', { path, error: String(e) });
				return buildClashPreview();
			}
			if (!mergeResult.merged) return buildClashPreview();

			const mergedObj = mergeResult.value as Record<string, unknown>;
			const overlaid = overlayMask(localText, mergedObj);
			if (!overlaid.ok) return buildClashPreview();
			return {
				path, kind: 'push-and-pull', trackedObj: mergedObj,
				localFullContent: JSON.stringify(overlaid.value, null, '\t'),
			};
		}

		if (safeLocal.length > 0) {
			// Local changed, remote didn't. If local has no content at all, this is a real
			// deletion (confirmed prior baseline + now absent) — propagate it. Otherwise it's
			// an ordinary content push.
			if (localText === null) return { path, kind: 'delete' };
			return { path, kind: 'push', trackedObj: localMaskedObj, rawLocalContent: localText };
		}

		if (safeRemote.length > 0) {
			// Remote changed, local didn't (or never existed). No local file at all is first
			// contact — write remote's content wholesale. Otherwise overlay onto local's real
			// content so untracked fields survive.
			if (localText === null) {
				return { path, kind: 'pull', trackedObj: remoteObj, localFullContent: JSON.stringify(remoteObj, null, '\t'), localOpType: 'ADDED' };
			}
			const overlaid = overlayMask(localText, remoteObj);
			if (!overlaid.ok) return buildClashPreview();
			return { path, kind: 'pull', trackedObj: remoteObj, localFullContent: JSON.stringify(overlaid.value, null, '\t'), localOpType: 'MODIFIED' };
		}

		// Defensive fallback, not a reachable path given the checks above.
		return { path, kind: 'in-sync', trackedObj: remoteObj, rawLocalContent: localText ?? '{}' };
	}

	/**
	 * Apply remote changes to local vault with comprehensive safety checks.
	 * Handles protected paths, untracked files, clashes, and stat verification.
	 *
	 * @param clashFiles - Conflict files to write to _fit/ (from clash detection)
	 * @returns File operations performed and stat failure tracking
	 */
	private async applyRemoteChanges(
		addToLocalNonClashed: Array<{path: string, content: FileContent}>,
		deleteFromLocalNonClashed: string[],
		clashFiles: Array<{path: string, content: FileContent}>,
		existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>,
		syncNotice: FitNotice,
		mergedPaths?: Set<string>
	): Promise<ApplyChangesResult<"local">> {
		if (clashFiles.length > 0) {
			syncNotice.setMessage('Change conflicts detected');
		} else {
			syncNotice.setMessage("Writing remote changes to local");
		}

		const resolvedChanges: Array<{path: string, content: FileContent}> = [];
		const clashPaths = new Set<string>(); // Track which paths should go to _fit/

		// Add all clash files to clashPaths set and resolvedChanges.
		// The clashPaths set tells applyChanges to write to _fit/ AND compute SHA using original path.
		for (const clashFile of clashFiles) {
			clashPaths.add(clashFile.path);
			resolvedChanges.push(clashFile);
		}

		for (const change of addToLocalNonClashed) {
			// SAFETY: Check filesystem for files not in localShas cache
			// This protects against:
			// 1. Version migrations where tracking rules changed
			// 2. Bugs where shouldTrackState returns wrong value
			// 3. Hidden files that weren't tracked but exist locally
			//
			// If file not in cache but exists on disk → treat as clash, save to _fit/
			// If file not in cache and doesn't exist → safe to write directly
			// Exception: mergedPaths — caller already read and merged local content, safe to write.
			if (!this.fit.localShas.hasOwnProperty(change.path) && !mergedPaths?.has(change.path)) {
				// Not in cache - check if file exists using statPaths result
				const stat = existenceMap.get(change.path);
				if (stat === undefined) {
					// Could not verify file existence - be conservative and save to _fit/
					// Note: This shouldn't happen if Phase 2 checked all needed paths
					clashPaths.add(change.path);
					resolvedChanges.push(change);
					continue; // Don't risk overwriting if file might exist
				} else if (stat === 'file' || stat === 'folder') {
					// File exists - save to _fit/ for safety (tracking state inconsistency)
					clashPaths.add(change.path);
					resolvedChanges.push(change);
					continue; // Don't risk overwriting local version
				}
				// File doesn't exist locally (stat === 'nonexistent') - safe to write directly
			}

			// Normal file or no conflict - add as-is
			resolvedChanges.push({path: change.path, content: change.content});
		}

		// SAFETY: Never delete untracked files from local
		const safeDeleteFromLocal = [];
		for (const path of deleteFromLocalNonClashed) {
			// SAFETY: Check if file is in cache before deleting
			// If not in cache, we cannot verify it's safe to delete
			if (!this.fit.localShas.hasOwnProperty(path)) {
				// Not in cache - check if file actually exists to determine appropriate action
				// Use the existenceMap we already computed above
				const stat = existenceMap.get(path);
				if (stat === undefined) {
					// Could not verify file existence - be conservative and skip deletion
					// Note: This shouldn't happen if Phase 2 checked all needed paths
					continue; // Don't delete if we can't verify it's safe
				} else if (stat === 'file' || stat === 'folder') {
					// File exists but not tracked - don't delete (tracking state inconsistency)
					continue; // Skip deletion
				}
				// File doesn't exist (stat === 'nonexistent') - deletion already done, no action needed
				continue; // Skip deletion (no-op)
			}

			safeDeleteFromLocal.push(path); // Safe to delete
		}

		const addToLocal = resolvedChanges;
		const deleteFromLocal = safeDeleteFromLocal;

		// Apply changes with clashPaths to write unsafe/clash paths to _fit/
		const result = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal, { clashPaths });

		// Show user warning if encoding issues detected
		if (result.userWarning) {
			const warningNotice = new FitNotice(this.fit, [], result.userWarning, 0);
			warningNotice.show();
		}

		return result;
	}

	/**
	 * Collect filesystem existence state for all paths that need verification.
	 * This batches all stat operations into a single call for efficiency.
	 *
	 * @returns Map of path → existence state, plus any stat error encountered
	 */
	private async collectFilesystemState(
		paths: string[]
	): Promise<{existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>, statError: unknown}> {
		let existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>;
		let statError: unknown = null;
		try {
			const rawStatMap = await this.fit.localVault.statPaths(paths);
			existenceMap = new Map(
				Array.from(rawStatMap.entries()).map(([path, stat]) =>
					[path, stat === null ? 'nonexistent' : stat] as const
				)
			);
		} catch (error) {
			statError = error;
			// Leave map empty - all lookups will return undefined (unknown state)
			existenceMap = new Map();
		}

		return { existenceMap, statError };
	}

	/**
	 * Phase 2: Compare & Resolve changes to determine safe vs clashed operations.
	 *
	 * Performs the full Phase 2 workflow:
	 * - 2a: Determine what filesystem checks are needed
	 * - 2b: Batch collect filesystem state for verification
	 * - 2c: Resolve all changes to final safe/clash categorization
	 * - Log any stat failures that caused conservative clash treatment
	 *
	 * @returns Safe changes, clashes, and filesystem state for Phase 3 execution
	 */
	private async compareAndResolveChanges(
		localChanges: FileChange[],
		remoteChanges: FileChange[],
		localScanPaths: Set<string>,
		remoteScanPaths: Set<string>,
		currentLocalState: FileStates,
		remoteTreeSha: FileStates
	) {
		// Diagnostic: Check if any clashes are due to Unicode normalization mismatches
		detectNormalizationMismatches(Array.from(localScanPaths), Array.from(remoteScanPaths));

		// Phase 2a: Determine what filesystem checks are needed
		const isProtectedPath = (path: string) => !this.fit.shouldSyncPath(path);
		const { needsFilesystemCheck } = determineLocalChecksNeeded(
			remoteChanges,
			localScanPaths,
			isProtectedPath
		);

		// Phase 2b: Batch collect filesystem state for all paths needing verification
		const pathsToStat = new Set<string>();
		needsFilesystemCheck.forEach(item => pathsToStat.add(item.path));

		// Also check local deletions for version migration safety
		localChanges
			.filter(c => c.type === 'REMOVED')
			.forEach(c => pathsToStat.add(c.path));

		const { existenceMap, statError } = await this.collectFilesystemState(Array.from(pathsToStat));

		// Convert existenceMap to format expected by resolveAllChanges (true/false/null)
		// existenceMap values: "file" | "folder" | "nonexistent" | undefined
		const filesystemState = new Map<string, boolean | null>();
		for (const path of pathsToStat) {
			const state = existenceMap.get(path);
			if (state === undefined) {
				filesystemState.set(path, null); // stat failed
			} else {
				filesystemState.set(path, state !== "nonexistent");
			}
		}

		// Phase 2b (continued): Batch SHA reads for untracked files with baselines (#169)
		// For files that exist locally AND have a baseline SHA, read and compute current SHA
		// This allows baseline comparison to prevent unnecessary clashes
		const pathsNeedingShaCheck = Array.from(pathsToStat).filter(path =>
			filesystemState.get(path) === true
		);

		const currentShas = new Map<string, BlobSha>();
		for (const path of pathsNeedingShaCheck) {
			try {
				// readFileContent now handles both indexed and unindexed files (hidden files)
				const content = await this.fit.localVault.readFileContent(path);
				const sha = await LocalVault.fileSha1(path, content);
				currentShas.set(path, sha);
			} catch (error) {
				// If we can't read the file for SHA computation, skip it
				// The file will be treated as changed (conservative behavior)
				fitLogger.log(`⚠️ [FitSync] Could not read file for SHA check: ${path}`, error);
			}
		}

		// Content-identity fast path: when local and remote independently produced
		// byte-identical content (same canonical git blob SHA), there's nothing to reconcile —
		// skip the clash entirely instead of writing a redundant copy to _fit/. Guarded off
		// under encryption: encrypted blob SHAs aren't comparable to plaintext content SHAs.
		let encryptionEnabled = false;
		try { encryptionEnabled = Encryption.isEnabled(); } catch { /* uninitialized — treat as disabled */ }
		const identityRemoteShas = encryptionEnabled ? {} : remoteTreeSha;
		const identityLocalShas = encryptionEnabled ? {} : currentLocalState;

		// Phase 2b (part 2): Resolve untracked state from filesystem checks
		const localChangePaths = new Set(localChanges.map(c => c.path));
		const { protectedPaths, untrackedPaths } = resolveUntrackedState(
			remoteChanges,
			localChangePaths,
			filesystemState,
			this.fit.localShas,
			currentShas,
			isProtectedPath,
			identityRemoteShas
		);

		// Phase 2c: Simple clash detection
		const gitMaskTrackedPaths = new Set(
			remoteChanges
				.filter(c => c.type === 'REMOVED' && this.fit.isGitMaskTrackedPath(c.path))
				.map(c => c.path)
		);
		const { safeLocal, safeRemote, clashes, protectedRemote, untrackNotices } = resolveAllChanges(
			localChanges,
			remoteChanges,
			protectedPaths,
			untrackedPaths,
			identityLocalShas,
			identityRemoteShas,
			gitMaskTrackedPaths
		);

		if (untrackNotices.length > 0) {
			fitLogger.log('[FitSync] .obsidian/ path(s) removed from remote while locally unedited — leaving local file(s) in place', {
				paths: untrackNotices.map(c => c.path)
			});
		}

		// Track stat failures for logging
		const filesMovedToFitDueToStatFailure: string[] = [];
		const deletionsSkippedDueToStatFailure: string[] = [];
		for (const clash of clashes) {
			if (clash.localState === 'untracked') {
				const stat = filesystemState.get(clash.path);
				if (stat === null) {
					// Stat failed - conservative clash
					if (clash.remoteOp === 'REMOVED') {
						deletionsSkippedDueToStatFailure.push(clash.path);
					} else {
						filesMovedToFitDueToStatFailure.push(clash.path);
					}
				}
			}
		}

		// Log consolidated stat failures
		if (statError !== null || filesMovedToFitDueToStatFailure.length > 0 ||
			deletionsSkippedDueToStatFailure.length > 0) {
			fitLogger.log('[FitSync] Couldn\'t check if some paths exist locally - conservatively treating as clash', {
				error: statError,
				filesMovedToFit: filesMovedToFitDueToStatFailure,
				deletionsSkipped: deletionsSkippedDueToStatFailure
			});
		}

		fitLogger.log('[FitSync] Conflict detection complete', {
			safeLocal: safeLocal.length,
			safeRemote: safeRemote.length,
			clashes: clashes.length,
			protectedRemote: protectedRemote.length
		});

		return {
			safeLocal, safeRemote, clashes, protectedRemote, untrackNotices, statError, filesMovedToFitDueToStatFailure, deletionsSkippedDueToStatFailure, existenceMap
		};
	}

	/**
	 * Phase 3: Execute sync operations - push, pull, persist state.
	 *
	 * Takes the resolved safe/clash categorization from Phase 2 and executes:
	 * - Write clashes to _fit/ directory
	 * - Push safe local changes to remote
	 * - Pull safe remote changes to local
	 * - Persist updated state (atomic - if any step fails, no state is saved)
	 *
	 * @returns The operations that were applied and conflicts discovered
	 */
	private async executeSync(
		currentLocalState: FileStates,
		remoteUpdate: { remoteChanges?: FileChange[]; remoteTreeSha: FileStates; latestRemoteCommitSha: CommitSha; },
		safeLocal: FileChange[],
		safeRemote: FileChange[],
		clashes: FileClash[],
		protectedRemote: FileChange[],
		pendingReminderPaths: Set<string>,
		existenceMap: Map<string, "file" | "folder" | "nonexistent">,
		syncNotice: FitNotice
	): Promise<SyncExecutionResult> {
		// Prepare safe remote changes for pulling
		const deleteFromLocalNonClashed = safeRemote.filter(c => c.type === "REMOVED").map(c => c.path);

		// SHA parity optimization: when a remote ADD/MODIFY has the same canonical blob SHA
		// as our local file, the content is already identical — skip the download.
		// Only safe when encryption is off (encrypted blobs have a different SHA than plaintext).
		// Guard: isEnabled() requires Encryption.init(plugin) which isn't called in tests.
		let encryptionEnabled = false;
		try { encryptionEnabled = Encryption.isEnabled(); } catch { /* uninitialized — treat as disabled */ }
		const shaParitySkipped = new Set<string>();
		if (!encryptionEnabled) {
			for (const change of safeRemote) {
				if (change.type === "REMOVED") continue;
				const localSha = currentLocalState[change.path];
				const remoteSha = remoteUpdate.remoteTreeSha[change.path];
				if (localSha && remoteSha && localSha === remoteSha) {
					shaParitySkipped.add(change.path);
				}
			}
			if (shaParitySkipped.size > 0) {
				fitLogger.log('[FitSync] SHA parity: skipping redundant download for identical files', {
					count: shaParitySkipped.size,
					paths: [...shaParitySkipped]
				});
			}
		}

		const addToLocalNonClashed = await Promise.all(
			safeRemote
				.filter(c => c.type !== "REMOVED" && !shaParitySkipped.has(c.path))
				.map(async (change) => ({
					path: change.path,
					content: await this.fit.remoteVault.readFileContent(change.path)
				}))
		);

		// Phase 3: Execute sync operations
		// Prepare clash files for writing to _fit/ directory.
		// readFileContent uses content cached by readFromSource() — no extra API calls.
		// Reminder-only paths (pendingReminderPaths) are excluded: remote content is unchanged
		// so there is nothing new to write. They remain in clashes for state-management purposes
		// (the loop below still deletes them from newLocalState to prevent leaking into localShas).
		// Deletion of a pending path arrives with remoteOp === 'REMOVED' via the reclassification
		// path above, so the remoteOp !== 'REMOVED' filter here can never incorrectly skip it.

		// Auto-merge: format:"json" clashes are resolved via semantic JSON merge (see
		// src/util/jsonMerge.ts). Successful merges bypass _fit/ entirely; the merged
		// result is written locally and pushed on the next sync. mergedPaths tells
		// applyRemoteChanges these are safe to write even when not yet in localShas
		// (caller already incorporated local content). Format is resolved the same way
		// for any path (.obsidian/ or ordinary vault) — .fitattributes.json config wins,
		// else filetype default (detectSyncFormat) — .canvas gets its id-keyed
		// nodes/edges spec, everything else gets the generic key-level spec
		// (mergeSpecForPath). Was hardcoded to `.canvas` alone; generalizing this is what
		// makes forcing a specific `.canvas` file to format:"text" (or opting an ordinary
		// `.json` vault file into structural merge) actually take effect.
		const jsonClashCandidates = clashes
			.filter(c => c.remoteOp !== 'REMOVED')
			.filter(c => !pendingReminderPaths.has(c.path))
			.filter(c => this.fit.resolveSyncFormat(c.path) === 'json');

		// Pre-fetch base blobs in parallel before running merges (three-way merge base).
		// Base = content at last successful sync = lastFetchedRemoteShas blob SHA.
		const jsonBaseTexts = new Map<string, string | null>();
		await Promise.all(jsonClashCandidates.map(async (clash) => {
			const baseSha = this.fit.lastFetchedRemoteShas[clash.path];
			if (!baseSha) { jsonBaseTexts.set(clash.path, null); return; }
			try {
				const content = await this.fit.remoteVault.readFileBlobBySha(baseSha);
				jsonBaseTexts.set(clash.path, content.toPlainText());
				fitLogger.log('... [FitSync] Fetched base blob for JSON merge', { path: clash.path, sha: baseSha });
			} catch (e) {
				fitLogger.log('... [FitSync] Base blob fetch failed, falling back to two-way merge', { path: clash.path, sha: baseSha, error: String(e) });
				jsonBaseTexts.set(clash.path, null);
			}
		}));

		const autoMergedJsonClashes: Array<{path: string, content: FileContent}> = [];

		await Promise.all(
			jsonClashCandidates.map(async (clash) => {
				const remoteContent = await this.fit.remoteVault.readFileContent(clash.path).catch(() => null);
				const localContent = await this.fit.localVault.readFileContent(clash.path).catch(() => null);
				if (remoteContent === null || localContent === null) return;
				const baseText = jsonBaseTexts.get(clash.path) ?? null;
				let result: MergeResult;
				try {
					result = mergeJson(baseText, localContent.toPlainText(), remoteContent.toPlainText(), mergeSpecForPath(clash.path));
				} catch (e) {
					fitLogger.log('.. [FitSync] JSON auto-merge threw, falling back to clash', {
						path: clash.path, error: String(e),
					});
					return;
				}
				if (!result.merged) {
					fitLogger.log('.. [FitSync] JSON auto-merge failed, falling back to clash', {
						path: clash.path, reason: result.reason,
					});
					return;
				}
				fitLogger.log('.. [FitSync] JSON auto-merge succeeded', {
					path: clash.path, hadBase: baseText !== null,
				});
				autoMergedJsonClashes.push({
					path: clash.path,
					content: FileContent.fromPlainText(serialiseMerged(result.value)),
				});
			})
		);

		const textClashCandidates = clashes
			.filter(c => c.remoteOp !== 'REMOVED')
			.filter(c => !pendingReminderPaths.has(c.path))
			.filter(c => this.fit.resolveSyncFormat(c.path) !== 'json');

		const autoMergedTextClashes: Array<{path: string, content: FileContent}> = [];
		// Cache remote content read here so clashFiles (below) doesn't re-fetch it
		// for candidates that don't end up merging.
		const textRemoteContents = new Map<string, FileContent>();

		await Promise.all(
			textClashCandidates.map(async (clash) => {
				const remoteContent = await this.fit.remoteVault.readFileContent(clash.path).catch(() => null);
				const localContent = await this.fit.localVault.readFileContent(clash.path).catch(() => null);
				if (remoteContent === null || localContent === null) return;
				textRemoteContents.set(clash.path, remoteContent);

				// Null-byte check first: encoding tags can't be trusted here (remote
				// content always arrives base64-tagged regardless of underlying type),
				// and toPlainText()'s fatal UTF-8 decode alone isn't a strong enough
				// binary signal — some binary content can coincidentally decode as
				// valid UTF-8, which would let it through to be line-spliced and corrupted.
				if (hasNullByte(remoteContent.prefixBytes(8192)) || hasNullByte(localContent.prefixBytes(8192))) return;

				// Base fetch happens here (lazily, per candidate that passed the checks
				// above) rather than upfront for every candidate, to avoid a wasted
				// GitHub API call for paths that were never going to merge anyway.
				const baseSha = this.fit.lastFetchedRemoteShas[clash.path];
				if (!baseSha) return;
				let baseText: string;
				try {
					const baseContent = await this.fit.remoteVault.readFileBlobBySha(baseSha);
					baseText = baseContent.toPlainText();
				} catch (e) {
					fitLogger.log('... [FitSync] Base blob fetch failed for text merge, falling back to clash', { path: clash.path, sha: baseSha, error: String(e) });
					return;
				}

				let merged: string | null;
				try {
					merged = tryLineMerge(baseText, localContent.toPlainText(), remoteContent.toPlainText());
				} catch (e) {
					fitLogger.log('.. [FitSync] Line merge threw (likely binary content), falling back to clash', {
						path: clash.path, error: String(e),
					});
					return;
				}
				if (merged === null) return;
				fitLogger.log('.. [FitSync] Line merge succeeded', { path: clash.path });
				autoMergedTextClashes.push({ path: clash.path, content: FileContent.fromPlainText(merged) });
			})
		);

		const mergedPaths = new Set([...autoMergedJsonClashes, ...autoMergedTextClashes].map(c => c.path));

		const clashFiles = await Promise.all(
			clashes
				.filter(c => c.remoteOp !== 'REMOVED')
				.filter(c => !pendingReminderPaths.has(c.path))
				.filter(c => !mergedPaths.has(c.path))
				.map(async (clash) => {
					const content = textRemoteContents.get(clash.path) ?? await this.fit.remoteVault.readFileContent(clash.path);
					return this.prepareConflictFile(clash.path, content.toBase64());
				})
		);

		// 3a. Push local changes to remote
		syncNotice.setMessage("Uploading local changes");
		const pushUpdate = {
			localChanges: safeLocal,
			parentCommitSha: remoteUpdate.latestRemoteCommitSha
		};
		const pushResult = await this.pushChangedFilesToRemote(pushUpdate, existenceMap);

		if (pushResult && pushResult.pushedChanges.length > 0) {
			fitLogger.log(`.. ⬆️ [Push] Pushed ${pushResult.pushedChanges.length} changes to remote`);
		}

		// Record any files skipped due to API size limit (422) into unpushedFiles.
		// localShas is updated normally for these files (sync engine won't retry),
		// so unpushedFiles is the sole tracking mechanism for them.
		// Capture which paths are freshly added (not already known) for the tiered warning.
		const previousUnpushedKeys = new Set(Object.keys(this.fit.unpushedFiles));
		if (pushResult?.skippedPaths?.length) {
			for (const path of pushResult.skippedPaths) {
				this.fit.unpushedFiles[path] = currentLocalState[path];
			}
			fitLogger.log(`[FitSync] ${pushResult.skippedPaths.length} file(s) added to unpushedFiles (API size limit)`, {
				paths: pushResult.skippedPaths
			});
		}

		let latestRemoteTreeSha: FileStates;
		let latestCommitSha: CommitSha;
		let pushedChanges: Array<FileChange>;

		if (pushResult) {
			latestRemoteTreeSha = pushResult.lastFetchedRemoteShas;
			latestCommitSha = pushResult.lastFetchedCommitSha;
			pushedChanges = pushResult.pushedChanges;
		} else {
			// No changes were pushed (pushChangedFilesToRemote returned null)
			// TODO: Should we abort the sync if safeLocal had changes but nothing was pushed?
			// This could indicate a push failure that we're silently ignoring. If we continue and persist
			// the new remote state, we might incorrectly mark those local changes as synced.
			latestRemoteTreeSha = remoteUpdate.remoteTreeSha;
			latestCommitSha = remoteUpdate.latestRemoteCommitSha;
			pushedChanges = [];
		}

		// 3b. Pull remote changes to local (with safety checks and clash resolution)
		// autoMergedJsonClashes are written as normal files (not to _fit/), deferred push on next sync.
		// mergedPaths bypasses the untracked-file safety redirect — content already merged from local.
		const allAddToLocal = [...addToLocalNonClashed, ...autoMergedJsonClashes, ...autoMergedTextClashes];
		const localFileOpsRecord = await this.applyRemoteChanges(
			allAddToLocal,
			deleteFromLocalNonClashed,
			clashFiles,
			existenceMap,
			syncNotice,
			mergedPaths
		);

		if (allAddToLocal.length > 0 || deleteFromLocalNonClashed.length > 0 || clashFiles.length > 0) {
			fitLogger.log('.. ⬇️ [Pull] Applied remote changes to local', {
				filesWritten: allAddToLocal.length,
				filesDeleted: deleteFromLocalNonClashed.length,
				clashesWrittenToFit: clashFiles.length,
				...(autoMergedJsonClashes.length > 0 && { jsonAutoMerged: autoMergedJsonClashes.length }),
				...(autoMergedTextClashes.length > 0 && { textAutoMerged: autoMergedTextClashes.length }),
			});
		}

		const localFailedPaths = localFileOpsRecord.failedPaths ?? [];
		const localFailedPathsSet = new Set(localFailedPaths);
		if (localFailedPathsSet.size > 0) {
			fitLogger.log(`⚠️ [FitSync] ${localFailedPathsSet.size} file(s) failed to apply locally — will retry next sync`, {
				paths: localFailedPaths
			});
		}

		// 3b'. Track protected path SHA arrivals for opt-in reconciliation.
		// Remote changes to paths excluded by shouldSyncPath (e.g. .obsidian/ not opted in).
		// Only the remote SHA is recorded — no content download, no _fit/ write.
		// When the user later opts in a path, the reconciliation pre-sync step reads
		// protectedPathShas to establish a baseline and avoid junk clashes.
		//
		// scope: "subset" paths are excluded — they have their own reconciliation
		// (syncSubsetScopePaths runs every sync, unconditionally, not opt-in-triggered),
		// and the generic reconcile block below compares RAW file SHAs, which would
		// wrongly clobber a masked-view baseline the moment it ran.
		for (const change of protectedRemote) {
			if (this.fit.resolveSyncFormat(change.path) === 'json' && this.fit.resolveScope(change.path) === 'subset') continue;
			if (change.type === 'REMOVED') {
				delete this.fit.protectedPathShas[change.path];
				continue;
			}
			const remoteSha = remoteUpdate.remoteTreeSha[change.path];
			if (remoteSha) this.fit.protectedPathShas[change.path] = remoteSha;
		}

		if (localFailedPathsSet.size > 0) {
			latestRemoteTreeSha = { ...latestRemoteTreeSha };
			for (const path of localFailedPathsSet) {
				if (deleteFromLocalNonClashed.includes(path)) {
					const previousSha = this.fit.lastFetchedRemoteShas[path];
					if (previousSha !== undefined) {
						latestRemoteTreeSha[path] = previousSha;
					} else {
						fitLogger.log('⚠️ [FitSync] Delete-failed path missing expected baseline SHA — retry may not be detected', { path });
					}
				} else {
					delete latestRemoteTreeSha[path];
				}
			}
		}

		// 3c. Update local state using SHAs computed by LocalVault (performance optimization)
		// LocalVault computed SHAs from in-memory content during file writes (see docs/sync-logic.md).
		// Benefits: avoids redundant I/O, prevents race conditions, no normalization in Obsidian.
		// Only sync-candidate files included (non-syncable paths like .obsidian/ excluded).
		// Note: We await the SHA promise here (not earlier) to allow parallel computation with other sync operations.
		const newBaselineShas = await localFileOpsRecord.newBaselineStates;

		// Update local state: start with current state, apply writes, remove deletes
		const newLocalState = {
			...currentLocalState, // Start with state from beginning of sync (includes all existing files)
			...newBaselineShas // Update SHAs for all files written (non-clashed + clashes) (#169)
		};

		// Remove deleted files from state
		for (const path of deleteFromLocalNonClashed) {
			if (!localFailedPathsSet.has(path)) {
				delete newLocalState[path];
			}
		}

		// Update pendingClashes: newly-clashed tracked files enter pending state.
		// Remove their baseline so FIT makes no assumption about the canonical version.
		// Untracked clashes are excluded — they use the #169 baseline mechanism instead.
		// Auto-merged canvas clashes are resolved — they don't enter pending state.
		// Paths already in pendingClashes (localState === 'pending') stay there.
		for (const clash of clashes) {
			if (clash.remoteOp !== 'REMOVED' &&
				clash.localState !== 'untracked' &&
				!mergedPaths.has(clash.path)) {
				if (!this.fit.pendingClashes.includes(clash.path)) {
					this.fit.pendingClashes.push(clash.path);
				}
				delete newLocalState[clash.path];
			}
		}

		// Retriable paths: revert to the pre-sync baseline SHA so the file is re-detected as changed
		// on the next sync. Using the previous baseline (not delete) preserves tracking for the case
		// where the user deletes the file before the retry — without a baseline, the deletion would
		// be invisible to compareFileStates and leave an orphaned file on the remote.
		// Do NOT add to unpushedFiles — these are expected to succeed on retry.
		const rateLimitedPaths = pushResult?.rateLimitedPaths ?? [];
		for (const path of rateLimitedPaths) {
			const previousSha = this.fit.localShas[path];
			if (previousSha !== undefined) {
				newLocalState[path] = previousSha;
			} else {
				delete newLocalState[path];
			}
		}
		if (rateLimitedPaths.length > 0) {
			fitLogger.log(`[FitSync] ${rateLimitedPaths.length} file(s) deferred — localShas cleared for retry`, {
				paths: rateLimitedPaths
			});
		}

		if (Object.keys(newBaselineShas).length > 0) {
			fitLogger.log('[FitSync] Updated local state with SHAs from written files', {
				filesProcessed: Object.keys(newBaselineShas).length,
				totalFilesInState: Object.keys(newLocalState).length
			});
		}

		logCacheUpdate(
			'sync',
			this.fit.localShas || {},
			newLocalState,
			this.fit.lastFetchedRemoteShas || {},
			latestRemoteTreeSha,
			this.fit.lastFetchedCommitSha,
			latestCommitSha,
			{ localOpsApplied: localFileOpsRecord.changes.length, remoteOpsPushed: pushedChanges.length }
		);

		// Clean stale unpushedFiles entries before persisting.
		// A file leaves the list when: locally modified (SHA changed → re-enters normal sync),
		// reconciled on remote (remote change detected → normal pull handles it), deleted
		// locally, or excluded by shouldSyncPath (e.g. added to .gitignore).
		const remoteChangesForCleanup = remoteUpdate.remoteChanges ?? [];
		for (const [path, sha] of Object.entries(this.fit.unpushedFiles)) {
			const isModified = newLocalState[path] !== sha;
			const isRemoteReconciled = remoteChangesForCleanup.some(c => c.path === path);
			const isGone = newLocalState[path] === undefined;
			const isIgnored = !this.fit.shouldSyncPath(path);
			if (isModified || isRemoteReconciled || isGone || isIgnored) {
				delete this.fit.unpushedFiles[path];
			}
		}

		const newlySkippedPaths = pushResult?.skippedPaths?.filter(p => !previousUnpushedKeys.has(p)) ?? [];

		// scope:"subset" paths are excluded from the normal pipeline entirely (see
		// syncSubsetScopePaths), so newLocalState/latestRemoteTreeSha never contain them —
		// without this merge, persisting would silently wipe the baselines
		// syncSubsetScopePaths just set, undoing this sync's push/pull on the next one.
		const subsetLocalShas: FileStates = {};
		const subsetRemoteShas: FileStates = {};
		for (const path of new Set([...Object.keys(this.fit.localShas), ...Object.keys(this.fit.lastFetchedRemoteShas)])) {
			if (this.fit.resolveSyncFormat(path) !== 'json' || this.fit.resolveScope(path) !== 'subset') continue;
			if (this.fit.localShas[path] !== undefined) subsetLocalShas[path] = this.fit.localShas[path];
			if (this.fit.lastFetchedRemoteShas[path] !== undefined) subsetRemoteShas[path] = this.fit.lastFetchedRemoteShas[path];
		}

		await this.saveLocalStoreCallback({
			lastFetchedRemoteShas: { ...latestRemoteTreeSha, ...subsetRemoteShas },
			lastFetchedCommitSha: latestCommitSha,
			// TODO: Remove filterSyncedState after fixing bug where remote _fit/ files are passed to applyChanges
			// Currently remote _fit/ paths bypass shouldSyncPath filtering and get SHAs computed.
			// Once fixed, newBaselineStates will only contain syncable paths (no filtering needed).
			localShas: { ...this.fit.filterSyncedState(newLocalState), ...subsetLocalShas },
			unpushedFiles: this.fit.unpushedFiles,
			pendingClashes: this.fit.pendingClashes,
			protectedPathShas: this.fit.protectedPathShas,
			// Only persist localSha if there are still legacy entries remaining (not yet promoted)
			localSha: Object.keys(this.fit.localSha).length > 0 ? this.fit.localSha : undefined,
		});

		return {
			localOps: localFileOpsRecord.changes,
			remoteOps: pushedChanges,
			conflicts: clashes.filter(c => !mergedPaths.has(c.path)),
			newlySkippedPaths,
			skippedWarning: pushResult?.skippedWarning,
			rateLimitedPaths,
			localFailedPaths,
		};
	}

	async sync(syncNotice: FitNotice, options?: { isAutoSync?: boolean }): Promise<SyncResult> {
		if (this.syncPromise) {
			fitLogger.log('[FitSync] Sync already in progress - aborting new sync request');
			return { success: false, error: SyncErrors.alreadySyncing() };
		}
		this.syncPromise = this._doSync(syncNotice, options).finally(() => { this.syncPromise = null; });
		return this.syncPromise;
	}

	private async _doSync(syncNotice: FitNotice, options?: { isAutoSync?: boolean }): Promise<SyncResult> {
		const isAutoSync = options?.isAutoSync ?? false;

		// Snapshots for pre-sync reconciliation rollback (see comment below).
		// Initialized to empty so catch block can always restore safely, even if try throws before mutation.
		let preReconcileProtectedPathShas = {...this.fit.protectedPathShas};
		let preReconcileLocalShas = {...this.fit.localShas};
		let preReconcileLastFetchedRemoteShas = {...this.fit.lastFetchedRemoteShas};

		try {
			syncNotice.setMessage("Checking for changes...");

			// Pre-sync: reconcile paths that became tracked since last sync — remote git content
			// appearing for a previously-untracked .obsidian/ path is the only trigger, no local
			// opt-in exists. Without this, a path with no localShas entry but an existing local
			// file → untrackedPaths → junk clash.
			// Snapshot the three stores mutated here so we can restore them if the sync subsequently fails.
			// saveLocalStoreCallback only runs on success, so in-memory mutations would otherwise leak
			// into the next sync attempt and cause junk clashes or missed reconciliation.
			preReconcileProtectedPathShas = {...this.fit.protectedPathShas};
			preReconcileLocalShas = {...this.fit.localShas};
			preReconcileLastFetchedRemoteShas = {...this.fit.lastFetchedRemoteShas};

			// Candidates: currently-eligible .obsidian/ paths with a known remote SHA (from
			// lastFetchedRemoteShas, always current) but no local baseline yet — excluding
			// pendingClashes paths, whose missing baseline is a deliberate mid-clash state, not
			// "never synced". See docs/sync-logic.md § Tracking transition for the full reasoning.
			const pendingClashSet = new Set(this.fit.pendingClashes);
			const reconcileCandidates = Object.keys(this.fit.lastFetchedRemoteShas).filter(path =>
				path.startsWith(".obsidian/") &&
				!(path in this.fit.localShas) &&
				!pendingClashSet.has(path)
			);
			// isEligibleForTracking below needs current fitAttributes — only worth an eager
			// refresh (extra stat/read outside the normal scan) when there's actually a
			// candidate path that could be reconciled this sync.
			if (reconcileCandidates.length > 0) {
				await this.fit.refreshFitAttributesForReconcile();
			}
			// scope: "subset" paths never belong here (see the protectedPathShas write site in
			// executeSync) — excluded again defensively in case a stale entry exists.
			const reconcilePaths = reconcileCandidates.filter(p =>
				this.fit.isEligibleForTracking(p) &&
				!(this.fit.resolveSyncFormat(p) === 'json' && this.fit.resolveScope(p) === 'subset')
			);
			if (reconcilePaths.length > 0) {
				// Same-sync-only signal: without this, the "file absent locally" branch below
				// (which clears lastFetchedRemoteShas[path]) would make shouldSyncPath's tracked
				// check flip back to false for the rest of this sync, undoing the reconciliation
				// before it's even used. See Fit.trackedForCurrentSync's own comment.
				this.fit.markTrackedForCurrentSync(reconcilePaths);
				fitLogger.log('[FitSync] Reconciling newly-tracked paths', { paths: reconcilePaths });
				for (const path of reconcilePaths) {
					const cachedRemoteSha = this.fit.lastFetchedRemoteShas[path];
					delete this.fit.protectedPathShas[path]; // stale once reconciled here
					try {
						const content = await this.fit.localVault.readFileContent(path);
						const currentSha = await LocalVault.fileSha1(path, content);
						if (currentSha === cachedRemoteSha) {
							// Genuinely safe: local already matches what was last seen on remote.
							// lastFetchedRemoteShas[path] already holds cachedRemoteSha — only
							// localShas needs setting to make this a full no-op (no download).
							this.fit.localShas[path] = currentSha;
						} else {
							// Local differs from the cached remote SHA. That SHA was only ever
							// passively observed while this path was excluded, never established by an
							// actual sync — it doesn't count as a baseline. Leave localShas unset so
							// local shows as ADDED, and explicitly clear lastFetchedRemoteShas so
							// remote also shows as ADDED. Without clearing it, remote would show as
							// unchanged and local's ADDED would go straight to safeLocal, silently
							// pushing local's content over remote's — the same bug in the opposite
							// direction. Both sides showing changed is what makes the normal
							// pipeline resolve this as a genuine clash.
							delete this.fit.lastFetchedRemoteShas[path];
						}
					} catch {
						// File absent locally. Clear the cached remote SHA so remote appears as
						// ADDED and gets pulled this sync.
						delete this.fit.lastFetchedRemoteShas[path];
					}
				}
			}

			// Get local and remote changes in parallel
			// Use allSettled to ensure both operations complete (or fail) before processing
			// This prevents out-of-order logging when one operation fails quickly
			fitLogger.log('🔄 [Sync] Checking local and remote changes (parallel)...');
			const results = await Promise.allSettled([
				this.fit.getLocalChanges(),
				this.fit.getRemoteChanges()
			]);

			// Check for failures and throw the first error encountered
			const [localResult, remoteResult] = results;
			if (localResult.status === 'rejected') {
				throw localResult.reason;
			}
			if (remoteResult.status === 'rejected') {
				throw remoteResult.reason;
			}

			// Both succeeded, extract values
			const {changes: localChanges, state: currentLocalState, orphanedScanPrefixes, unlistablePaths} = localResult.value;
			const {changes: remoteChanges, state: remoteTreeSha, commitSha: remoteCommitSha} = remoteResult.value;
			fitLogger.log('.. ✅ [Sync] Change detection complete');

			// .fitattributes.json is a load-bearing config file — a malformed file silently
			// meaning "nothing configured" deserves a visible warning rather than only a
			// debug-log line (getLocalChanges/refreshFitAttributesForReconcile already logged
			// the parse error itself).
			if (this.fit.fitAttributesWarning) {
				const warningNotice = new FitNotice(this.fit, [], this.fit.fitAttributesWarning, 0);
				warningNotice.show();
			}

			// Diagnostic-only: classify .obsidian/ paths seen this sync that aren't actively
			// syncing (and the one bucket that is), so a user asking "why didn't X sync" has an
			// answer without needing code knowledge. No effect on sync behavior itself — see
			// docs/sync-logic.md § Protected-path detection. Skipped entirely when there's
			// nothing to report (no .obsidian/ activity at all this sync).
			const protectedPathDetection = this.fit.classifyObsidianPathsForLog(currentLocalState, remoteTreeSha);
			const hasProtectedPathActivity = protectedPathDetection.trackedSyncing.length > 0
				|| protectedPathDetection.hardDenylisted.length > 0
				|| protectedPathDetection.trackedUnconfigured.length > 0
				|| protectedPathDetection.untracked.length > 0;
			if (hasProtectedPathActivity) {
				// untracked can be long on a vault with many local-only .obsidian/ files; the logger
				// caps any logged array and marks the truncation with the real total.
				fitLogger.log('[FitSync] Protected-path detection', {
					trackedSyncing: protectedPathDetection.trackedSyncing,
					hardDenylisted: protectedPathDetection.hardDenylisted,
					trackedUnconfigured: protectedPathDetection.trackedUnconfigured,
					untracked: protectedPathDetection.untracked,
				});
				if (protectedPathDetection.trackedSyncing.length > 0) {
					fitLogger.log(
						'[FitSync] Note: to stop syncing any of the above trackedSyncing paths, ' +
						'remove them from your GitHub repo — .fitattributes.json only changes how a ' +
						'tracked path syncs, not whether it is tracked.'
					);
				}
			}

			// Phase 0: Resolve pending clashes
			// For each path with an unresolved _fit/ copy, check if the user has resolved it.
			// Snapshot before any mutation below - syncSubsetScopePaths (after this block) needs
			// to know which paths were pending going into this sync, to tell "still unresolved"
			// apart from "just resolved this sync" once this block's own mutation below removes
			// a resolved path from the live list.
			const previouslyPendingClashPaths = new Set(this.fit.pendingClashes);
			const activePendingPaths = new Set<string>();
			const pendingDeletions: string[] = [];
			// Paths resolved with content matching remote — already in sync, no push needed.
			const resolvedNoChangePaths = new Set<string>();

			if (this.fit.pendingClashes.length > 0) {
				fitLogger.log('.. ⏳ [Phase0] Checking pending clashes', { count: this.fit.pendingClashes.length, paths: this.fit.pendingClashes });
				const pathsToCheck = [
					...this.fit.pendingClashes.map(p => `_fit/${p}`),
					...this.fit.pendingClashes,
				];
				// All paths here are tracked (non-hidden, non-protected), so vault index would
				// suffice for existence checks. collectFilesystemState uses adapter.stat, which
				// is fine given the small count; if this becomes a bottleneck, check
				// getAbstractFileByPath first and fall back to adapter.stat only on null.
				const { existenceMap: pendingExistenceMap } = await this.collectFilesystemState(pathsToCheck);
				const stillPending: string[] = [];
				const fitCopiesToDelete: string[] = [];

				for (const path of this.fit.pendingClashes) {
					const fitState = pendingExistenceMap.get(`_fit/${path}`);
					const localState = pendingExistenceMap.get(path);

					if (fitState === undefined || localState === undefined) {
						// Stat failed — keep pending conservatively
						activePendingPaths.add(path);
						stillPending.push(path);
						continue;
					}

					const fitExists = fitState !== 'nonexistent';
					const localExists = localState !== 'nonexistent';

					if (!fitExists) {
						// _fit/ deleted by user — clash is resolved
						if (!localExists) {
							// Both gone — push deletion to remote
							pendingDeletions.push(path);
						}
						// If local exists: no baseline → ADDED → pushed in normal detection
					} else if (!localExists) {
						// _fit/ remains and local is still absent — indistinguishable from a
						// delete/modify clash's original creation state (local was already
						// absent when the clash was made). The only unambiguous resolution
						// signal here is deleting the _fit/ copy (handled above); keep pending.
						activePendingPaths.add(path);
						stillPending.push(path);
					} else {
						// Both exist — resolved if content matches, still pending otherwise
						try {
							const [fitContent, localContent] = await Promise.all([
								this.fit.localVault.readFileContent(`_fit/${path}`),
								this.fit.localVault.readFileContent(path),
							]);
							const [fitSha, localSha] = await Promise.all([
								LocalVault.fileSha1(path, fitContent),
								LocalVault.fileSha1(path, localContent),
							]);

							if (fitSha === localSha) {
								// Resolved — queue _fit/ copy for deletion; path re-enters normal detection
								fitCopiesToDelete.push(`_fit/${path}`);
								// Check if local content already matches remote — if so, no push needed.
								// readFileContent returns cached content from readFromSource (no extra network call).
								try {
									const remoteContent = await this.fit.remoteVault.readFileContent(path);
									if (localContent.equals(remoteContent)) {
										resolvedNoChangePaths.add(path);
									}
								} catch {
									// Can't read remote — safe to push (may cause harmless re-push)
								}
							} else {
								activePendingPaths.add(path);
								stillPending.push(path);
							}
						} catch {
							// Can't read — keep pending conservatively
							activePendingPaths.add(path);
							stillPending.push(path);
						}
					}
				}

				if (fitCopiesToDelete.length > 0) {
					await this.fit.localVault.applyChanges([], fitCopiesToDelete);
				}

				const originalCount = this.fit.pendingClashes.length;
				this.fit.pendingClashes = stillPending;

				fitLogger.log('.. ✅ [Phase0] Pending clash check complete', {
					resolved: originalCount - stillPending.length,
					stillPending: stillPending.length,
					activePending: activePendingPaths.size,
					pendingDeletions: pendingDeletions.length,
					resolvedNoChange: resolvedNoChangePaths.size,
				});
			}

			// scope: "subset" .obsidian/ paths are handled entirely here, before the normal
			// pipeline — they're excluded from it (Fit.shouldSyncPath) since whole-file SHA
			// comparison doesn't work for a masked path. See syncSubsetScopePaths' doc comment.
			// Runs after Phase 0 above (not before) so a subset-scope path's own pending-clash
			// resolution (deleted _fit/ copy) is already reflected in this.fit.pendingClashes
			// before resolveSubsetScopePath re-derives anything from it — otherwise this lane's
			// own clash-detection would re-write _fit/<path> before Phase 0 ever got to check
			// whether the user had deleted it (see resolveSubsetScopePath's justResolved handling).
			//
			// remoteFitAttributes only exists from here on — it needs remoteTreeSha, which
			// itself only exists after the local/remote scan (above) has already run. That scan
			// is where Fit.shouldSyncPath decided, from local's rule alone, which paths even
			// reached localChanges/remoteChanges in the first place — so a path where local and
			// remote disagree about scope:"subset" is already sitting in those arrays under the
			// wrong assumption by the time we get here, and has to be patched out below
			// (filteredLocalChanges/filteredRemoteChanges) instead of never having been added.
			// A continuously-evaluating engine — local state as a live input feeding whatever
			// remote fetches it actually needs, rather than fixed local-scan/remote-fetch/reconcile
			// phases run in a set order — wouldn't have this problem: shouldSyncPath's decision
			// would just be re-askable once remote's rule is known, not baked into an
			// already-produced list from a scan that ran before that rule existed.
			const remoteFitAttributes = await this.resolveRemoteFitAttributes(remoteTreeSha);
			const subsetScopeResult = await this.syncSubsetScopePaths(remoteTreeSha, remoteFitAttributes, previouslyPendingClashPaths);
			const subsetScopeHandledPaths = new Set(subsetScopeResult.handledPaths);

			// localChanges is pre-filtered by getLocalChanges() (shouldTrackState + shouldSyncPath).
			// pendingDeletions come from pendingClashes which were synced paths originally.
			const filteredLocalChanges = [
				...localChanges
					.filter(c => !activePendingPaths.has(c.path))
					.filter(c => !resolvedNoChangePaths.has(c.path))
					// subsetScopeHandledPaths: a path where local's and remote's resolved rule
					// disagree about scope:"subset" — already handled above, must not also be
					// opaquely diffed/overwritten by the normal pipeline. See the comment above
					// subsetScopeResult's call site for why this can't just be "never scanned".
					.filter(c => !subsetScopeHandledPaths.has(c.path)),
				...pendingDeletions.map(path => ({ path, type: 'REMOVED' as const })),
			];
			// Paths the local scan pruned are out of scope in both directions this sync: local
			// side is excluded in Fit.getLocalChanges, and a remote change here would be applied
			// against a local state this sync never looked at (e.g. a remote deletion removing
			// a local edit nobody scanned). See docs/sync-logic.md § Scan-time pruning.
			const filteredRemoteChanges = remoteChanges.filter(c =>
				!subsetScopeHandledPaths.has(c.path) && !isUnderAnyPrefix(c.path, orphanedScanPrefixes));

			// Log detected changes for diagnostics
			const localCount = filteredLocalChanges.length;
			const remoteCount = filteredRemoteChanges.length;

			if (localCount > 0 || remoteCount > 0) {
				const logData: Record<string, Record<string, string[]>> = {};

				if (localCount > 0) {
					const localData: Record<string, string[]> = {};
					['ADDED', 'MODIFIED', 'REMOVED'].forEach(changeType => {
						const files = filteredLocalChanges.filter(c => c.type === changeType).map(c => c.path);
						if (files.length > 0) localData[changeType] = files;
					});
					logData.local = localData;
				}

				if (remoteCount > 0) {
					const remoteData: Record<string, string[]> = {};
					['ADDED', 'MODIFIED', 'REMOVED'].forEach(changeType => {
						const files = filteredRemoteChanges.filter(c => c.type === changeType).map(c => c.path);
						if (files.length > 0) remoteData[changeType] = files;
					});
					logData.remote = remoteData;
				}

				fitLogger.log(`🔄 [FitSync] Syncing changes (${localCount} local, ${remoteCount} remote)`, logData);
			}

			// Phase 2: Compare & Resolve - determine safe vs clashed changes
			const localScanPaths = new Set(Object.keys(currentLocalState));
			const remoteScanPaths = new Set(Object.keys(remoteTreeSha));
			const { safeLocal, safeRemote: initialSafeRemote, clashes: initialClashes, protectedRemote, untrackNotices, existenceMap } = await this.compareAndResolveChanges(
				filteredLocalChanges,
				filteredRemoteChanges,
				localScanPaths,
				remoteScanPaths,
				currentLocalState,
				remoteTreeSha
			);

			// Reclassify safeRemote items for active pending paths — new remote changes must
			// go to _fit/ only, not overwrite the local file whose status is unresolved.
			const reclassifiedFromSafeRemote = new Set(
				initialSafeRemote.filter(c => activePendingPaths.has(c.path)).map(c => c.path)
			);
			const safeRemote = initialSafeRemote.filter(c => !activePendingPaths.has(c.path));
			// Reminder-only pending clashes: still unresolved from a prior sync, no new remote change
			// this cycle. Included in clashes for state-management purposes (prevents the path from
			// leaking back into localShas via currentLocalState), but passed separately so executeSync
			// can skip the download+write step — remote content is unchanged, nothing new to write.
			// Note: remote deletion of a pending path arrives via remoteChanges as REMOVED and is
			// reclassified above with the real remoteOp, so it never ends up here as a reminder.
			const pendingReminderPaths = new Set(
				[...activePendingPaths]
					.filter(p => !reclassifiedFromSafeRemote.has(p))
					.filter(p => !initialClashes.some(c => c.path === p))
			);
			const clashes = [
				...initialClashes,
				...initialSafeRemote
					.filter(c => activePendingPaths.has(c.path))
					.map(c => ({ path: c.path, localState: 'pending' as const, remoteOp: c.type })),
				...[...pendingReminderPaths]
					.map(p => ({ path: p, localState: 'pending' as const, remoteOp: 'MODIFIED' as const })),
			];

			// Phase 3: Execute - push, pull, persist (atomic operation)
			// subsetScopeResult.commitSha (if set) is strictly newer than remoteCommitSha —
			// the subset lane may have already pushed its own commit earlier this same sync,
			// which the initial remote fetch above couldn't have known about. Without this,
			// a sync where only subset-scope paths changed persists the stale pre-push commit
			// SHA (executeSync's own pushResult-null fallback uses this same value), showing
			// the wrong "Synced to commit" in Explain Sync Status even though the push
			// succeeded.
			const remoteCommitShaAfterSubsetPush = subsetScopeResult.commitSha ?? remoteCommitSha;
			const { localOps, remoteOps, conflicts: executedConflicts, newlySkippedPaths, skippedWarning, rateLimitedPaths, localFailedPaths } = await this.executeSync(
				currentLocalState,
				{
					remoteChanges: filteredRemoteChanges,
					remoteTreeSha,
					latestRemoteCommitSha: remoteCommitShaAfterSubsetPush
				},
				safeLocal,
				safeRemote,
				clashes,
				protectedRemote,
				pendingReminderPaths,
				existenceMap,
				syncNotice
			);

			const conflicts = [...executedConflicts, ...subsetScopeResult.clashes];

			// Log conflicts if any (these are real unresolved conflicts, not temporary clashes)
			if (conflicts.length > 0) {
				fitLogger.log('[FitSync] Sync completed with conflicts', {
					conflictCount: conflicts.length,
					conflicts: conflicts.map(c => ({
						path: c.path,
						local: c.localState,
						remote: c.remoteOp
					}))
				});
			}

			// Show tiered warning for files still awaiting manual sync
			const remainingUnpushed = Object.keys(this.fit.unpushedFiles);
			if (remainingUnpushed.length > 0) {
				if (newlySkippedPaths.length > 0 && skippedWarning) {
					// First encounter: full sticky notice with git CLI instructions, separate from syncNotice
					new FitNotice(this.fit, [], skippedWarning, 0).show();
				}
				// Auto-sync with no new skips, or a repeat manual sync: logged only, no sticky notice —
				// the brief reminder below (added to syncNotice) covers the manual-sync case.
				fitLogger.log('[FitSync] Files still awaiting manual sync', { paths: remainingUnpushed });
			}

			// One headline plus independent detail blocks, set via a single setMessage call below —
			// not one setMessage per condition, since those silently clobber each other.
			const headline = rateLimitedPaths.length > 0 || localFailedPaths.length > 0
				? `Sync incomplete`
				: executedConflicts.length === 0
					? `Sync successful`
					: executedConflicts.some(f => f.remoteOp !== "REMOVED")
						? `Synced with remote, unresolved conflicts written to _fit`
						: `Synced with remote, ignored remote deletion of locally changed files`;

			const detailBlocks: string[] = [];

			if (remainingUnpushed.length > 0 && !isAutoSync && !(newlySkippedPaths.length > 0 && skippedWarning)) {
				const fileList = remainingUnpushed.map(p => `• ${p}`).join('\n');
				detailBlocks.push(`${remainingUnpushed.length} file(s) still need manual sync:\n${fileList}`);
			}

			if (unlistablePaths.length > 0) {
				// '/' means the root listing failed, so the whole hidden-file scan was skipped.
				const pathList = unlistablePaths
					.map(p => p === '/' ? '• / (the whole hidden-file scan)' : `• ${p}`)
					.join('\n');
				detailBlocks.push(
					`${unlistablePaths.length} path(s) couldn't be scanned for hidden files, possibly due to an ` +
					`unreadable entry inside, so hidden files under them are not syncing:\n${pathList}`
				);
			}

			if (rateLimitedPaths.length > 0) {
				const fileList = rateLimitedPaths.map(p => `• ${p}`).join('\n');
				detailBlocks.push(
					`${rateLimitedPaths.length} file(s) not uploaded, possibly due to rate limiting or a ` +
					`transient error. They will be retried automatically on the next sync.\n${fileList}`
				);
			}

			if (localFailedPaths.length > 0) {
				const fileList = localFailedPaths.map(p => `• ${p}`).join('\n');
				detailBlocks.push(
					`${localFailedPaths.length} file(s) couldn't be written locally, possibly due to a ` +
					`filesystem error or a temporary conflict. They will be retried automatically on the next sync.\n${fileList}`
				);
			}

			syncNotice.setMessage([headline, ...detailBlocks].join('\n\n'));

			return {
				success: true,
				changeGroups: [
					// untrackNotices are pre-tagged MODIFIED with a note (see resolveAllChanges) so
					// they render as an ordinary file change, not a real REMOVED.
					{heading: "Local file updates:", changes: [...localOps, ...untrackNotices, ...subsetScopeResult.localOps]},
					{heading: "Remote file updates:", changes: [...remoteOps, ...subsetScopeResult.remoteOps]},
				],
				clash: conflicts
			};

		} catch (error) {
			// Handle unexpected errors that escape from individual sync operations.

			// Restore pre-reconciliation in-memory state so next sync attempt can re-run reconciliation.
			// saveLocalStoreCallback only fires on success, so without this restore the mutations leak.
			this.fit.protectedPathShas = preReconcileProtectedPathShas;
			this.fit.localShas = preReconcileLocalShas;
			this.fit.lastFetchedRemoteShas = preReconcileLastFetchedRemoteShas;

			// VaultError from vault operations (both LocalVault and RemoteGitHubVault)
			if (error instanceof VaultError) {
				fitLogger.log('❌ [FitSync] Sync failed', { errorType: error.type, message: error.message });
				return { success: false, error };
			}

			// All other errors - sync orchestration failures
			const errorMessage = error instanceof Error
				? String(error) // Gets "ErrorType: message" which includes both type and message
				: (error && typeof error === 'object' && 'message' in error)
					? String((error as { message: unknown }).message)
					: `Generic error: ${String(error)}`; // May result in '[object Object]' but it's the best we can do
			fitLogger.log('❌ [FitSync] Sync failed', { errorType: 'unknown', message: errorMessage });
			return { success: false, error: SyncErrors.unknown(errorMessage, { originalError: error }) };
		}
	}

	private async pushChangedFilesToRemote(
		localUpdate: {
			localChanges: FileChange[],
			parentCommitSha: CommitSha
		},
		existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>
	): Promise<{pushedChanges: FileChange[], lastFetchedRemoteShas: FileStates, lastFetchedCommitSha: CommitSha, skippedPaths?: string[], skippedWarning?: string, rateLimitedPaths?: string[]}|null> {
		if (localUpdate.localChanges.length === 0) {
			return null;
		}

		// Prepare files to write and delete by reading content from local vault
		const filesToWrite: Array<{path: string, content: FileContent}> = [];
		const filesToDelete: Array<string> = [];

		for (const change of localUpdate.localChanges) {
			if (change.type === 'REMOVED') {
				// SAFEGUARD: Verify file physically absent before deleting from remote
				// Prevents data loss when filtering rules change between versions
				const existence = existenceMap.get(change.path);

				// Only proceed with deletion if we KNOW the file doesn't exist
				// If stat failed (undefined) or file exists, skip deletion (fail-safe)
				if (existence !== 'nonexistent') {
					fitLogger.log('[FitSync] Skipping deletion - couldn\'t confirm local file actually deleted', {
						path: change.path,
						existence,
						reason: existence === undefined
							? 'Could not verify file absence (stat failed or path not checked)'
							: 'File present on filesystem but absent from state cache (likely filtering rule change)'
					});
					continue; // Don't delete from remote
				}
				filesToDelete.push(change.path);
			} else {
				const content = await this.fit.localVault.readFileContent(change.path);
				filesToWrite.push({ path: change.path, content });
			}
		}

		const result = await this.fit.remoteVault.applyChanges(filesToWrite, filesToDelete, { clashPaths: new Set() });

		// Show user warning if encoding issues detected during upload
		if (result.userWarning) {
			const warningNotice = new FitNotice(this.fit, [], result.userWarning, 0);
			warningNotice.show();
		}

		// If no operations were performed, return null (or with skipped paths if applicable)
		// This can happen when local SHA differs from cache but content matches remote
		// (spurious change due to SHA normalization or caching issues), or when all files
		// were skipped due to size limits.
		if (result.changes.length === 0) {
			fitLogger.log('[FitSync] No remote changes needed - content already matches or all files skipped', {
				localChangesDetected: localUpdate.localChanges.length,
				skippedCount: result.skippedPaths?.length ?? 0,
				reason: result.skippedPaths?.length
					? 'All files skipped due to API size limit (422)'
					: 'Local content matches remote despite SHA cache mismatch (likely SHA normalization or cache inconsistency)'
			});
			if (result.skippedPaths?.length || result.rateLimitedPaths?.length) {
				// Return minimal push result so caller can update unpushedFiles / clear retriable SHAs
				return {
					pushedChanges: [],
					lastFetchedRemoteShas: result.newState,
					lastFetchedCommitSha: result.commitSha,
					skippedPaths: result.skippedPaths,
					skippedWarning: result.skippedWarning,
					rateLimitedPaths: result.rateLimitedPaths,
				};
			}
			return null;
		}

		const pushedChanges = result.changes.map(op => {
			const originalChange = localUpdate.localChanges.find(c => c.path === op.path);
			return originalChange || { path: op.path, type: op.type };
		});

		return {
			pushedChanges,
			lastFetchedRemoteShas: result.newState,
			lastFetchedCommitSha: result.commitSha,
			skippedPaths: result.skippedPaths,
			skippedWarning: result.skippedWarning,
			rateLimitedPaths: result.rateLimitedPaths,
		};
	}

	/**
	 * Generate user-friendly error message from structured sync error.
	 * Converts technical sync errors into messages appropriate for end users.
	 */
	getSyncErrorMessage(syncError: SyncError): string {
		let baseMessage: string;

		// Handle VaultError types (thrown by LocalVault and RemoteGitHubVault)
		if (syncError instanceof VaultError) {
			switch (syncError.type) {
				case 'network':
					baseMessage = `${syncError.message}. Please check your internet connection.`;
					break;
				case 'authentication':
					switch (syncError.details?.authSubtype) {
						case 'rate_limited': {
							const resetAt = syncError.details?.rateLimitResetAt;
							const resetNote = resetAt ? ` Try again after ${new Date(resetAt).toLocaleTimeString()}.` : ' Try again shortly.';
							baseMessage = `${syncError.message}.${resetNote}`;
							break;
						}
						case 'sso_required':
							baseMessage = `${syncError.message}. Authorize your token for SSO, then try again.`;
							break;
						default:
							baseMessage = `${syncError.message}. Check your GitHub personal access token.`;
					}
					break;
				case 'remote_not_found':
					baseMessage = `${syncError.message}. Check your repo and branch settings.`;
					break;
				case 'filesystem':
					baseMessage = `File system error: ${syncError.message}`;
					break;
			}

			// Append per-file error details if available
			if (syncError.details?.errors && syncError.details.errors.length > 0) {
				const errorEntries = syncError.details.errors;
				if (errorEntries.length <= 3) {
					// Show all errors with details for small counts
					baseMessage += '\n\nFailed files:';
					for (const { path, error } of errorEntries) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						// Show only first line for multi-line errors (full error in console/logs)
						const displayMsg = errorMsg.split('\n')[0];
						baseMessage += `\n  • ${path}: ${displayMsg}`;
					}
				} else {
					// Show first 3 with details, then summarize rest
					baseMessage += `\n\nFailed files (${errorEntries.length} total):`;
					for (let i = 0; i < 3; i++) {
						const { path, error } = errorEntries[i];
						const errorMsg = error instanceof Error ? error.message : String(error);
						const displayMsg = errorMsg.split('\n')[0];
						baseMessage += `\n  • ${path}: ${displayMsg}`;
					}
					baseMessage += `\n  • ... and ${errorEntries.length - 3} more`;
				}

				// Add recovery guidance for per-file errors
				baseMessage += '\n\n💡 To exclude a file from sync, add it to .gitignore.';
			}
		} else {
			// Handle SyncOrchestrationError (type === 'unknown' | 'already-syncing')
			baseMessage = syncError.detailMessage;
		}

		return baseMessage;
	}

	async explainStatus(): Promise<StatusExplanation> {
		fitLogger.log('[ExplainStatus] Checking sync status...');

		const snapshot: SyncStatusSnapshot = {
			lastFetchedCommitSha: this.fit.lastFetchedCommitSha,
			trackedFileCount: Object.keys(this.fit.localShas).length,
			pendingClashes: [...this.fit.pendingClashes],
			oversizedFilePaths: Object.keys(this.fit.unpushedFiles ?? {}),
			fitAttributesWarning: this.fit.fitAttributesWarning,
			possiblyChangedSubsetScopePaths: [],
		};

		if (!snapshot.lastFetchedCommitSha) {
			return { kind: 'never-synced' };
		}

		let localChanges: FileChange[] | null = null;
		let scanFailedPaths: string[] | undefined;

		try {
			const result = await this.fit.getLocalChanges();
			localChanges = result.changes;
			// getLocalChanges() may have just refreshed fitAttributesWarning (lazy hook) —
			// use the post-scan value so Explain reflects the current file, not last sync's.
			snapshot.fitAttributesWarning = this.fit.fitAttributesWarning;

			// scope:"subset" paths are excluded from `changes` above (Fit.shouldSyncPath), since
			// they don't go through the normal push/pull pipeline — but result.state (the raw
			// local scan, unfiltered) already has today's raw whole-file SHA for them too, for
			// free. Diffed against localShas[path] (same raw-SHA meaning for every path, see
			// FitSync.syncSubsetScopePaths), this is a real, network-free signal that the file
			// moved since last sync — coarser than a normal pending change (it can't tell
			// whether the edit landed in a tracked field or not, only a live remote fetch can),
			// so it's surfaced as its own distinctly-worded, "unconfirmed" section rather than
			// folded into the ordinary Pending local changes list.
			//
			// Candidates are drawn from lastFetchedRemoteShas, NOT from every local .json path
			// that defaults to format:"json"/scope:"subset" — git-mask tracking requires actual
			// remote content to have been observed at least once (FitSync.syncSubsetScopePaths
			// only ever resolves paths present in that sync's remote tree). A path with no
			// remote baseline at all is untracked, same as any other git-mask path: nothing to
			// sync, regardless of what format/scope it would default to.
			const subsetScopePaths = new Set(
				Object.keys(this.fit.lastFetchedRemoteShas).filter(path =>
					path.startsWith('.obsidian/') &&
					!this.fit.isHardDenylistedPath(path) &&
					this.fit.resolveSyncFormat(path) === 'json' &&
					this.fit.resolveScope(path) === 'subset'
				)
			);
			if (subsetScopePaths.size > 0) {
				const subsetCurrent: FileStates = {};
				const subsetBaseline: FileStates = {};
				for (const path of subsetScopePaths) {
					if (result.state[path] !== undefined) subsetCurrent[path] = result.state[path];
					if (this.fit.localShas[path] !== undefined) subsetBaseline[path] = this.fit.localShas[path];
				}
				snapshot.possiblyChangedSubsetScopePaths = compareFileStates(subsetCurrent, subsetBaseline)
					.filter(c => !this.fit.pendingClashes.includes(c.path));
			}
		} catch (err) {
			scanFailedPaths = err instanceof VaultError && err.details?.failedPaths
				? err.details.failedPaths
				: [];
			fitLogger.log('[ExplainStatus] Vault scan failed', err);
		}

		// Pre-classify local changes that exceed GitHub's 100MB file size limit.
		// These will fail on push just like files already in unpushedFiles.
		if (localChanges) {
			const GITHUB_SIZE_LIMIT = 100 * 1024 * 1024;
			const knownOversized = new Set(snapshot.oversizedFilePaths);
			for (const change of localChanges) {
				if (change.type === 'REMOVED') continue;
				const size = this.fit.localVault.getFileSizeBytes(change.path);
				if (size !== null && size >= GITHUB_SIZE_LIMIT && !knownOversized.has(change.path)) {
					snapshot.oversizedFilePaths = [...snapshot.oversizedFilePaths, change.path];
					knownOversized.add(change.path);
				}
			}
		}

		return buildStatusExplanation(snapshot, localChanges, scanFailedPaths);
	}

	async clear(): Promise<boolean> {
		const newLocalStore = await this.fit.remoteVault.clear();

		if (newLocalStore != null) {
			await this.saveLocalStoreCallback(newLocalStore);
			return true;
		}

		return false;
	}
}
