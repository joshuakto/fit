/**
 * Obsidian plugin entry point. The loader requires this file at the repo root (per manifest.json)
 * and calls `new DefaultExport(app, manifest)` on the default export to instantiate the plugin.
 *
 * FitSettings is re-exported here so callers that import via '@main' still resolve correctly
 * without creating a circular dependency through FitPlugin.
 */

export { default } from '@/fitPlugin';
export type { FitSettings } from '@/fitSettings';
