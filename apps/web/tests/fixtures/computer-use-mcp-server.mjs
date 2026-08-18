import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const requireFromMcpClient = createRequire(
  new URL('../../../../packages/mcp/mcp-client/package.json', import.meta.url),
)
const { McpServer } = requireFromMcpClient('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = requireFromMcpClient('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = requireFromMcpClient('zod')

const callLog = process.env.DSH_COMPUTER_USE_MCP_CALL_LOG
if (callLog === undefined || callLog.length === 0) {
  throw new Error('DSH_COMPUTER_USE_MCP_CALL_LOG is required')
}

const server = new McpServer(
  { name: 'computer-use-snapshot', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.registerTool('greet', {
  title: 'Greet Tool',
  description: 'Greets a person by name.',
  inputSchema: { name: z.string().describe('Name to greet') },
}, async (args) => {
  appendFileSync(callLog, `${JSON.stringify({ name: 'greet', arguments: args })}\n`)
  return { content: [{ type: 'text', text: `Hello, ${args.name}!` }] }
})

await server.connect(new StdioServerTransport())
