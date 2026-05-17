import ignore, { Ignore } from "ignore";
import { DataAdapter } from "obsidian";

export class GitignoreFilter {
	private constructor(private readonly filters: Map<string, Ignore>) {}

	/**
	 * Load .gitignore files relevant to filePaths and build a filter.
	 *
	 * knownPaths (from vault.getFiles()) is used as a hint: if a .gitignore
	 * path is already known to exist, the stat round-trip is skipped.
	 * Once Obsidian exposes hidden files via getFiles(), this will automatically
	 * avoid redundant scanning for any .gitignore already in the vault index.
	 */
	static async load(
		adapter: DataAdapter,
		filePaths: string[],
		knownPaths?: ReadonlySet<string>
	): Promise<GitignoreFilter> {
		const gitignorePaths = deriveGitignorePaths(filePaths);
		const filters = await loadFilters(adapter, gitignorePaths, knownPaths);
		return new GitignoreFilter(filters);
	}

	get isEmpty(): boolean {
		return this.filters.size === 0;
	}

	ignores(filePath: string): boolean {
		const parts = filePath.split('/');
		const dirsToCheck: string[] = [''];

		for (let i = 1; i < parts.length; i++) {
			dirsToCheck.push(parts.slice(0, i).join('/'));
		}

		for (const dirPath of dirsToCheck) {
			const filter = this.filters.get(dirPath);
			if (!filter) continue;

			const relativePath = dirPath === ''
				? filePath
				: filePath.substring(dirPath.length + 1);

			if (filter.ignores(relativePath)) return true;
		}

		return false;
	}

	filter(filePaths: string[]): { kept: string[]; ignored: string[] } {
		const kept: string[] = [];
		const ignored: string[] = [];

		for (const path of filePaths) {
			if (this.ignores(path)) {
				ignored.push(path);
			} else {
				kept.push(path);
			}
		}

		return { kept, ignored };
	}
}

function deriveGitignorePaths(filePaths: string[]): Set<string> {
	const gitignorePaths = new Set<string>();
	gitignorePaths.add('.gitignore');

	for (const filePath of filePaths) {
		const parts = filePath.split('/');
		for (let i = 1; i < parts.length; i++) {
			const dirPath = parts.slice(0, i).join('/');
			gitignorePaths.add(`${dirPath}/.gitignore`);
		}
	}

	return gitignorePaths;
}

async function loadFilters(
	adapter: DataAdapter,
	gitignorePaths: Set<string>,
	knownPaths?: ReadonlySet<string>
): Promise<Map<string, Ignore>> {
	const filters = new Map<string, Ignore>();

	await Promise.all(
		Array.from(gitignorePaths).map(async (gitignorePath) => {
			try {
				const knownToExist = knownPaths?.has(gitignorePath);
				if (!knownToExist) {
					const stat = await adapter.stat(gitignorePath);
					if (!stat || stat.type !== 'file') return;
				}

				const content = await adapter.read(gitignorePath);
				const dirPath = gitignorePath === '.gitignore'
					? ''
					: gitignorePath.replace(/\/.gitignore$/, '');
				filters.set(dirPath, ignore().add(content));
			} catch {
				// file doesn't exist or unreadable — skip
			}
		})
	);

	return filters;
}
