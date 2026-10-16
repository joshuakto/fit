import type { FileContent } from './contentEncoding';

/**
 * What reading one local file can say. `absent` is only what the filesystem confirms; a failed
 * read of a file that is still there is `unknown`, never an empty or deleted file. Callers that
 * act on absence (a remote deletion, a pull over the path) must treat `unknown` as "leave alone".
 */
export type LocalPathRead =
	| { status: 'present'; content: FileContent }
	| { status: 'absent' }
	| { status: 'unknown'; error: string };

/** The two vault operations `readLocalPath` needs, so any local vault (real or fake) can share it. */
export interface LocalPathReader {
	readFileContent(path: string): Promise<FileContent>;
	statPaths(paths: string[]): Promise<Map<string, 'file' | 'folder' | null>>;
}

export async function readLocalPath(vault: LocalPathReader, path: string): Promise<LocalPathRead> {
	try {
		return { status: 'present', content: await vault.readFileContent(path) };
	} catch (readError) {
		try {
			if ((await vault.statPaths([path])).get(path) === null) return { status: 'absent' };
		} catch {
			// Could not stat either: stays unknown.
		}
		return { status: 'unknown', error: readError instanceof Error ? readError.message : String(readError) };
	}
}
