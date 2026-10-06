// Executed with the packaged Electron runtime, before the old app is replaced.
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
async function main() {
  const root = process.argv[2] || join(__dirname, '..', 'app.asar')
  // Resolve ESM imports from inside app.asar, exactly as the app does. Package
  // roots are not necessarily entrypoints (notably the MCP SDK).
  await import(pathToFileURL(join(resolve(root), 'out/main/package-probe.mjs')).href)
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
