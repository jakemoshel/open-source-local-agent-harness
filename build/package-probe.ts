import { isBuiltin } from 'node:module'
import type { Plugin } from 'vite'

/** Keep the smoke check in sync with every external import in the main build. */
export function packageProbePlugin(): Plugin {
  return {
    name: 'jarvis-package-probe',
    generateBundle(_options, bundle) {
      const imports = new Set<string>(['better-sqlite3'])
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const name of [...output.imports, ...output.dynamicImports]) {
          if (name === 'electron' || isBuiltin(name) || name.startsWith('.') || name.startsWith('/') || bundle[name]) continue
          imports.add(name)
        }
      }
      this.emitFile({
        type: 'asset', fileName: 'package-probe.mjs',
        source: [...imports].sort().map(name => `import ${JSON.stringify(name)};`).join('\n') + `
import Database from 'better-sqlite3';
const db = new Database(':memory:');
try {
  if (db.prepare('select 1 as ok').get().ok !== 1) throw new Error('SQLite smoke check failed');
} finally { db.close(); }
console.log('Packaged dependency and native-module check passed');
`
      })
    }
  }
}
