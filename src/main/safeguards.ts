import type { SafeguardAction, SafeguardRule } from '@shared/types'
import { files } from './config'

/** Every tool call evaluates every rule; compile each pattern once. */
const compiled = new Map<string, RegExp>()
function globToRegExp(glob: string): RegExp {
  let re = compiled.get(glob)
  if (re) return re
  if (glob.startsWith('re:')) re = new RegExp(glob.slice(3), 's')
  else re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's')
  if (compiled.size > 1000) compiled.clear()
  compiled.set(glob, re)
  return re
}

export function subjectOf(tool: string, input: Record<string, unknown>): string {
  if (tool.endsWith('harness_call') && typeof input.op === 'string') return `${input.op} ${JSON.stringify(input.args ?? {})}`
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.notebook_path === 'string') return input.notebook_path
  if (typeof input.url === 'string') return input.url
  if (typeof input.path === 'string') return input.path
  return JSON.stringify(input)
}

export function evaluate(tool: string, input: Record<string, unknown>): { action: SafeguardAction; rule: SafeguardRule | null } {
  const sg = files.safeguards.value
  const subject = subjectOf(tool, input)
  let chained: string[] | null = null
  for (const rule of sg.rules) {
    if (!globToRegExp(rule.tool).test(tool)) continue
    if (rule.match) {
      const re = globToRegExp(rule.match)
      const segments = tool === 'Bash' && !rule.whole ? (chained ??= [subject, ...subject.split(/\s*(?:&&|\|\||;|\|)\s*/)]) : [subject]
      if (!segments.some((s) => re.test(s.trim()))) continue
    }
    return { action: rule.action, rule }
  }
  return { action: sg.defaultAction, rule: null }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The narrowest rule that stops asking about this kind of action again: the exact command, the exact file or URL, a
 * harness op with any arguments, or (for tools whose input has no stable subject, like most integrations) the tool.
 */
export function allowAlwaysRule(tool: string, input: Record<string, unknown>): { rule: Omit<SafeguardRule, 'id'>; label: string } {
  if (tool.endsWith('harness_call') && typeof input.op === 'string') {
    return { rule: { tool, match: `re:^${escapeRe(input.op)} `, action: 'allow' }, label: `the "${input.op}" action` }
  }
  if (typeof input.command === 'string') {
    return { rule: { tool, match: `re:^${escapeRe(input.command.trim())}$`, action: 'allow', whole: true }, label: 'this exact command' }
  }
  for (const key of ['file_path', 'notebook_path', 'url', 'path']) {
    if (typeof input[key] === 'string') return { rule: { tool, match: `re:^${escapeRe(input[key] as string)}$`, action: 'allow' }, label: key === 'url' ? 'this URL' : `${tool} on this file` }
  }
  return { rule: { tool: escapeGlob(tool), action: 'allow' }, label: `the ${tool} tool` }
}

const escapeGlob = (s: string) => /[*?]/.test(s) || s.startsWith('re:') ? `re:^${escapeRe(s)}$` : s

/**
 * Save an allow rule just above the rule that asked, so rules ranked higher (including denies) still win.
 * An ask that came from the default action appends the rule instead.
 */
export function addAllowRule(rule: Omit<SafeguardRule, 'id'>, beforeRuleId: string | null, note: string): SafeguardRule | null {
  const sg = files.safeguards.value
  if (sg.rules.some((r) => r.action === 'allow' && r.tool === rule.tool && r.match === rule.match && !!r.whole === !!rule.whole)) return null
  const saved: SafeguardRule = { id: `always-${Date.now().toString(36)}`, ...rule, note }
  const at = beforeRuleId ? sg.rules.findIndex((r) => r.id === beforeRuleId) : -1
  const rules = [...sg.rules]
  rules.splice(at >= 0 ? at : rules.length, 0, saved)
  files.safeguards.write({ ...sg, rules })
  return saved
}
