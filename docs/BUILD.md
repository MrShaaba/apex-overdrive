# Build and verification

Use Node 22.12 or newer and a local Chrome/Chromium installation.

```sh
npm ci
npm run check
npm run assets:validate
npm run preview
```

`check` runs TypeScript, ESLint, the production build, all regression suites, and
a smoke test against the compiled production game. Tests start and close their own isolated Vite server and discover Chrome
on macOS, Linux, and Windows. Set `CHROME` to override the browser executable or
`APEX_URL` to test an already running server. Run a subset with
`npm test -- physics-regressions wheel-calibration`.

`dist/` is a static site. No account, application server, or cloud service is
required. Keep the same URL/port when playing to retain the browser's local save;
use Options to export a backup before changing origins.

## Loading and caching

The menu loads the React/Three.js shell. Rapier and its WASM payload are dynamically
imported on the first race. Circuit downloads report their progress; models still
download as complete GLBs. Leaving a race releases its model, GPU textures, and
colliders. Car templates stay cached for subsequent races.

Vite separates the physics and renderer into chunks. Exact names and sizes change
with the build; inspect `npm run build` output rather than relying on old budgets.
`base: './'` allows hosting under a subdirectory, and `target: es2022` supports the
physics bootstrap.

## Hosting

Serve `dist/` over HTTPS (localhost also works for development). Cache hashed files
under `dist/assets/` as immutable, but revalidate `index.html`, unversioned models,
and the photo manifest when publishing a new version. Cross-origin isolation
headers are not required.

Family photos are copied into `dist/` by Vite. They remain gitignored in source,
but publishing this local build would include them. This project has no remote
and has not been deployed.

For CI, install Chrome/Chromium, then run the commands above through asset
validation; preview is only for interactive play. See [verification](VERIFICATION.md)
for the tested scope and [controllers](CONTROLLERS.md) before buying hardware.
