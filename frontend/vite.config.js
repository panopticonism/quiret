import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Emit a list of built assets so the service worker can precache the whole app
// shell (including foliate-js's lazily-imported format chunks) for offline use.
function precacheManifest() {
  return {
    name: 'quiret-precache-manifest',
    apply: 'build',
    writeBundle(options, bundle) {
      const urls = new Set(['/', '/index.html', '/pdf.worker.min.mjs'])
      for (const fileName of Object.keys(bundle)) {
        if (/\.(js|mjs|css|html|woff2?)$/.test(fileName)) urls.add('/' + fileName)
      }
      writeFileSync(
        join(options.dir, 'precache-manifest.json'),
        JSON.stringify([...urls]),
      )
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../', '')

  return {
    plugins: [svelte(), precacheManifest()],
    server: {
      proxy: {
        '/api': {
          target: `http://localhost:${env.PORT}`,
          changeOrigin: true
        }
      }
    },
    optimizeDeps: {
      include: ['pdfjs-dist']
    }
  }
})
