import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

/**
 * Vite configuration for Apex Overdrive.
 *
 * - `base: './'` keeps the build relocatable (works from any static host sub-path).
 * - Manual chunks split the heavy engine dependencies (three / rapier) from UI code so
 *   the React shell can render the loading screen while the engine chunk streams in.
 * - `target: 'es2022'` keeps top-level await available for the Rapier WASM bootstrap.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
})
