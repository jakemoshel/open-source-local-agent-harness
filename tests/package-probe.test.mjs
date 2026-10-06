import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadModule } from './load-module.mjs'

async function generatedProbe(imports) {
  const { packageProbePlugin } = await loadModule('build/package-probe.ts')
  let emitted
  packageProbePlugin().generateBundle.call({ emitFile: asset => { emitted = asset } }, {}, {
    'index.js': { type: 'chunk', imports, dynamicImports: ['lazy-dependency'] },
    'shared.js': { type: 'chunk', imports: ['@modelcontextprotocol/sdk/server/mcp.js'], dynamicImports: [] }
  })
  return emitted.source
}

test('package check covers actual static and dynamic entrypoints, excluding Electron, builtins and internal chunks', async () => {
  const source = await generatedProbe(['electron', 'node:fs', 'fs', './boot.js', 'shared.js', '@modelcontextprotocol/sdk/client/index.js'])
  assert.match(source, /import "@modelcontextprotocol\/sdk\/client\/index.js"/)
  assert.match(source, /import "@modelcontextprotocol\/sdk\/server\/mcp.js"/)
  assert.match(source, /import "lazy-dependency"/)
  assert.doesNotMatch(source, /import "(?:electron|node:fs|fs|\.\/boot.js|shared.js|@modelcontextprotocol\/sdk)"/)
  assert.match(source, /new Database\(':memory:'\)/)
})

test('probe accepts subpath-only ESM dependencies and rejects missing transitive dependencies', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-probe-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'out/main'), { recursive: true })
  const dep = join(root, 'node_modules/subpath-sdk'); mkdirSync(dep, { recursive: true })
  writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'subpath-sdk', type: 'module', exports: { '.': './missing-root.js', './client': './client.js' } }))
  writeFileSync(join(dep, 'client.js'), 'export const client = true;')
  writeFileSync(join(root, 'out/main/package-probe.mjs'), 'import "subpath-sdk/client";')
  const probe = resolve('resources/updater/probe.cjs')
  execFileSync(process.execPath, [probe, root])
  writeFileSync(join(dep, 'client.js'), 'import "missing-transitive-dependency";')
  const broken = spawnSync(process.execPath, [probe, root], { encoding: 'utf8' })
  assert.equal(broken.status, 1); assert.match(broken.stderr, /missing-transitive-dependency/)
  rmSync(join(root, 'out/main/package-probe.mjs'))
  const missing = spawnSync(process.execPath, [probe, root], { encoding: 'utf8' })
  assert.equal(missing.status, 1); assert.match(missing.stderr, /package-probe.mjs/)
})
