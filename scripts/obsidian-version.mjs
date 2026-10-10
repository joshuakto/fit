// Prints the concrete Obsidian app version for a version label ("latest", "earliest" or an exact
// version), for use in CI cache keys. A key made from the label alone never changes when "latest"
// moves, so the cache keeps serving the old download.
//
// Usage: node scripts/obsidian-version.mjs <label>
import os from "os";
import path from "path";
import ObsidianLauncher from "obsidian-launcher";

const label = process.argv[2];
if (!label) {
	console.error("usage: node scripts/obsidian-version.mjs <label>");
	process.exit(2);
}

// The launcher caches its version list under cacheDir; keep that out of the .obsidian-cache that CI saves.
const launcher = new ObsidianLauncher({ cacheDir: path.join(os.tmpdir(), "obsidian-version-lookup") });
const [appVersion] = await launcher.resolveVersion(label);
console.log(appVersion);
