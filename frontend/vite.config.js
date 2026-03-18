import { defineConfig } from 'vite'
import { cpSync } from 'fs'
import { resolve } from 'path'

function copyVendor() {
  return {
    name: 'copy-vendor',
    closeBundle() {
      cpSync(
        resolve(import.meta.dirname, 'vendor'),
        resolve(import.meta.dirname, 'dist/vendor'),
        { recursive: true }
      )
    }
  }
}

export default defineConfig({
  root: '.',
  plugins: [copyVendor()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    strictPort: true,
    port: 5173,
    host: false,
  },
  clearScreen: false,
})
