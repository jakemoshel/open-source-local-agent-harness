import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
const privateNetworks = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) privateNetworks.addSubnet(address as string, prefix as number, 'ipv4')
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) privateNetworks.addSubnet(address as string, prefix as number, 'ipv6')
function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return !!family && !privateNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6')
}
/** URL admission check, not a process-wide firewall or DNS-pinning proxy. */
export async function assertPublicUrl(value: string): Promise<void> {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs without embedded credentials are allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Private network URL blocked')
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new Error('Private network or metadata URL blocked')
}
