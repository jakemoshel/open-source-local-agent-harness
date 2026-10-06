import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { packageProbePlugin } from './build/package-probe'

const alias = { '@shared': resolve('src/shared') }

function gitHead(): string {
  if (/^[a-f0-9]{40}$/.test(process.env.JARVIS_BUILD_COMMIT ?? '')) return process.env.JARVIS_BUILD_COMMIT!
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), packageProbePlugin()],
    resolve: { alias },
    define: { __BUILD_COMMIT__: JSON.stringify(gitHead()), __SOURCE_DIR__: JSON.stringify(process.env.JARVIS_SOURCE_DIR || process.cwd()) },
    build: {
      rollupOptions: {
        input: {
          boot: resolve('src/main/boot.ts'),
          index: resolve('src/main/index.ts'),
          'harness-mcp': resolve('src/mcp/harness-mcp.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { ...alias, '@': resolve('src/renderer/src') } }
  }
})
