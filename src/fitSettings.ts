// V1: only "replace" supported. V2 will add "array-merge" | "fields".
export type ObsidianSyncStrategy = "replace";

export interface ObsidianSyncRule {
	sync?: ObsidianSyncStrategy;
	// Known top-level JSON field names captured at enable time.
	// UI warns when the file gains fields not in this list.
	// undefined = not yet captured (no warning shown).
	fields?: string[];
}

// Map of .obsidian/ file path → sync rule. Paths not listed are not synced.
export type ObsidianSyncRules = Record<string, ObsidianSyncRule>;

/** True if the UI can safely read/write this rule (v1 strategies only). */
export function isUiManaged(rule: ObsidianSyncRule): boolean {
	return rule.sync === undefined || rule.sync === "replace";
}

/** Returns fields in currentFields not present in knownFields. */
export function findNewFields(knownFields: string[], currentFields: string[]): string[] {
	const known = new Set(knownFields);
	return currentFields.filter(f => !known.has(f));
}

export interface FitSettings {
	// TODO: When adding support for multiple remote providers (GitLab, Gitea),
	// consider using a discriminated union structure:
	// remote: { provider: "github", pat: string, owner: string, ... }
	//       | { provider: "gitlab", token: string, project: string, ... }
	//       | { provider: "gitea", token: string, owner: string, ... }
	// This would allow type-safe, provider-specific settings.
	// See RemoteVaultProvider type in src/vault.ts for provider enum.
	encryptionPassword: string;
	pat: string;
	owner: string;       // Owner of the repo (may differ from authenticated user for contributor repos)
	avatarUrl: string;
	repo: string;
	branch: string;
	deviceName: string;
	checkEveryXMinutes: number
	autoSync: "on" | "off" | "muted" | "remind"
	notifyChanges: boolean
	notifyConflicts: boolean
	enableDebugLogging: boolean
	syncHiddenFiles: boolean
	obsidianSyncRules: ObsidianSyncRules
}

export const DEFAULT_SETTINGS: FitSettings = {
	encryptionPassword: "",
	pat: "",
	owner: "",
	avatarUrl: "",
	repo: "",
	branch: "",
	deviceName: "",
	checkEveryXMinutes: 5,
	autoSync: "off",
	notifyChanges: true,
	notifyConflicts: true,
	enableDebugLogging: true,
	syncHiddenFiles: true,
	obsidianSyncRules: {},
};
