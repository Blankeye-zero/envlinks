# ui-annotator (pi extension)

Run an Angular (or any) frontend dev server, annotate UI elements in a live
browser, and feed those annotations to pi as context for code changes.

## How it works

```
pi extension (Node)
  ├── spawns your npm dev script (asks which one) as a child process
  ├── launches your installed Chrome via puppeteer-core (no browser download)
  ├── injects an annotation picker overlay into the page
  └── exposes frontend_* tools the agent can call
```

## Usage

1. **Start:** tell pi "start the frontend" (or `/ui start`). You'll be
   asked which npm script runs the dev server. Chrome opens at the app URL.
2. **Annotate:** say "let me annotate the UI" (or `/ui annotate`).
   Hover highlights elements; click one, type a note, Enter to save.
   Keep clicking to collect several; Esc exits pick mode.
3. **Plan (optional):** run `/ui plan` to enter read-only plan mode. pi
   explores the code and produces a numbered plan (a `## Plan` section) without
   editing anything — edit/write tools and destructive bash are blocked while
   planning.
4. **Apply:** run `/ui confirm` to have pi implement all collected
   annotations (and follow the plan just produced) automatically — or describe
   what you want ("fix the things I annotated"). Each annotation contains your note, CSS selector, Angular
   component chain (class name + declared selector in dev mode), route, HTML
   snippet and an element screenshot; pi greps for the component source and
   edits the code.

## Tools

| Tool | Purpose |
|---|---|
| `frontend_start` | Start dev server + open controlled browser |
| `frontend_stop` | Close browser; kill server if the extension started it |
| `frontend_status` | Server/browser/annotation/console status + log tail |
| `frontend_navigate` | Go to a URL or app route (`/users`) |
| `frontend_annotate` | Toggle click-to-annotate mode |
| `frontend_annotations` | Read annotations (`includeImages`, `clear` options) |
| `frontend_screenshot` | Viewport / full page / selector / annotation screenshot |
| `frontend_console` | Recent console messages and page errors |

Command: `/ui start|stop|status|annotate [on|off]|plan|confirm|shots`

Typing just `/ui` (no subcommand) opens an action picker, like `/model`.

## Files

- Annotations and screenshots: `<project>/.pi/annotations/` (auto-added to
  `.gitignore` on start)
- Unread annotations are auto-injected into the next agent turn.

## Config

- `PI_CHROME_PATH` — override browser executable if Chrome/Edge isn't found.

## Development

Sources live in `src/` (`index.ts`, `session.ts`, `picker.ts`). The root
`index.ts` only re-exports the bundle:

- `npm run build` — bundle `src/index.ts` → `dist/index.cjs` (**required after every edit**, then `/reload` in pi)
- `npm test` — build + headless smoke test of the picker (toggle, element re-location, click → note dialog → annotation)

**Why the bundle:** pi runs as a Bun-compiled binary whose ESM resolver fails
to find puppeteer-core's transitive deps (e.g. `debug`) when the extension
directory sits behind a junction (`~/.pi` → `Projects/envlinks/pi-agent`).
Bundling everything (including typebox) leaves zero bare imports to resolve.

**Why `ws` is aliased (`--alias:ws=./src/ws-shim.ts`):** Bun normally swaps in
its own implementation of the `ws` package, but a bundled copy of npm `ws`
bypasses that, and npm `ws` can't complete the WebSocket upgrade under Bun
(`Unexpected server response: 101`). puppeteer then fails to attach to the
Chrome it just started. The shim backs puppeteer's transport with the global
`WebSocket` (Bun and Node ≥ 22), which talks to DevTools fine.

The controlled browser uses a persistent profile at
`%TEMP%/pi-ui-annotator-chrome-profile` (avoids a Windows EBUSY crash in
puppeteer's temp-profile cleanup; also keeps you logged into the app between
sessions). If a Chrome from an earlier pi process is still running on that
profile (e.g. pi was killed), `frontend_start` reconnects to it via its
`DevToolsActivePort` file instead of launching a second instance — a second
launch on a busy profile just hands off to the running one and exits, which
puppeteer reports as `Failed to launch the browser process! undefined`.

## Troubleshooting

- **`Failed to launch <chrome.exe>: …`** — read the underlying puppeteer
  message. If a Chrome window on the pi profile is already open, close it and
  run `frontend_start` again.
- **`No Chrome or Edge installation found`** — set `PI_CHROME_PATH`.
- Stale `%TEMP%/puppeteer_dev_chrome_profile-*` folders are leftovers from
  the pre-persistent-profile builds and can be deleted.
