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
