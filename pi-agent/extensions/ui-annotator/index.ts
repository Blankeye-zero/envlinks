/**
 * ui-annotator — bundled entry point.
 *
 * Sources live in src/ (index.ts, session.ts, picker.ts). Rebuild the bundle
 * after editing with: npm run build
 *
 * Why a bundle: pi runs as a Bun-compiled binary whose ESM resolver fails to
 * find puppeteer-core's transitive deps (e.g. `debug`) when the extension
 * directory is reached through a junction (~/.pi -> Projects/envlinks/pi-agent).
 * Bundling everything (including typebox) leaves zero bare imports to resolve.
 * The bundle swaps npm `ws` for src/ws-shim.ts — see that file for why.
 */
import bundle from "./dist/index.cjs";

// pi's loader (jiti) unwraps the CJS `default` export; a native Bun/Node import
// of the .cjs hands back the whole module object instead. Accept both.
const factory = ((bundle as unknown as { default?: unknown }).default ?? bundle) as (...args: unknown[]) => unknown;

export default factory;
