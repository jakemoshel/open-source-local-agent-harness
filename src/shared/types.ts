import type { RsiSettings } from './rsi'
export type ProviderId = 'claude' | 'codex'

export type RunStatus = 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled'

/** 'bench' runs come from scripts/bench.mjs; like 'agent', they never count as the user speaking (memory, reflection). */
export type RunTrigger = 'ui' | 'schedule' | 'slack' | 'imessage' | 'agent' | 'imported' | 'bench'

export interface Run {
  id: string
  title: string
  provider: ProviderId
  model: string | null
  status: RunStatus
  trigger: RunTrigger
  triggerRef: string | null
  conversationKey: string | null
  cwd: string
  prompt: string
  sessionId: string | null
  parentRunId: string | null
  result: string | null
  error: string | null
  usage: RunUsage | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** Size of the conversation's context window at the last model call (prompt incl. cache), not a cumulative sum. */
  contextTokens?: number
  turns?: number
  /** Latency from the run asking its provider to start to the first output (text, thinking or tool call). */
  firstOutputMs?: number
}

export type RunEventType =
  | 'status'
  | 'system'
  | 'user'
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'usage'
  | 'error'

export interface RunEvent {
  id: number
  runId: string
  seq: number
  ts: number
  type: RunEventType
  data: Record<string, unknown>
}

export interface LiveDelta {
  runId: string
  text: string
}

export type SafeguardAction = 'allow' | 'ask' | 'deny'

export interface SafeguardRule {
  id: string
  tool: string
  match?: string
  action: SafeguardAction
  note?: string
  whole?: boolean
}

export interface Safeguards {
  defaultAction: SafeguardAction
  rules: SafeguardRule[]
  approvalTimeoutSec: number
  codex: {
    sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
    networkAccess: boolean
  }
}

export interface Approval {
  id: string
  runId: string
  tool: string
  input: Record<string, unknown>
  ruleId: string | null
  status: 'pending' | 'approved' | 'denied' | 'expired'
  createdAt: number
  resolvedAt: number | null
}

export interface Schedule {
  id: string
  name: string
  /** Recurring pattern; empty for one-off jobs. */
  cron: string
  /** One-off job: fires once at this ISO 8601 time, then disables itself. Takes precedence over cron. */
  runAt?: string
  timezone?: string
  prompt: string
  op?: string
  opArgs?: Record<string, unknown>
  provider?: ProviderId
  model?: string
  effort?: Effort
  cwd?: string
  enabled: boolean
  persistentConversation?: boolean
  deliver?: { gateway: 'slack' | 'imessage'; target: string }
  source?: string
  pendingEnable?: boolean
  importedFrom?: string
}

export interface McpServerEntry {
  type?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  providers?: ProviderId[]
  /** false: each run starts its own copy of this stdio server (for servers that depend on the run's cwd or env). */
  shared?: boolean
}

/** Every effort either CLI accepts; each model supports a subset (see ModelOption.efforts). */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelOption {
  id: string
  label: string
  description: string
  efforts: string[]
  defaultEffort: string | null
  recommended: boolean
  /** Follows its family's newest release (a family ref like "sonnet", or a CLI alias). */
  tracksLatest?: boolean
  /** For a family ref: the exact model it currently resolves to. */
  latest?: string
}

export interface HarnessConfig {
  defaultProvider: ProviderId
  providers: {
    claude: { model?: string; effort?: ClaudeEffort; loadProjectSettings: boolean; executable?: string }
    codex: { model?: string; reasoningEffort?: Effort; executable?: string }
  }
  defaultCwd?: string
  maxConcurrentRuns: number
  maxRunMinutes: number
  /** Retry on the other subscription when one hits its usage limit or loses its login. */
  failover: boolean
  mcpSharing: boolean
  retentionDays: number
  memory: {
    soulFile: string
    memoriesDir: string
    limits: Record<string, number>
    startupInstructions: string
    startupFiles: string[]
    nativeMaxChars: number
    durableMaxChars: number
    mapMaxChars?: number
    contextRoots: string[]
    inject: { file: string; maxChars: number }[]
    recap: { enabled: boolean; maxTurns: number; maxChars: number }
    /** Start a fresh session (with a recap) once a conversation's context reaches this many tokens; 0 never rotates. */
    rotateContextTokens: number
  }
  skillsDir: string
  gateways: {
    idleResetMinutes: number
    slack: { enabled: boolean; allowedUsers: string[]; provider?: ProviderId; cwd?: string; replyInThread: boolean; meetingChannels: string[] }
    imessage: {
      enabled: boolean
      backend: 'bluebubbles' | 'messages'
      allowedHandles: string[]
      provider?: ProviderId
      cwd?: string
      pollMs: number
      webhookHost: string
      webhookPort: number
      webhookPath: string
    }
  }
  notifications?: { scheduleCompletions: boolean; imessageTarget?: string }
  timezone: string
  ui: { launchAtLogin: boolean; keepRunningInTray: boolean; keepAlive: boolean; theme: 'light' | 'dark' | 'system'; onboarded: boolean }
  update: { auto: boolean; checkHours: number; sourceDir?: string; branch: string; signingIdentity?: string }
  learning: {
    reflect: boolean
    minToolCalls: number
    minTasksBetween: number
    cooldownHours: number
    curate: boolean
    curateCron: string
  }
  selfRepair: RsiSettings
  modelRefs?: 'family'
}

export interface EnvEntry {
  key: string
  value: string
  masked: string
  blocked: boolean
  reason?: string
}

export interface AuthStatus {
  /** unknown: the status check itself failed (timeout, busy machine), so the login state could not be read. */
  claude: { ok: boolean; installed: boolean; method: string | null; plan: string | null; detail: string; unknown?: boolean }
  codex: { ok: boolean; installed: boolean; method: string | null; detail: string; unknown?: boolean }
}

/** A subscription sign-in running on the Mac mini that the person finishes in their own browser. */
export interface ProviderLogin {
  profile: string
  provider: 'claude' | 'codex'
  state: 'waiting' | 'verifying' | 'connected' | 'failed' | 'expired' | 'cancelled'
  url: string | null
  /** Codex device code the person types at `url`. */
  userCode: string | null
  /** Claude: the person pastes back the code shown after they approve. */
  needsCode: boolean
  expiresAt: number
  detail: string
}

export interface Skill {
  name: string
  description: string
  dir: string
  path: string
  pinned?: boolean
}

export interface GatewayStatus {
  name: 'slack' | 'imessage'
  enabled: boolean
  state: 'stopped' | 'starting' | 'running' | 'error'
  detail: string
  lastMessageAt: number | null
}

export interface AuditEntry {
  id: number
  ts: number
  actor: 'user' | 'agent' | 'system'
  kind: string
  summary: string
  before: unknown
  after: unknown
}

export interface MigrationItem {
  id: string
  kind: 'soul' | 'memory' | 'skill' | 'env' | 'mcp' | 'gateway' | 'schedule' | 'sessions' | 'config'
  label: string
  source: string
  target: string
  action: 'copy' | 'merge' | 'convert' | 'skip'
  conflict: boolean
  note?: string
  selected: boolean
}

export interface MigrationPlan {
  hermesHome: string
  version: string | null
  items: MigrationItem[]
  warnings: string[]
}

export interface ConversationSummary {
  key: string
  title: string
  provider: ProviderId
  turns: number
  lastStatus: RunStatus
  startedAt: number
  updatedAt: number
  source: RunTrigger
}

export interface ServiceInfo {
  label: string
  plist: string | null
  program: string | null
  loaded: boolean
  pid: number | null
  lastExit: number | null
  disabled: boolean
  kind: 'hermes' | 'bluebubbles' | 'jarvis' | 'other'
}

export interface PermissionStatus {
  fullDiskAccess: boolean
  /** Needed to drive other apps' UI (System Events clicks and keystrokes). */
  accessibility: boolean
  /** Needed for screenshots of the screen (screencapture). */
  screenRecording: boolean
  loginShellEnv: number
  packaged: boolean
  appPath: string
}

export interface UpdateStatus {
  jobId?: string
  phase?: 'queued' | 'building' | 'ready' | 'installing' | 'verifying' | 'succeeded' | 'rolled-back' | 'failed'
  state: 'idle' | 'checking' | 'available' | 'building' | 'installing' | 'error' | 'unsupported'
  currentCommit: string
  remoteCommit: string | null
  behind: { sha: string; subject: string }[]
  sourceDir: string
  auto: boolean
  lastCheck: number | null
  message: string | null
  waitingForRuns: number
  signed: boolean
}

export interface DoctorCheck {
  id: string
  area: 'system' | 'agents' | 'gateways' | 'resilience' | 'schedules' | 'memory' | 'updates'
  status: 'ok' | 'warn' | 'fail'
  title: string
  detail: string
  fix?: string
}

export interface DoctorReport {
  at: number
  summary: string
  checks: DoctorCheck[]
  fixed: string[]
}

export interface OpInfo {
  name: string
  description: string
  agent: boolean
}
