import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves the app under /<repo>/
export default defineConfig({
  base: process.env.RW_BASE ?? '/research-workspace-ipad/',
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-180.png'],
      manifest: {
        name: '연구 작업대',
        short_name: '연구 작업대',
        description: '연구 저장소를 GitHub에서 받아 오프라인으로 읽고 코멘트를 남긴다',
        lang: 'ko',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#111111',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // the app shell (incl. pdf.js worker and KaTeX fonts) works offline; research data lives in IndexedDB
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
})
