/**
 * Stand-in for the `ws` npm package, aliased in at bundle time
 * (`--alias:ws=./src/ws-shim.ts` in the build script).
 *
 * Why: pi runs as a Bun-compiled binary. Bun normally swaps its own
 * implementation in for `ws`, but the copy of npm `ws` that esbuild inlines
 * into dist/index.cjs bypasses that — and npm `ws`'s HTTP-upgrade handshake
 * fails under Bun ("Unexpected server response: 101"). puppeteer then can't
 * attach to the Chrome it just started, retries with another executable on
 * the same profile, and that second Chrome exits immediately (code 21), which
 * surfaces as "Failed to launch the browser process! undefined".
 *
 * puppeteer's NodeWebSocketTransport only uses the browser-style API
 * (addEventListener / send / close), which the global WebSocket in both Bun
 * and Node >= 22 provides — and it talks to Chrome's DevTools endpoint fine.
 */
const NativeWebSocket = globalThis.WebSocket;
if (typeof NativeWebSocket !== "function") {
	throw new Error("ui-annotator: this runtime has no global WebSocket (Node >= 22 or Bun required)");
}

export default class PiWebSocket extends NativeWebSocket {
	// puppeteer passes ws-specific options as a third argument; drop them.
	constructor(url: string | URL, protocols?: string | string[], _options?: unknown) {
		super(url, protocols);
	}
}
