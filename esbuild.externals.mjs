import { builtinModules } from "node:module";

// Node built-ins by bare name (no `node:` prefix), shared by the build, the lint rule and the
// bundle check. node:module's list depends on the running Node version, and a few modules exist
// only with the prefix, so those are listed explicitly rather than trusted to the runtime.
const prefixOnlyBuiltins = ["sea", "sqlite", "test", "test/reporters"];
export const nodeBuiltinNames = [...new Set([
	...builtinModules.map(name => name.replace(/^node:/, "")),
	...prefixOnlyBuiltins,
])];

// Every specifier form a Node built-in can be imported by, bare and with `node:`.
export const nodeBuiltinSpecifiers = nodeBuiltinNames.flatMap(name => [name, `node:${name}`]);

// Modules provided by Obsidian at runtime, so they are never bundled. Shared by the real build
// (esbuild.config.mjs) and the mobile-compatibility bundle check (src/apiCompatibility.test.ts).
export const obsidianExternals = [
	"obsidian",
	"electron",
	"@codemirror/autocomplete",
	"@codemirror/collab",
	"@codemirror/commands",
	"@codemirror/language",
	"@codemirror/lint",
	"@codemirror/search",
	"@codemirror/state",
	"@codemirror/view",
	"@lezer/common",
	"@lezer/highlight",
	"@lezer/lr",
];
