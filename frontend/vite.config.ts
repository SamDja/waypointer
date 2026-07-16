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
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
})
