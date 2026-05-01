#!/usr/bin/env node
/**
 * FIT CLI - Command-line interface for syncing an Obsidian vault with GitHub.
 *
 * Allows autonomous agents and CI systems to manage an Obsidian vault
 * without running the Obsidian desktop app.
 *
 * Usage:
 *   fit sync  [options]    Sync local vault with remote GitHub repository
 *   fit status [options]   Show pending local and remote changes (dry-run)
 *
 * Options:
 *   --vault <path>         Path to the Obsidian vault directory (required)
 *   --pat <token>          GitHub personal access token (or FIT_PAT env var)
 *   --owner <owner>        GitHub repository owner
 *   --repo <repo>          GitHub repository name
 *   --branch <branch>      Branch to sync against (default: main)
 *   --device <name>        Device name for commit messages (default: hostname)
 *   --config <path>        Path to JSON config file
 *   --state <path>         Path to state file (default: <vault>/.fit-state.json)
 *   --json                 Output results as JSON
 *   --verbose              Enable verbose/debug logging to stderr
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { NodeLocalVault } from "./nodeLocalVault";
import { CliNotice } from "./cliNotice";
import { Fit } from "../fit";
import { FitSync } from "../fitSync";
import type { FitSettings, LocalStores } from "../../main";

// ============================================================================
// Types
// ============================================================================

interface CliConfig {
	vaultPath: string;
	pat: string;
	owner: string;
	repo: string;
	branch: string;
	deviceName: string;
	stateFile?: string;
}

interface CliOptions extends Partial<CliConfig> {
	configFile?: string;
	json?: boolean;
	verbose?: boolean;
}

// ============================================================================
// Config loading
// ============================================================================

/** Load config from a JSON file, returns {} if not found */
async function loadConfigFile(configPath: string): Promise<Partial<CliConfig>> {
	try {
		const raw = await fs.readFile(configPath, "utf-8");
		return JSON.parse(raw) as Partial<CliConfig>;
	} catch (error) {
		const err = error as { code?: string; message?: string };
		if (err.code === "ENOENT") return {};
		throw new Error(`Failed to load config file ${configPath}: ${err.message}`);
	}
}

/** Load persisted local state (SHA caches) */
async function loadState(stateFile: string): Promise<LocalStores> {
	const defaultState: LocalStores = {
		localSha: {},
		lastFetchedCommitSha: null,
		lastFetchedRemoteSha: {},
	};
	try {
		const raw = await fs.readFile(stateFile, "utf-8");
		return { ...defaultState, ...JSON.parse(raw) };
	} catch (error) {
		const err = error as { code?: string; message?: string };
		if (err.code === "ENOENT") return defaultState;
		throw new Error(`Failed to load state file ${stateFile}: ${err.message}`);
	}
}

/** Persist local state (SHA caches) after sync */
async function saveState(stateFile: string, state: LocalStores): Promise<void> {
	await fs.mkdir(path.dirname(stateFile), { recursive: true });
	await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf-8");
}

// ============================================================================
// Argument parsing
// ============================================================================

function parseArgs(args: string[]): { command: string; options: CliOptions } {
	const options: CliOptions = {};
	let command = "help";

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "sync" || arg === "status" || arg === "help") {
			command = arg;
		} else if (arg === "--vault" && args[i + 1]) {
			options.vaultPath = args[++i];
		} else if (arg === "--pat" && args[i + 1]) {
			options.pat = args[++i];
		} else if (arg === "--owner" && args[i + 1]) {
			options.owner = args[++i];
		} else if (arg === "--repo" && args[i + 1]) {
			options.repo = args[++i];
		} else if (arg === "--branch" && args[i + 1]) {
			options.branch = args[++i];
		} else if (arg === "--device" && args[i + 1]) {
			options.deviceName = args[++i];
		} else if (arg === "--config" && args[i + 1]) {
			options.configFile = args[++i];
		} else if (arg === "--state" && args[i + 1]) {
			options.stateFile = args[++i];
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--verbose") {
			options.verbose = true;
		}
	}

	return { command, options };
}

/** Merge config from file + CLI args + environment variables */
async function resolveConfig(options: CliOptions): Promise<CliConfig> {
	let fileConfig: Partial<CliConfig> = {};

	// Load from explicit --config or default locations
	const configPath =
		options.configFile ??
		process.env.FIT_CONFIG ??
		path.join(os.homedir(), ".fit-cli.json");
	fileConfig = await loadConfigFile(configPath);

	const merged: CliConfig = {
		vaultPath:
			options.vaultPath ?? fileConfig.vaultPath ?? process.env.FIT_VAULT ?? "",
		pat: options.pat ?? fileConfig.pat ?? process.env.FIT_PAT ?? "",
		owner: options.owner ?? fileConfig.owner ?? process.env.FIT_OWNER ?? "",
		repo: options.repo ?? fileConfig.repo ?? process.env.FIT_REPO ?? "",
		branch:
			options.branch ?? fileConfig.branch ?? process.env.FIT_BRANCH ?? "main",
		deviceName:
			options.deviceName ??
			fileConfig.deviceName ??
			process.env.FIT_DEVICE ??
			os.hostname(),
		stateFile: options.stateFile ?? fileConfig.stateFile,
	};

	return merged;
}

function validateConfig(config: CliConfig): string[] {
	const errors: string[] = [];
	if (!config.vaultPath)
		errors.push("--vault (or FIT_VAULT env var) is required");
	if (!config.pat) errors.push("--pat (or FIT_PAT env var) is required");
	if (!config.owner) errors.push("--owner (or FIT_OWNER env var) is required");
	if (!config.repo) errors.push("--repo (or FIT_REPO env var) is required");
	return errors;
}

// ============================================================================
// Commands
// ============================================================================

async function runSync(config: CliConfig, options: CliOptions): Promise<void> {
	const stateFile =
		config.stateFile ?? path.join(config.vaultPath, ".fit-state.json");
	const localStores = await loadState(stateFile);

	const settings: FitSettings = {
		pat: config.pat,
		owner: config.owner,
		avatarUrl: "",
		repo: config.repo,
		branch: config.branch,
		deviceName: config.deviceName,
		checkEveryXMinutes: 5,
		autoSync: "off",
		notifyChanges: false,
		notifyConflicts: false,
		enableDebugLogging: options.verbose ?? false,
	};

	const localVault = new NodeLocalVault(config.vaultPath);

	let persistedState = localStores;
	const saveLocalStoreCallback = async (
		updates: Partial<LocalStores>,
	): Promise<void> => {
		persistedState = { ...persistedState, ...updates };
		await saveState(stateFile, persistedState);
	};

	const onUserWarning = (message: string): void => {
		process.stderr.write(`[FIT WARNING] ${message}\n`);
	};

	const fit = new Fit(settings, localStores, localVault);
	const fitSync = new FitSync(fit, saveLocalStoreCallback, onUserWarning);
	const notice = new CliNotice();

	const result = await fitSync.sync(notice);

	if (result.success) {
		const totalChanges = result.changeGroups.reduce(
			(sum, g) => sum + g.changes.length,
			0,
		);
		const hasConflicts = result.clash.length > 0;

		if (options.json) {
			process.stdout.write(
				JSON.stringify(
					{
						success: true,
						changes: result.changeGroups.map((g) => ({
							heading: g.heading,
							files: g.changes.map((c) => ({ path: c.path, type: c.type })),
						})),
						conflicts: result.clash.map((c) => ({
							path: c.path,
							localState: c.localState,
							remoteOp: c.remoteOp,
						})),
					},
					null,
					2,
				) + "\n",
			);
		} else {
			if (totalChanges === 0 && !hasConflicts) {
				process.stdout.write("✓ Already up to date.\n");
			} else {
				for (const group of result.changeGroups) {
					if (group.changes.length === 0) continue;
					process.stdout.write(`\n${group.heading}\n`);
					for (const change of group.changes) {
						const icon =
							change.type === "ADDED"
								? "+"
								: change.type === "REMOVED"
									? "-"
									: "~";
						process.stdout.write(`  ${icon} ${change.path}\n`);
					}
				}
				if (hasConflicts) {
					process.stdout.write(`\n⚠ Conflicts (written to _fit/):\n`);
					for (const clash of result.clash) {
						process.stdout.write(
							`  ${clash.path} (local: ${clash.localState}, remote: ${clash.remoteOp})\n`,
						);
					}
				}
				process.stdout.write(`\n✓ Sync complete.\n`);
			}
		}
	} else {
		const errorMessage = getErrorMessage(result.error);
		if (options.json) {
			process.stdout.write(
				JSON.stringify({ success: false, error: errorMessage }, null, 2) + "\n",
			);
		} else {
			process.stderr.write(`✗ Sync failed: ${errorMessage}\n`);
		}
		process.exit(1);
	}
}

async function runStatus(
	config: CliConfig,
	options: CliOptions,
): Promise<void> {
	const stateFile =
		config.stateFile ?? path.join(config.vaultPath, ".fit-state.json");
	const localStores = await loadState(stateFile);

	const settings: FitSettings = {
		pat: config.pat,
		owner: config.owner,
		avatarUrl: "",
		repo: config.repo,
		branch: config.branch,
		deviceName: config.deviceName,
		checkEveryXMinutes: 5,
		autoSync: "off",
		notifyChanges: false,
		notifyConflicts: false,
		enableDebugLogging: options.verbose ?? false,
	};

	const localVault = new NodeLocalVault(config.vaultPath);
	const fit = new Fit(settings, localStores, localVault);

	const [localResult, remoteResult] = await Promise.allSettled([
		fit.getLocalChanges(),
		fit.getRemoteChanges(),
	]);

	const localChanges =
		localResult.status === "fulfilled" ? localResult.value.changes : [];
	const remoteChanges =
		remoteResult.status === "fulfilled" ? remoteResult.value.changes : [];

	const filteredLocal = localChanges.filter((c) => fit.shouldSyncPath(c.path));

	if (options.json) {
		process.stdout.write(
			JSON.stringify(
				{
					localChanges: filteredLocal.map((c) => ({
						path: c.path,
						type: c.type,
					})),
					remoteChanges: remoteChanges.map((c) => ({
						path: c.path,
						type: c.type,
					})),
					errors: {
						local:
							localResult.status === "rejected"
								? String(localResult.reason)
								: null,
						remote:
							remoteResult.status === "rejected"
								? String(remoteResult.reason)
								: null,
					},
				},
				null,
				2,
			) + "\n",
		);
	} else {
		if (localResult.status === "rejected") {
			process.stderr.write(
				`Error reading local vault: ${localResult.reason}\n`,
			);
		}
		if (remoteResult.status === "rejected") {
			process.stderr.write(`Error reading remote: ${remoteResult.reason}\n`);
		}

		if (filteredLocal.length === 0 && remoteChanges.length === 0) {
			process.stdout.write("Nothing to sync.\n");
		} else {
			if (filteredLocal.length > 0) {
				process.stdout.write(`Local changes (${filteredLocal.length}):\n`);
				for (const c of filteredLocal) {
					const icon =
						c.type === "ADDED" ? "+" : c.type === "REMOVED" ? "-" : "~";
					process.stdout.write(`  ${icon} ${c.path}\n`);
				}
			}
			if (remoteChanges.length > 0) {
				process.stdout.write(`Remote changes (${remoteChanges.length}):\n`);
				for (const c of remoteChanges) {
					const icon =
						c.type === "ADDED" ? "+" : c.type === "REMOVED" ? "-" : "~";
					process.stdout.write(`  ${icon} ${c.path}\n`);
				}
			}
		}
	}
}

function printHelp(): void {
	process.stdout.write(`
FIT CLI - Sync an Obsidian vault with GitHub from the command line.

Usage:
  fit-cli <command> [options]

Commands:
  sync    Sync local vault with remote GitHub repository
  status  Show pending local and remote changes (read-only)
  help    Show this help message

Options:
  --vault <path>    Path to the Obsidian vault directory (required)
  --pat <token>     GitHub personal access token  [env: FIT_PAT]
  --owner <owner>   GitHub repository owner       [env: FIT_OWNER]
  --repo <repo>     GitHub repository name        [env: FIT_REPO]
  --branch <branch> Branch to sync (default: main) [env: FIT_BRANCH]
  --device <name>   Device name for commits       [env: FIT_DEVICE]
  --config <path>   JSON config file              [env: FIT_CONFIG]
  --state <path>    State file path (default: <vault>/.fit-state.json)
  --json            Output results as JSON
  --verbose         Enable verbose logging to stderr

Config file (~/.fit-cli.json):
  {
    "vaultPath": "/path/to/vault",
    "pat": "ghp_...",
    "owner": "username",
    "repo": "vault-repo",
    "branch": "main",
    "deviceName": "my-agent"
  }
`);
}

// ============================================================================
// Error helpers
// ============================================================================

function getErrorMessage(error: unknown): string {
	if (error && typeof error === "object" && "message" in error) {
		return String((error as { message: string }).message);
	}
	return String(error);
}

// ============================================================================
// Main entry point
// ============================================================================

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { command, options } = parseArgs(args);

	if (command === "help" || args.length === 0) {
		printHelp();
		return;
	}

	let config: CliConfig;
	try {
		config = await resolveConfig(options);
	} catch (error) {
		process.stderr.write(`Config error: ${getErrorMessage(error)}\n`);
		process.exit(1);
		return;
	}

	const validationErrors = validateConfig(config);
	if (validationErrors.length > 0) {
		process.stderr.write("Configuration errors:\n");
		for (const err of validationErrors) {
			process.stderr.write(`  - ${err}\n`);
		}
		process.stderr.write('\nRun "fit help" for usage information.\n');
		process.exit(1);
		return;
	}

	try {
		switch (command) {
			case "sync":
				await runSync(config, options);
				break;
			case "status":
				await runStatus(config, options);
				break;
			default:
				process.stderr.write(`Unknown command: ${command}\n`);
				printHelp();
				process.exit(1);
		}
	} catch (error) {
		process.stderr.write(`Fatal error: ${getErrorMessage(error)}\n`);
		if (options.verbose && error instanceof Error && error.stack) {
			process.stderr.write(error.stack + "\n");
		}
		process.exit(1);
	}
}

main();
