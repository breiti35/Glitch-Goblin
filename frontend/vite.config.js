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
    sourcemap: false,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'SOURCEMAP_ERROR') return;
        warn(warning);
      },
    },
  },
  server: {
    strictPort: true,
    port: 5173,
    host: false,
    sourcemapIgnoreList: (sourcePath) => sourcePath.includes('/vendor/'),
  },
  clearScreen: false,
})
