import { LocalFileStatus } from "./fitPush";

export type RemoteChangeType = "ADDED" | "MODIFIED" | "REMOVED"

type Status = RemoteChangeType | LocalFileStatus

type FileLocation = "remote" | "local"

type ComparisonResult<Env extends FileLocation> = {
    path: string, 
    status: Env extends "local" ? LocalFileStatus: RemoteChangeType
    currentSha?: string
    extension?: string
}

function getValueOrNull(obj: Record<string, string>, key: string): string | null {
    return obj.hasOwnProperty(key) ? obj[key] : null;
}


// compare currentSha with storedSha and check for differences, files only in currentSha
//  are considerd added, while files only in storedSha are considered removed
export function compareSha<Env extends "remote" | "local">(
    currentShaMap: Record<string, string>, 
    storedShaMap: Record<string, string>,
    env: Env): ComparisonResult<Env>[] {
        const determineStatus = (currentSha: string | null, storedSha: string | null): Status | null  => 
        {
            if (currentSha && storedSha && currentSha !== storedSha) {
                return env === "local" ? "changed" : "MODIFIED";
            } else if (currentSha && !storedSha) {
                return env === "local" ? "created" : "ADDED";
            } else if (!currentSha && storedSha) {
                return env === "local" ? "deleted" : "REMOVED";
            }
            return null
        }

        return Object.keys({ ...currentShaMap, ...storedShaMap }).flatMap((path): ComparisonResult<Env>[] => {
            const [currentSha, storedSha] = [getValueOrNull(currentShaMap, path), getValueOrNull(storedShaMap, path)];
            const status = determineStatus(currentSha, storedSha);
            if (status) {
                return [{
                    path,
                    status: status as Env extends "local" ? LocalFileStatus : RemoteChangeType,
                    currentSha: currentSha ?? undefined,
                    extension: extractExtension(path)
                }];
            }
            return [];
        });
}

export const RECOGNIZED_BINARY_EXT = ["png", "jpg", "jpeg", "pdf"]

function extractExtension(path: string): string | undefined {
    return path.match(/[^.]+$/)?.[0];
}

// Using file extension to determine encoding of files (works in most cases)
export function getFileEncoding(path: string): string {
    const extension = path.match(/[^.]+$/)?.[0];
    const isBinary = extension && RECOGNIZED_BINARY_EXT.includes(extension);
    if (isBinary) {
        return "base64"
    } 
    return "utf-8"
}

export function setEqual<T>(arr1: Array<T>, arr2: Array<T>) {
    const set1 = new Set(arr1);
    const set2 = new Set(arr2);
    const isEqual = set1.size === set2.size && [...set1].every(value => set2.has(value));
    return isEqual
}