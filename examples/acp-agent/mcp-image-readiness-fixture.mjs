/** Snapshot-only readiness marker for the asynchronously discovered MCP tool. */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TOOL_NAME = 'mcp__snapshot_image__render_chart'
const MARKER = resolve(process.cwd(), '.mcp-image-ready')

/** Cordis plugin name. */
export const name = 'mcp-image-readiness-fixture'
/** The fixture observes the assembled tool registry. */
export const inject = ['tools']

/**
 * Publish a marker only after the real MCP client has registered its tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Assembled app context.
 */
export function apply(ctx) {
  let ready = false
  const publish = () => {
    if (ready || ctx.tools.get(TOOL_NAME) === undefined) return
    ready = true
    writeFileSync(MARKER, '')
  }
  ctx.on('tools/change', publish)
  publish()
}
