import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ROOT_HOME } from './profile-context'

const run = promisify(execFile)
const NAME = 'Mac Mini Jarvis Local Signing'

/**
 * A self-signed code-signing identity kept in Jarvis's own keychain. Ad-hoc signatures change with every
 * build, so macOS treats each update as a new app and asks for Desktop/Downloads/Full Disk Access again.
 * Signing every build with the same certificate keeps those grants across updates.
 */
export async function localSigningIdentity(): Promise<{ hash: string; keychain: string }> {
  const dir = join(ROOT_HOME, 'signing')
  const keychain = join(dir, 'jarvis-signing.keychain-db')
  const pwFile = join(dir, 'keychain-password')
  const certFile = join(dir, 'cert.pem')
  if (!existsSync(keychain) || !existsSync(pwFile) || !existsSync(certFile)) await create(dir, keychain, pwFile, certFile)
  const password = readFileSync(pwFile, 'utf8').trim()
  await run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain])
  const { stdout } = await run('/usr/bin/openssl', ['x509', '-in', certFile, '-noout', '-fingerprint', '-sha1'])
  const hash = stdout.trim().replace(/^.*=/, '').replace(/:/g, '')
  if (!/^[0-9A-F]{40}$/i.test(hash)) throw new Error(`Unreadable signing certificate fingerprint: ${stdout.trim()}`)
  return { hash, keychain }
}

async function create(dir: string, keychain: string, pwFile: string, certFile: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const password = randomBytes(24).toString('hex')
  const key = join(dir, 'key.pem')
  const p12 = join(dir, 'identity.p12')
  const conf = join(dir, 'openssl.cnf')
  writeFileSync(conf, `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=${NAME}
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
`)
  try {
    // /usr/bin/openssl is LibreSSL, whose PKCS#12 output `security import` accepts (OpenSSL 3's default does not).
    await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '36500', '-keyout', key, '-out', certFile, '-config', conf])
    await run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', certFile, '-out', p12, '-passout', `pass:${password}`])
    await run('/usr/bin/security', ['create-keychain', '-p', password, keychain])
    await run('/usr/bin/security', ['set-keychain-settings', keychain])
    await run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain])
    await run('/usr/bin/security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'])
    // Lets codesign use the key without a keychain prompt.
    await run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain])
    writeFileSync(pwFile, password, { mode: 0o600 })
    chmodSync(pwFile, 0o600)
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  } finally {
    rmSync(key, { force: true })
    rmSync(p12, { force: true })
    rmSync(conf, { force: true })
  }
}
