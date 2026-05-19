// Computes the next version for a given release channel.
// Usage: node scripts/next-version.mjs <alpha|beta|stable> [explicit-version]
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const [channel, explicit, baseVersion] = process.argv.slice(2);

if (explicit) {
    process.stdout.write(explicit);
    process.exit(0);
}

const v = baseVersion || JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'
)).version;
const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/);
if (!m) {
    process.stderr.write(`Cannot parse version: ${v}\n`);
    process.exit(1);
}

const [, maj, min, pat, pre, preN] = m;
const major = +maj, minor = +min, patch = +pat;

if (channel === 'stable') {
    if (!pre) {
        process.stderr.write(`Already stable (${v}). Pass an explicit version for a patch release.\n`);
        process.exit(1);
    }
    process.stdout.write(`${major}.${minor}.${patch}`);
} else if (channel === 'alpha') {
    if (!pre) {
        process.stdout.write(`${major}.${minor + 1}.0-alpha.1`);
    } else if (pre === 'alpha') {
        process.stdout.write(`${major}.${minor}.${patch}-alpha.${+preN + 1}`);
    } else {
        process.stderr.write(`Cannot regress from ${pre} to alpha. Pass an explicit version.\n`);
        process.exit(1);
    }
} else if (channel === 'beta') {
    if (!pre) {
        process.stdout.write(`${major}.${minor + 1}.0-beta.1`);
    } else if (pre === 'alpha') {
        process.stdout.write(`${major}.${minor}.${patch}-beta.1`);
    } else if (pre === 'beta') {
        process.stdout.write(`${major}.${minor}.${patch}-beta.${+preN + 1}`);
    } else {
        process.stderr.write(`Cannot regress from ${pre} to beta. Pass an explicit version.\n`);
        process.exit(1);
    }
} else {
    process.stderr.write(`Unknown channel: ${channel}\n`);
    process.exit(1);
}
