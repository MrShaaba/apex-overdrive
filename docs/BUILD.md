# Build workflow

```bash
npm run build      # tsc -b (type check) + vite build → dist/
npm run preview    # local static server for dist/
```

`vite.config.ts`:
* `base: './'` — relocatable build; deploy `dist/` to any static host (GitHub Pages,
  Netlify, Vercel, S3/CloudFront, nginx). No server code is required.
* Manual chunks separate `three`, `@dimforge/rapier3d-compat` and `react` from game code
  so the React shell + loading screen paint while the heavy chunks stream.
* `target: es2022` — needed for top-level `await` around the Rapier WASM bootstrap.

Typical output (gzip): three ≈ 126 kB, rapier ≈ 760 kB (WASM inlined as base64 by the
`-compat` package), game + UI ≈ 220 kB, CSS ≈ 5 kB. Total first load ≈ 1.1 MB, cached
thereafter. To shrink the physics chunk, switch to `@dimforge/rapier3d` (streams a
separate `.wasm` file) — the `PhysicsWorld` wrapper is the only touch point.

## Hosting checklist
* Serve over HTTPS (required for gamepad, device orientation and audio autoplay policies).
* Set `Cache-Control: immutable` on `dist/assets/*` (hashed file names) and a short TTL on
  `index.html`.
* Add the MIME type `application/wasm` if you switch to the streaming Rapier build.
* Optional: `Cross-Origin-Opener-Policy`/`Embedder-Policy` headers are **not** required.

## CI suggestion
```
npm ci
npm run lint
npm run typecheck
npm run build
npm run assets:validate
```
