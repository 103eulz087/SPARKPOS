import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [
    react(),
    // Service worker: keeps the app's own files (not data) on the device, so SparkPOS opens with no
    // network — after a refresh or a restart too. Sales, prices and sign-ins keep using IndexedDB
    // (lib/api.js) and the API; nothing under /api is ever cached. 'prompt': a new version waits
    // until the user taps the update bar (lib/pwa.js), never reloads by itself mid-sale.
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,      // registered in lib/pwa.js
      manifest: false,            // public/manifest.webmanifest stays the manifest
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/swagger/, /^\/health/, /^\/images\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [{
          // product photos (uploaded to wwwroot/images/products, not part of the build)
          urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/images/products/'),
          handler: 'StaleWhileRevalidate',
          options: { cacheName: 'product-images', expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 60 } }
        }]
      }
    })
  ],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:5000' }
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 900 }
})
