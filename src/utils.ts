// compare currentSha with storedSha and check for differences, files only in currentSha are considerd added, while files only in storedSha are considered removed
export function compareSha(currentSha: {[k:string]:string}, storedSha: {[k:string]:string}): Array<{path: string, status: 'added' | 'removed' | 'changed'}> {
    const allPaths = Array.from(new Set([...Object.keys(currentSha), ...Object.keys(storedSha)]));

    return allPaths.reduce<{path: string, status: 'added' | 'removed' | 'changed'}[]>((changes, path) => {
        const inCurrent = path in currentSha;
        const inStored = path in storedSha;

        if (inCurrent && !inStored) {
            changes.push({ path, status: 'added' });
        } else if (!inCurrent && inStored) {
            changes.push({ path, status: 'removed' });
        } else if (inCurrent && inStored && currentSha[path] !== storedSha[path]) {
            changes.push({ path, status: 'changed' });
        }
        // Unchanged files are implicitly handled by not adding them to the changes array
        return changes;
    }, []);
}