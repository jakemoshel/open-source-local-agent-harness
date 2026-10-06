// A minimal stdio MCP server for tests: one `echo` tool that also reports this process's pid.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

const server = new McpServer({ name: 'echo', version: '1.0.0' })
server.registerTool('echo', { description: 'Echo text', inputSchema: { text: z.string() } }, async ({ text }, extra) => {
  if (extra._meta?.progressToken !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: 1, total: 1 } })
  return { content: [{ type: 'text', text: `${text} from ${process.pid}` }] }
})
if (process.env.STARTUP_MARKER) {
  writeFileSync(process.env.STARTUP_MARKER, String(process.pid))
  await setTimeout(5000)
}
await server.connect(new StdioServerTransport())
