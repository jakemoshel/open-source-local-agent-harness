/**
 * Model families: the release line an id belongs to, so a choice can follow new releases.
 * A family ref ("opus", "sonnet", "sol", "astra") always means that line's newest model; an exact id
 * ("claude-opus-5-5", "gpt-6.1-sol") stays pinned. Families are derived from the ids themselves, so a new
 * release or a whole new line needs no code change.
 */
const VENDOR = new Set(['claude', 'gpt', 'openai', 'anthropic', 'latest', 'preview'])
const VERSION = /^v?\d+(?:\.\d+)*$/
const variantOf = (id: string) => /\[[^\]]*\]$/.exec(id)?.[0] ?? ''

/** claude-opus-5-5 → opus · gpt-6.1-sol → sol · claude-haiku-4-5-20251001 → haiku · opus[1m] → opus[1m]. */
export function modelFamily(id: string): string {
  const variant = variantOf(id)
  const tokens = id.slice(0, id.length - variant.length).toLowerCase().split(/[-_\s/]+/).filter(Boolean)
  const words = tokens.filter((t) => !VERSION.test(t) && !VENDOR.has(t))
  return (words.join('-') || tokens[0] || id.toLowerCase()) + variant
}

/** Every number in the id, in order: gpt-6.1-sol → [6, 1]; claude-haiku-4-5-20251001 → [4, 5, 20251001]. */
export function modelVersion(id: string): number[] {
  return id.slice(0, id.length - variantOf(id).length).split(/[-_\s/.]+/).filter((t) => /^\d+$/.test(t)).map(Number)
}

/** Newer first when sorted with (a, b) => compareVersions(b, a). A missing part is older than any number: 6 < 6.1. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/** A ref without a version number follows its family's newest release. */
export const followsLatest = (ref: string): boolean => !!ref && !/\d/.test(ref.slice(0, ref.length - variantOf(ref).length))

/** The family ref for an exact id (claude-sonnet-5-5 → sonnet), or the ref unchanged when it already follows releases. */
export function familyRef(ref: string): string {
  if (followsLatest(ref)) return ref
  const family = modelFamily(ref)
  return followsLatest(family) ? family : ref
}

export const familyTitle = (family: string): string => family.replace(/\[[^\]]*\]$/, '').split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
