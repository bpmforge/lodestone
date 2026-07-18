/**
 * Compat entry point. The library barrel lives in `src/lib.ts` (package
 * "main"/"exports" resolve there); this file re-exports it so anything
 * still resolving `dist/index.js` directly (instead of via package.json
 * resolution) keeps working. Pure re-export — no side effects on import.
 *
 * Before W3-10 this file both defined AND started the MCP stdio server
 * (a side effect on import, which made Lodestone unusable as a plain git
 * dependency). That server now lives in `src/mcp.ts` (the `lodestone-mcp` /
 * `bpm-code-search-mcp` bin).
 */
export * from "./lib.js";
