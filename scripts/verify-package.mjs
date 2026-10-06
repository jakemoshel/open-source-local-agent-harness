import { execFileSync } from 'node:child_process'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyPackage(app) {
  const name = basename(app).replace(/\.app$/, '')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_NO_ASAR
  execFileSync(join(app, 'Contents/MacOS', name), [join(app, 'Contents/Resources/updater/probe.cjs')], { env, timeout: 60000, stdio: 'inherit' })
}

// Every electron-builder invocation must pass, including directory-only builds.
export default async function afterPack(context) {
  verifyPackage(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPackage(resolve(process.argv[2] || 'dist/mac-arm64/Mac Mini Jarvis.app'))
}
