# Mac Mini Jarvis

A local Mac app that runs Claude Code and Codex as a personal agent, on your subscriptions only. It covers chat, iMessage (BlueBubbles) and Slack gateways, schedules, MCP servers, linked Markdown memory, a Granola meeting archive, skills, safeguards, a self-improvement loop, and a Hermes importer.

## Requirements

- Apple silicon Mac, Node 22+
- A Claude subscription and a ChatGPT subscription for the providers you use. In Settings → Agents, click **Install missing CLIs**, then **Sign in** for each provider. Jarvis shows a sign-in link you can open on any device.
- Each profile connects its own subscriptions from anywhere. For member profiles, you press **Connect** on Settings → Profiles and **Send link**. The CLI runs on the Mac mini under that profile's own login store, and only the link leaves it. For Codex, they enter the one-time code shown. For Claude, they send back the code from the approval page. Jarvis catches that code before it reaches the agent or any transcript. `/connect cancel` stops a waiting sign-in.

API billing is never used. `ANTHROPIC_*`, `OPENAI_*`, `CODEX_API_KEY` and other pay-per-token keys are stripped from every agent's environment. A run refuses to start, or is killed, if either CLI isn't on a subscription login.

## Install on the Mac mini

```sh
git clone <this repo> ~/jarvis-harness
cd ~/jarvis-harness
npm install
npm run dist
open dist/*.dmg
```

1. Drag **Mac Mini Jarvis** to Applications. The app is unsigned, so the first time you open it, right-click it and choose **Open**.
2. Settings → Permissions: add the app to **Full Disk Access**, the same access Terminal has. Agents run as its child processes and inherit it.
3. Settings → System: "Run as a macOS startup service" installs a LaunchAgent. Jarvis then starts at login, lives in the menu bar (▲), and restarts if it crashes.

Use **⌘Q** to quit Jarvis. Reopen it from Applications, Spotlight, or the Dock; no Terminal command is needed.

## First run

Jarvis opens on a short setup:

1. **Import from Hermes** (optional): shown when `~/.hermes` exists.
2. **Connect Claude Code or Codex** (required): install the CLIs and sign in with your subscription. At least one is needed.
3. **Browser** (optional): connect the [BrowserOS](https://www.browseros.com) MCP server (recommended; default `http://127.0.0.1:9010/mcp`), or skip.
4. **iMessage** (optional): enter your number, and Jarvis opens a chat that walks you through installing [BlueBubbles](https://github.com/BlueBubblesApp/bluebubbles-server), saving its URL and password, and turning on the gateway.

## Set the owner

iMessage and Slack only answer one person: the owner. Set your number and Slack member ID under **Gateways → Owner** (or in the first-run setup). They're stored in `~/.jarvis/owner.json`; `JARVIS_OWNER_PHONE` / `JARVIS_OWNER_SLACK` override them. Agents and messages can't change this, and an empty field blocks that gateway.

## Unattended Mac mini

For Jarvis to come back by itself after a power outage or macOS update:

```sh
sudo pmset -a autorestart 1 sleep 0   # power on after an outage, never sleep
```

- System Settings → Users & Groups → **Automatically log in as** your user. Jarvis is a per-user service, so it waits for a login.
- With FileVault on, macOS updates still restart unattended, but after a power cut the Mac waits at the unlock screen.
- After a reboot Jarvis catches up on any schedule missed in the last 12 hours, and retries gateways with backoff until the network and BlueBubbles are up.

## Doctor

```sh
npm run doctor           # full report from the running app
npm run doctor -- --fix  # also retry gateways, reinstall the LaunchAgent, run missed schedules
```

It checks auth, gateways, the startup service, power and auto-login, the database, disk, schedules, memory, MCP servers and updates. When Jarvis is down it says why (LaunchAgent state, last log lines, last update log). The same report is under Settings → System, and agents can run it with op `doctor`.

## Updates

Jarvis updates itself from the checkout it was built from (`update.sourceDir`, `update.branch` in `config.json`). Every 6 hours, and on each `UPDATE` command, it fetches the configured branch from `origin` and merges it into the local `jarvis/local` branch, which also holds this Mac's own self-repair commits. That branch is what gets built and installed, so local fixes survive upstream updates. Nothing is ever pushed. If a local fix conflicts with upstream, the update stops and says so. A separate worker builds that exact commit in an isolated snapshot while Jarvis stays available; local branches and uncommitted work are preserved. The worker runs `npm ci`, type checks, regression tests, and packaging. Every package must load the build's actual dependency entrypoints and execute a SQLite query using its own Electron runtime before it can be installed. After active runs and replies finish, the worker swaps the app in `/Applications` and restarts. If the new build doesn't report healthy within 3 minutes, the previous app is put back and that commit isn't retried automatically. Settings → System → Updates shows progress and has a manual Install button. The app menu-bar icon has one too. An update already in progress stays pinned to its selected commit; a later check picks up newer commits.

Updates are signed with a self-signed certificate that Jarvis creates once in its own keychain (`~/.jarvis/signing`). Every build has the same signing identity, so macOS keeps Desktop, Downloads and Full Disk Access grants across updates. You grant them once more after the first update that uses the certificate. To use your own certificate instead, set `"update": { "signingIdentity": "<its name>" }`.

The first install with the updater still has to be done by hand (`npm run dist`).

`npm run dist` also requires type checks, regression tests, and the packaged runtime check to pass. To check an existing build, run `npm run verify-package -- "/path/to/Mac Mini Jarvis.app"`.

## Moving over from Hermes

Settings → **Import from Hermes** detects `~/.hermes` (or `$HERMES_HOME`), previews everything, then imports `SOUL.md`, memories, skills, `.env` (pay-per-token keys skipped), MCP servers, the BlueBubbles setup, cron jobs and `state.db` history. The Hermes side is only read, and the harness is backed up first. Gateways and schedules arrive **disabled**; press **Cut over from Hermes** when you're ready.

## Meetings

Connect the Granola MCP server under Integrations and Jarvis archives your meetings nightly at 8:30 PM into `memories/meetings/`, with no model call. Memory → Meetings lists them, and agents search them with `meetings_search` / `meetings_read`. A 9:00 PM digest of decisions and action items is available as a schedule; set its delivery target to your own chat. Slack channels listed in `gateways.slack.meetingChannels` are archived the same way.

## Gateways

**iMessage via BlueBubbles.** Jarvis registers a webhook (`127.0.0.1:8646/bluebubbles-webhook`) with your BlueBubbles server using `BLUEBUBBLES_SERVER_URL` and `BLUEBUBBLES_PASSWORD`, then replies through the BlueBubbles API. Inbound access is pinned to the owner's phone number from `~/.jarvis/owner.json` (see below). Unauthorized identities, malformed number lookalikes and group chats are dropped before command handling or AI processing, for both webhook/catch-up and Messages.app backends. Webhooks also require the BlueBubbles shared secret. Profile contacts and legacy allowlists cannot widen this gate. Reading Messages.app directly is available as a fallback.

**Slack** uses Socket Mode with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`, and only accepts the owner's Slack member ID from `~/.jarvis/owner.json` before command handling or AI processing. Bots and other users are blocked.

Commands work on iMessage, Slack and the app's chat. They run directly, with no model call. The bare words count in capitals (NEW and STOP also as a phone autocapitalizes them, "New" and "Stop"), so a lowercase "stop" or "new" in a message goes to the agent like any other text:

| Message | Effect |
|---|---|
| `NEW` | fresh session |
| `NEW <text>` | fresh session, with `<text>` as its first message |
| `UPDATE` | check for and install an app update, wait for active tasks, then restart and reopen Jarvis (owner only; also `/update` or `!update`) |
| `STOP` | stop the running turn (also `/stop`) |
| `/new`, `/reset` | fresh session |
| `TERMINAL` | terminal mode: every message runs in this chat's own persistent shell on the Mac mini, no model, until `EXIT`. `READ` shows output printed since the last reply, `^C` or `STOP` interrupts (`^D`, `^Z`, `^L` also work). Closes itself after 30 idle minutes (owner only; also `/terminal`, `/term`) |
| `TERMINAL <cmd>`, `$ <cmd>` | run one command in that shell without entering terminal mode |

Replies are formatted for the channel: Markdown becomes plain text on iMessage and Slack formatting on Slack. A 1:1 iMessage chat is one conversation whichever service (iMessage, SMS) or handle format BlueBubbles reports. Messages already answered are remembered across restarts, so a late read receipt or edit never gets a second answer. Jarvis re-checks its BlueBubbles webhook every five minutes, removes stale duplicates, and marks the gateway as failing after three missed catch-ups so the watchdog reconnects it.

After 120 minutes of inactivity (Gateways → idle reset; 0 turns it off) the next message, on any channel including the app's chat, starts a fresh session carrying a compaction recap of the previous one.

## Memory

Personal memory uses linked, Git-tracked Markdown and keyword search. The answering agent reads it; a restricted background reconciler updates it nightly at 3:15 AM in the profile's timezone and reviews it Sundays at 3:45 AM. It cannot execute shell commands, contact anyone or change settings.

Without imported context roots, Jarvis creates this private tree under the configured memories directory:

```text
Context/
  SCHEMA.md, index.md, PROFILE.md, NOW.md, TASKS.md
  entities/people/       entities/orgs/
  knowledge/facts/       knowledge/preferences/       knowledge/decisions/
  comms/phone/
  timeline/daily/        timeline/weekly/
  workstreams/active/    workstreams/completed/
  .git/
```

Records have an id, type, aliases, dates, status, sources and `[[links]]`. Facts retain dates, source event ids and confidence; corrections preserve history. Historical or expired records require an explicit historical search. `context_read` pages through full records and resolves links/backlinks; `context_history` shows local revisions. `context_forget` requires user approval, hides the canonical record and clears derived snapshots. It does not erase older Git history, original transcripts or already-open conversations.

Session start loads compact PROFILE/NOW/TASKS bodies (1,200 / 1,600 / 800 characters), a short operational MEMORY.md, identity, and a bounded conversation recap. The full index and detailed files load on demand. Existing USER.md is preserved and imported once into a sourced canonical profile; it is no longer duplicated in the default startup prompt. Custom context roots are preserved.

The reconciler reads a stable, paged event window, including follow-ups on older runs. It resumes a committed event checkpoint or a verified partial cursor. A full checkpoint requires every page; partial checkpoints must match the exact next cursor at a complete event boundary. It commits only memory files it changed, leaving unrelated staged work in imported repositories alone. An interrupted ingestion resumes its last successfully committed checkpoint instead of skipping or endlessly rereading a large history.

## Tool retrieval and terminals

Tools use local sparse vectors, independently of personal memory's keyword lookup. Each vocabulary term becomes a numeric dimension. Operation names and aliases carry weight 4, descriptions weight 2, and categories/argument names weight 0.5. Inverse document frequency favors distinctive terms; cosine similarity ranks matches, with a bonus for an exact operation name. No embedding service, model download or vector database is required.

`harness_ops {query: "remind me tomorrow"}` returns matching input schemas in one call. The same registry is materialized in `~/.jarvis/tools/<category>/<operation>.md` with an index, so native file search works too. Discovery is filtered by profile and background-run permissions. `harness_call` executes the selected operation; large results are paged from cached output with a resultId, without repeating side effects.

Normal owner commands run through the provider CLI's execution tools. Jarvis also exposes real persistent PTY shells through `terminal_open/send/read/list/close`, for interactive commands, SSH, servers and long builds. These shells survive individual runs, close when Jarvis quits, and inherit the app's macOS permissions. Harness terminal commands pass the Bash safeguards. Claude's native tools pass PreToolUse; Codex's native execution follows its configured sandbox policy rather than Jarvis's custom Bash rules.

## Speed & Efficiency (Jcode-style)

- **Per-job processes:** `warmSessions.max` is normalized to 0, including existing configurations. Claude Code exits after each job; subsequent turns resume their persisted conversation in a fresh process.
- **Shared MCP servers:** each stdio MCP server configuration in `mcp.json` runs once inside Jarvis, and every run using that configuration connects to it over localhost (bearer token, 127.0.0.1 only). Changed configurations use a separate process so existing runs keep their original settings. It starts on first use and stops after an hour idle. Set `"shared": false` on a server that depends on the run's working directory or MCP resource subscriptions, or `mcpSharing: false` to turn sharing off.
- **Concurrency & File Conflict Tracking (Jcode):** The harness tracks active file leases across concurrent runs and subagents. It detects write-write, write-read, and read-write collisions in real-time, guarding against stale diffs, race conditions, and accidental overwrites during parallel execution. Check active leases and conflicts with `runs_active_files`.
- **Swarm Execution & Lean Subagents:** Dispatch parallel subagent swarms with `runs_batch` and wait concurrently using `runs_wait_many`. Subagents can run with `scopedContext: true`, stripping heavy personal memory and transcript history down to focused task context, saving 80%+ tokens and keeping memory minimal.
- **Stable prompt cache:** the system prompt holds nothing that changes by the day. Each new message ends with the time it was sent.
- **Measured:** each run records `firstOutputMs` (time to first output) and whether it ran warm. `npm run doctor` reports the warm and cold medians alongside harness RAM (RSS and heap) and active lease health.

## Self-Improvement (Nous Research Hermes-style)

- **Hermes Reflective Learning Protocol:** Bounded post-task reflection evaluates trajectory friction, failed tool calls, and user corrections. It extracts explicit anti-patterns and pitfalls (what *not* to do) alongside numbered, deterministic procedures.
- **Expedited Closed-Loop Reflection:** High-urgency learning signals (explicit user corrections and broken skills) trigger reflection immediately without waiting for a 10-task batch or 6-hour cooldown, ensuring corrections take effect before the next turn.
- **Skill Health & Utility Analytics:** Tracks suggestion-to-load conversion, execution success rates, and failure frequencies. `skills_evaluate` classifies skills as healthy, at-risk, or failing with actionable recommendations (keep, review, patch, prune).
- **Proactive Curation:** Weekly curation automatically identifies at-risk and degraded skills, prioritizing them for patching, refinement, or deduplication.
- **Fault ledger:** Crashes, unhandled rejections, failed startup steps, failed background loops and errors inside harness operations are recorded once per fingerprint (ids, numbers and line positions are ignored). Each fault is classed `code`, `env` or `unknown`. A code fault needs a fix on its first crash, or when it repeats within 24 hours. Unknown errors become investigation candidates after three occurrences within that window; environment failures remain excluded. Reflection and curation report harness defects with `harness_report_defect`. `faults_list` and `npm run doctor` show them; `faults_set_status` marks one ignored or reopens it.
- **Self-improvement memory:** `memories/self-improvement/` is separate from personal memory. `harness/` (owner only, shared by every profile) holds `LESSONS.md` about Jarvis's own behaviour and a `faults/<fingerprint>.md` page for each fault that was reported or changed status. `skills/` (per profile) holds `LESSONS.md` recording why skills changed. Reflection and curation read and append to these with `improvement_list`, `improvement_read` and `improvement_note`. Lessons are dated and capped at 8,000 characters, newest kept.
- **Self-repair (recursive self-improvement):** Settings → RSI customization controls autonomous harness improvement. The triggering review records implementation size, reason, affected files/components, estimated minutes, validation method and priority. Local fixes, one-off breakage and routine skill/harness reviews use **Claude Sonnet 5.5**; broader features, migrations and cross-component jobs use **GPT 6.1 Sol**. Both models, efforts and scope thresholds are editable. Confirmed code defects qualify immediately; recurring unknown failures qualify after three occurrences. Queue selection accounts for impact, recurrence and age across the entire ledger, and waits for subscription capacity without blocking other jobs. RSI has normal native tools, research, subagents and configured MCP connections and may improve any harness file or dependency. Jobs use short-lived processes, structured provider results, and persistent workspaces/checkpoints: continuation preserves edits and progress, failed small implementations can escalate, and interrupted verified commits resume shipping. Every job runs in its own git worktree with private dependency copies, so your checkout is never edited. Validation follows the change: regression, standard checks, measured benchmark or repeatable browser workflow, followed by typecheck, tests and build. The harness commits to the local `jarvis/local` branch automatically (never pushed); updater installation follows current tasks. Settings control slice duration, retries, proactive review frequency, daily implementation slices and custom instructions. Discovery does not consume implementation slots; zero daily/attempt limits means unlimited. Installed-commit statistics track run timing, tool errors, corrections, retrieval and builds; reviews can query them with `rsi_statistics`. Shipped branch cleanup and rollback reverts retry durably. Recurring installed faults reopen. Packaged builds enable RSI; `JARVIS_SELF_REPAIR=1` enables it in development.


## Default schedules (in your configured timezone)

| Time | Job |
|---|---|
| 3:15 AM daily | context ingestion and cleanup |
| 3:45 AM Sunday | deeper context review |
| 4:15 AM daily | private memory backup (runs directly, no model call) |

## The agent can run the harness

Every agent gets two tools: `harness_ops` to list operations and `harness_call` to run one. With them it can manage runs, schedules, gateways, safeguards, MCP servers, env, memory, skills, and LaunchAgents. It can also restart the gateway, restart BlueBubbles, or restart Jarvis itself. Every change lands in Activity. Safeguards can require your approval for anything (for example `env_*` and `services_stop`).

## Where things live

`~/.jarvis/` holds these files. All of them are plain files you can edit.

| File | What |
|---|---|
| `config.json` | providers, gateways, memory, learning, timezone |
| `safeguards.json` | tool rules (allow / ask / deny), Codex sandbox |
| `schedules.json` | cron jobs |
| `mcp.json` | MCP servers (same shape as Claude Code's) |
| `.env` | variables passed to agents (chmod 600) |
| `SOUL.md`, `memories/`, `skills/` | identity, native memory, skills |
| `data/harness.db` | runs, events, transcripts (FTS), audit log |
| `backups/` | pre-import snapshots and nightly memory backups |

Logs are in `~/Library/Logs/Mac Mini Jarvis/`.

## Development

```sh
npm run dev
npm run typecheck
JARVIS_HOME=/tmp/jarvis npm run dev   # isolated data folder
```

## License

MIT
