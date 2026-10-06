import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
// Fixed ingress identities the gateway tests authenticate against.
process.env.JARVIS_OWNER_PHONE ??= '+15555550125'
process.env.JARVIS_OWNER_SLACK ??= 'U0OWNER123'
let serial = 0
export async function loadModule(file, mocks = {}) {
  const key = `__jarvis_test_${++serial}`
  globalThis[key] = mocks
  try {
    const result = await build({
      entryPoints: [resolve(file)], bundle: true, platform: 'node', format: 'cjs', write: false,
      // Lazy mock modules can initialize after loadModule returns. Capture the
      // table in the bundle instead of looking up a deleted global at that time.
      banner: { js: `const __jarvisMocks = globalThis[${JSON.stringify(key)}];` },
      packages: 'external', define: { 'import.meta.dirname': JSON.stringify(resolve('src/main')) },
      plugins: [{ name: 'test-mocks', setup(build) {
        // Images resolve to an empty URL: renderer code imports them for <img src>, which tests never load.
        build.onResolve({ filter: /\.(png|svg)$/ }, ({ path }) => ({ path, namespace: 'asset' }))
        build.onLoad({ filter: /.*/, namespace: 'asset' }, () => ({ contents: "export default ''" }))
        build.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(mocks, path) ? { path, namespace: 'mock' } : undefined)
        build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: Object.keys(mocks[path]).map((name) =>
          name === 'default' ? `export default __jarvisMocks[${JSON.stringify(path)}].default;` :
          `export const ${name} = __jarvisMocks[${JSON.stringify(path)}][${JSON.stringify(name)}];`).join('\n') }))
      } }]
    })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
    return module.exports
  } finally { delete globalThis[key] }
}

export const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export const tick = () => new Promise((resolve) => setImmediate(resolve))
