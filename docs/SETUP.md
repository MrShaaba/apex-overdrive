# Local setup

## Requirements
* Node.js 18 or newer (tested on 22), npm 9+.
* A browser with WebGL 2 and WebAssembly: Chrome 90+, Edge 90+, Firefox 90+, Safari 16+.
  A discrete or modern integrated GPU is recommended for the High/Ultra presets.

## Install & run
```bash
npm install
npm run dev
```
Open http://localhost:5173. Use `npm run dev -- --host` (the default script already passes
`--host`) to expose the server on your LAN and test on a phone.

## Verify
```bash
npm run typecheck   # strict TypeScript
npm run lint        # ESLint
npm run build       # production bundle
npm run preview     # serve dist/
```

## Save data
The profile lives in `localStorage` under `apex-overdrive:profile`. Options → Profile
lets you export/import it as JSON or reset it. Delete the key to start fresh.

## Debugging
* Development builds expose the engine as `window.__apex` (see `docs/ARCHITECTURE.md`).
* Options → Profile → Diagnostics prints the renderer, storage usage and dumps the log
  ring buffer to the console.
* `Options → Graphics → Show FPS counter` overlays the smoothed frame rate on the HUD.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| "Could not start the engine" | WebGL 2 or WebAssembly unavailable/blocked. Update the browser or enable hardware acceleration. |
| No sound | Browsers require a user gesture; click/tap once. Check the tab is not muted. |
| Black world but working menus | Driver cannot blend into half-float targets — the pipeline self-tests and falls back to 8-bit targets automatically; if it still happens set Anti-aliasing to *none* and Bloom off. |
| Low frame rate | Lower the preset in Options → Graphics, keep *Dynamic resolution* on, reduce draw distance and particles. |
| Tilt steering does nothing (iOS) | Motion permission must be granted; tap the screen first and allow motion access in Safari settings. |
