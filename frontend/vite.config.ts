import path from "node:path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import mkcert from 'vite-plugin-mkcert'

// https://vite.dev/config/
export default defineConfig({
  // mkcert() only activates for `vite`/`vite serve`, not `vite build`, so it
  // doesn't affect the production build - it's here purely so local dev runs
  // over https, which Wahoo's OAuth app registration requires for the
  // redirect_uri (see lib/wahooAuth.ts's wahooRedirectUri()).
  plugins: [react(), tailwindcss(), mkcert()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // maplibre-gl v6 spawns its worker with { type: "module" }, so the bundled
  // copy RouteMap.tsx hands to setWorkerUrl() must stay an ES module.
  worker: {
    format: "es",
  },
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
})
