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
	fileChangesNoticeDurationSec: number   // 0 = stays until clicked
	notifyConflicts: boolean
	enableDebugLogging: boolean
	syncHiddenFiles: boolean
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
	fileChangesNoticeDurationSec: 0,   // preserves current "click to dismiss" behavior by default
	notifyConflicts: true,
	enableDebugLogging: true,
	syncHiddenFiles: true,
};
