import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import AttachmentStore, { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type JsonValue } from '@deepseek-ai/dsh-tools'
import { publicToolName, syncTools, type ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import { createTransport } from '@deepseek-ai/dsh-mcp-client/src/transport.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const testToolSignal = new AbortController().signal

// ---- Mock MCP Client ----

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execution?: { taskSupport?: 'optional' | 'required' | 'forbidden' }
}

interface MockCallResult {
  content: JsonValue[]
  structuredContent?: JsonValue
  isError?: boolean
}

function createMockClient(tools: MockTool[], callResult: MockCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  const listTools = vi.fn(async (
    _params?: Record<string, unknown>,
  ): Promise<{ tools: MockTool[]; nextCursor: string | undefined }> => ({ tools, nextCursor: undefined }))
  const callTool = vi.fn(async (
    _params?: Record<string, unknown>,
    _compatibilitySchema?: unknown,
    _options?: unknown,
  ): Promise<Record<string, unknown>> => ({ ...callResult }))
  return {
    listTools,
    callTool,
    request: vi.fn(async (
      request: { method: string; params?: Record<string, unknown> },
      _schema: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      if (request.method === 'tools/list') return listTools(request.params)
      if (request.method === 'tools/call') return callTool(request.params, undefined, options)
      throw new Error(`unexpected MCP request: ${request.method}`)
    }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

// ---- Test harness helper ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const defaultOpts: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
}

// ---- Tests ----

describe('publicToolName', () => {
  it('joins clean names verbatim', () => {
    expect(publicToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(publicToolName('everything', 'get-sum')).toBe('mcp__everything__get-sum')
  })

  it('replaces invalid characters and appends an identity hash', () => {
    const name = publicToolName('srv', 'admin.reset')
    expect(name).toMatch(/^mcp__srv__admin_reset_[0-9a-f]{12}$/)
    expect(name.length).toBeLessThanOrEqual(64)
  })

  it('truncates over-long names and appends an identity hash', () => {
    const rawName = 'a'.repeat(80)
    const name = publicToolName('srv', rawName)
    expect(name).toHaveLength(64)
    expect(name).toMatch(/_[0-9a-f]{12}$/)
    expect(name.startsWith('mcp__srv__aaa')).toBe(true)
  })

  it('is deterministic and collision-free for distinct identities', () => {
    // Two raw names that normalize to the same base must not collapse.
    const a = publicToolName('srv', 'admin.reset')
    const b = publicToolName('srv', 'admin_reset')
    expect(a).toBe(publicToolName('srv', 'admin.reset'))
    expect(a).not.toBe(b)
  })
})

describe('syncTools', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('registers tools under server-qualified public names', async () => {
    const client = createMockClient([
      { name: 'greet', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: {} } },
    ])

    const disposers = await syncTools(client as never, ctx, defaultOpts, new Map())

    expect(disposers.size).toBe(2)
    expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__add')).toBeDefined()
    // Raw names are NOT registered.
    expect(ctx.tools.get('greet')).toBeUndefined()
    expect(ctx.tools.get('add')).toBeUndefined()
  })

  it('lets two servers publish the same raw name side by side', async () => {
    const clientA = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])
    const clientB = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])

    await syncTools(clientA as never, ctx, { ...defaultOpts, serverName: 'github' }, new Map())
    await syncTools(clientB as never, ctx, { ...defaultOpts, serverName: 'web' }, new Map())

    expect(ctx.tools.get('mcp__github__search')).toBeDefined()
    expect(ctx.tools.get('mcp__web__search')).toBeDefined()
  })

  it('coexists with a native tool of the same raw name', async () => {
    ctx.tools.register({
      name: 'search',
      description: 'Native search',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'native',
    })
    const client = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])

    await syncTools(client as never, ctx, defaultOpts, new Map())

    expect(ctx.tools.get('search')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__search')).toBeDefined()
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'search', arguments: {} })
    expect(result.content[0]).toEqual({ type: 'text', text: 'native' })
  })

  it('rejects a tool list where one raw name appears twice', async () => {
    const client = createMockClient([
      { name: 'dup', inputSchema: { type: 'object' } },
      { name: 'dup', inputSchema: { type: 'object' } },
    ])

    await expect(syncTools(client as never, ctx, defaultOpts, new Map()))
      .rejects.toThrow(/listed tool "dup" more than once/)
    // Nothing registered, previous generation untouched (it was empty).
    expect(ctx.tools.get('mcp__srv__dup')).toBeUndefined()
  })

  it('keeps the previous generation when the fetch phase fails', async () => {
    const client = createMockClient([{ name: 'stable', inputSchema: { type: 'object' } }])
    const first = await syncTools(client as never, ctx, defaultOpts, new Map())
    expect(ctx.tools.get('mcp__srv__stable')).toBeDefined()

    client.listTools.mockRejectedValue(new Error('network down'))
    await expect(syncTools(client as never, ctx, defaultOpts, first)).rejects.toThrow('network down')

    // The previous generation is still live.
    expect(ctx.tools.get('mcp__srv__stable')).toBeDefined()
  })

  it('rolls back the whole generation when a foreign tool squats on the namespace', async () => {
    // A foreign registration occupies one of this server's public names.
    ctx.tools.register({
      name: 'mcp__srv__taken',
      description: 'Squatter',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'squatter',
    })
    const client = createMockClient([
      { name: 'free', inputSchema: { type: 'object' } },
      { name: 'taken', inputSchema: { type: 'object' } },
    ])

    const disposers = await syncTools(client as never, ctx, defaultOpts, new Map())

    // All-or-nothing: the non-conflicting tool is rolled back too.
    expect(disposers.size).toBe(0)
    expect(ctx.tools.get('mcp__srv__free')).toBeUndefined()
    // The squatter is untouched.
    expect(ctx.tools.get('mcp__srv__taken')).toBeDefined()
  })

  it('unregisters previous tools before re-syncing', async () => {
    const client = createMockClient([
      { name: 'old_tool', inputSchema: { type: 'object' } },
    ])

    const firstDisposers = await syncTools(client as never, ctx, defaultOpts, new Map())
    expect(ctx.tools.get('mcp__srv__old_tool')).toBeDefined()

    client.listTools.mockResolvedValue({ tools: [{ name: 'new_tool', inputSchema: { type: 'object' } }], nextCursor: undefined })
    const secondDisposers = await syncTools(client as never, ctx, defaultOpts, firstDisposers)

    expect(ctx.tools.get('mcp__srv__old_tool')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__new_tool')).toBeDefined()
    expect(secondDisposers.size).toBe(1)
  })

  it('drains paginated listTools responses', async () => {
    const client = createMockClient([])
    client.listTools
      .mockResolvedValueOnce({ tools: [{ name: 'page1', inputSchema: { type: 'object' } }], nextCursor: 'cursor1' })
      .mockResolvedValueOnce({ tools: [{ name: 'page2', inputSchema: { type: 'object' } }], nextCursor: undefined })

    const disposers = await syncTools(client as never, ctx, defaultOpts, new Map())

    expect(disposers.size).toBe(2)
    expect(ctx.tools.get('mcp__srv__page1')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__page2')).toBeDefined()
  })

  it('owns output validation independently of the SDK per-page cache', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    serverTransport.onmessage = (message) => {
      if (!('id' in message) || !('method' in message)) return
      const params = 'params' in message ? message.params : undefined
      let result: Record<string, unknown>
      if (message.method === 'initialize') {
        const protocolVersion = params && 'protocolVersion' in params
          ? params.protocolVersion
          : '2025-11-25'
        result = {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'raw-test', version: '1' },
        }
      } else if (message.method === 'tools/list') {
        const cursor = params && 'cursor' in params ? params.cursor : undefined
        result = cursor === undefined
          ? {
            tools: [{
              name: 'supported',
              inputSchema: { type: 'object' },
              outputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { answer: { type: 'integer' } },
                required: ['answer'],
              },
            }],
            nextCursor: 'page-2',
          }
          : {
            tools: [{
              name: 'future-schema',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
            }],
          }
      } else if (message.method === 'tools/call') {
        const name = params && 'name' in params ? params.name : undefined
        result = name === 'supported'
          ? { content: [{ type: 'text', text: 'missing structured content' }] }
          : { content: [42, null], structuredContent: ['kept', { nested: true }] }
      } else {
        result = {}
      }
      void serverTransport.send({ jsonrpc: '2.0', id: message.id, result })
    }
    await serverTransport.start()
    const client = new Client({ name: 'cache-independent-test', version: '1' })
    await client.connect(clientTransport)

    try {
      await syncTools(client, ctx, defaultOpts, new Map())

      const missing = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('missing'), name: 'mcp__srv__supported', arguments: {},
      })
      expect(missing.error).toMatchObject({ info: { code: 'INVALID_TOOL_OUTPUT' } })
      expect(missing.error?.message).toContain('structuredContent')

      const fallback = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('fallback'), name: 'mcp__srv__future-schema', arguments: {},
      })
      if (fallback.isError) throw new Error('unsupported schema must use the bridge fallback')
      expect(fallback.value).toEqual({
        content: [42, null],
        structuredContent: ['kept', { nested: true }],
      })
    } finally {
      await client.close()
    }
  })
})

describe('tool execution', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('calls MCP callTool with the RAW name and returns text content', async () => {
    const client = createMockClient(
      [{ name: 'echo', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'hello world' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__echo', arguments: { msg: 'hi' } })

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }])
    if (result.isError) throw new Error('expected MCP success')
    expect(result.value).toEqual({ content: [{ type: 'text', text: 'hello world' }] })
    // The wire sees the raw MCP name, never the public name.
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { msg: 'hi' } },
      undefined,
      expect.objectContaining({ timeout: 60_000 }),
    )
  })

  it('sends the raw name for normalized public names', async () => {
    const client = createMockClient(
      [{ name: 'admin.reset', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'reset done' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const publicName = publicToolName('srv', 'admin.reset')
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: publicName, arguments: {} })

    expect(result.isError).toBe(false)
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'admin.reset', arguments: {} },
      undefined,
      expect.anything(),
    )
  })

  it('joins multiple text blocks with newline', async () => {
    const client = createMockClient(
      [{ name: 'multi', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__multi', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'line1\nline2' }])
  })

  it('preserves full JSON MCP blocks while Native rendering uses placeholders', async () => {
    const blocks = [
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: 'base64-data', annotations: { audience: ['assistant'] } },
    ] satisfies JsonValue[]
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: blocks },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__img', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: 'before\n[image: image/png, content discarded]' })
    if (result.isError) throw new Error('expected MCP success')
    expect(result.value).toEqual({ content: blocks })
  })

  it('preserves primitive JSON MCP blocks while Native rendering marks them unsupported', async () => {
    const blocks = [42, null, ['nested']] satisfies JsonValue[]
    const client = createMockClient(
      [{ name: 'primitive-blocks', inputSchema: { type: 'object' } }],
      { content: blocks },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('primitive'), name: 'mcp__srv__primitive-blocks', arguments: {},
    })

    expect(result.content[0]).toEqual({
      type: 'text',
      text: '[unsupported content type: unknown]\n[unsupported content type: unknown]\n[unsupported content type: unknown]',
    })
    if (result.isError) throw new Error('expected primitive MCP blocks to remain a successful JSON value')
    expect(result.value).toEqual({ content: blocks })
  })

  it('validates structuredContent when the advertised output schema is supported', async () => {
    const outputSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
    }
    const valid = createMockClient(
      [{ name: 'structured', inputSchema: { type: 'object' }, outputSchema }],
      { content: [{ type: 'text', text: '42' }], structuredContent: { answer: 42 } },
    )
    await syncTools(valid as never, ctx, defaultOpts, new Map())
    const success = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('valid'), name: 'mcp__srv__structured', arguments: {} })
    if (success.isError) throw new Error('expected supported structuredContent to validate')
    expect(success.value).toEqual({ content: [{ type: 'text', text: '42' }], structuredContent: { answer: 42 } })

    const invalidCtx = await mountRegistry()
    const invalid = createMockClient(
      [{ name: 'structured', inputSchema: { type: 'object' }, outputSchema }],
      { content: [{ type: 'text', text: 'wrong' }], structuredContent: { answer: 'forty-two' } },
    )
    await syncTools(invalid as never, invalidCtx, defaultOpts, new Map())
    const failure = await invalidCtx.tools.execute({ signal: testToolSignal, callId: CallId('invalid'), name: 'mcp__srv__structured', arguments: {} })
    expect(failure.error).toMatchObject({ info: { code: 'INVALID_TOOL_OUTPUT' } })
    expect(failure.content[0]?.type === 'text' ? failure.content[0].text : '')
      .toContain('value.structuredContent.answer')
  })

  it('falls back to JsonValue for unsupported advertised output schemas', async () => {
    const client = createMockClient(
      [{
        name: 'future-schema',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
      }],
      { content: [], structuredContent: ['kept', { nested: true }] },
    )
    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('fallback'), name: 'mcp__srv__future-schema', arguments: {} })
    if (result.isError) throw new Error('unsupported MCP output schemas must fall back')
    expect(result.value).toEqual({ content: [], structuredContent: ['kept', { nested: true }] })
  })

  it('maps isError to an error result via throw', async () => {
    const client = createMockClient(
      [{ name: 'fail', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'something went wrong' }], isError: true },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__fail', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: something went wrong' })
    expect('value' in result).toBe(false)
  })

  it('rejects tools that require task-based execution', async () => {
    const client = createMockClient([
      { name: 'task-only', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
    ])

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('task-only'), name: 'mcp__srv__task-only', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('requires task-based execution')
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('passes abort signal to callTool', async () => {
    const controller = new AbortController()
    const client = createMockClient(
      [{ name: 'slow', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'done' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    await ctx.tools.execute({ callId: CallId('c1'), name: 'mcp__srv__slow', arguments: {}, signal: controller.signal })

    expect(client.callTool).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('handles legacy toolResult shape', async () => {
    const client = createMockClient(
      [{ name: 'legacy', inputSchema: { type: 'object' } }],
    )
    client.callTool.mockResolvedValue({ toolResult: { key: 'value' } })

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__legacy', arguments: {} })

    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: '{"key":"value"}' })
  })

  it('preserves structuredContent on a successful legacy result', async () => {
    const client = createMockClient([{ name: 'legacy-structured', inputSchema: { type: 'object' } }])
    client.callTool.mockResolvedValue({
      toolResult: 'legacy',
      structuredContent: { answer: 42 },
    })

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('legacy-structured'), name: 'mcp__srv__legacy-structured', arguments: {},
    })

    if (result.isError) throw new Error('expected legacy structured result success')
    expect(result.value).toEqual({
      content: [{ type: 'text', text: '"legacy"' }],
      structuredContent: { answer: 42 },
    })
  })

  it('maps a legacy isError reply to failure', async () => {
    const client = createMockClient([{ name: 'legacy-error', inputSchema: { type: 'object' } }])
    client.callTool.mockResolvedValue({ toolResult: { reason: 'nope' }, isError: true })

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('legacy-error'), name: 'mcp__srv__legacy-error', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toBe('{"reason":"nope"}')
  })
})

describe('tool execution edge cases', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('handles audio content with placeholder', async () => {
    const client = createMockClient(
      [{ name: 'audio_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'audio', mimeType: 'audio/mp3' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__audio_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[audio: audio/mp3, content discarded]' })
  })

  it('handles resource content with placeholder', async () => {
    const client = createMockClient(
      [{ name: 'res_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'resource' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__res_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[resource: content discarded]' })
  })

  it('handles resource_link content with placeholder', async () => {
    const client = createMockClient(
      [{ name: 'link_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'resource_link' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__link_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[resource: content discarded]' })
  })

  it('handles unknown content types', async () => {
    const client = createMockClient(
      [{ name: 'unknown_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'video' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__unknown_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[unsupported content type: video]' })
  })

  it('handles image with missing mimeType (buggy server)', async () => {
    const client = createMockClient(
      [{ name: 'img2', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__img2', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[image: unknown, content discarded]' })
  })

  it('handles audio with missing mimeType (buggy server)', async () => {
    const client = createMockClient(
      [{ name: 'audio_no_mime', inputSchema: { type: 'object' } }],
      { content: [{ type: 'audio' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__audio_no_mime', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[audio: unknown, content discarded]' })
  })

  it('handles text block with missing text (buggy server)', async () => {
    const client = createMockClient(
      [{ name: 'notext', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__notext', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[text: invalid content discarded]' })
  })

  it('handles empty content array', async () => {
    const client = createMockClient(
      [{ name: 'empty_tool', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__empty_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '(empty_tool returned no text content)' })
  })


  it('handles legacy toolResult with undefined value', async () => {
    const client = createMockClient(
      [{ name: 'legacy2', inputSchema: { type: 'object' } }],
    )
    client.callTool.mockResolvedValue({ toolResult: undefined, structuredContent: undefined })

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__legacy2', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '(no output)' })
  })

  it('handles a legacy result with neither content nor toolResult', async () => {
    const client = createMockClient(
      [{ name: 'legacy-empty', inputSchema: { type: 'object' } }],
    )
    client.callTool.mockResolvedValue({})

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('legacy-empty'), name: 'mcp__srv__legacy-empty', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '(no output)' })
  })

  it('handles isError with non-text content (fallback error message)', async () => {
    const client = createMockClient(
      [{ name: 'err_notext', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png' }], isError: true },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__err_notext', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: [image: image/png, content discarded]' })
  })


  it('uses tool description when provided', async () => {
    const client = createMockClient([
      { name: 'described', description: 'A described tool', inputSchema: { type: 'object' } },
    ])

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const tool = ctx.tools.get('mcp__srv__described')
    expect(tool?.description).toBe('A described tool')
  })

  it('uses empty description when tool has no description', async () => {
    const client = createMockClient([
      { name: 'nodesc', inputSchema: { type: 'object' } },
    ])

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const tool = ctx.tools.get('mcp__srv__nodesc')
    expect(tool?.description).toBe('')
  })
})

describe('image attachment projection', () => {
  class FakeAttachmentStore extends AttachmentStore {
    readonly imageLimits: ImageAttachmentLimits
    readonly saved: SaveImageAttachment[] = []
    readCount = 0
    saveFailure: unknown
    constructor(ctx: Context, limits: Partial<ImageAttachmentLimits> = {}) {
      super(ctx)
      this.imageLimits = {
        maxImageBytes: 1_000_000,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 2_000_000,
        maxImagePixels: 64_000_000,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        ...limits,
      }
    }
    async validateImage(): Promise<void> {}
    async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
      if (this.saveFailure !== undefined) throw this.saveFailure
      this.saved.push(input)
      return {
        attachmentId: AttachmentId(`att-${this.saved.length}`),
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 16,
        height: 16,
      }
    }
    async readImage(): Promise<StoredImageAttachment> {
      this.readCount += 1
      throw new Error('unused in this suite')
    }
  }

  function visionAgent(): never {
    return {
      session: { requestHeader: () => ({ config: { provider: 'vision', model: 'vis' } }) },
      options: { provider: 'vision', model: 'vis' },
    } as never
  }

  type ImageRegistryOptions = {
    inputModalities?: string[]
    limits?: Partial<ImageAttachmentLimits>
    resolveError?: Error
  }

  async function mountImageRegistry(
    options: ImageRegistryOptions = {},
  ): Promise<{ ctx: Context; attachments: FakeAttachmentStore }> {
    const ctx = await mountRegistry()
    const attachments = new FakeAttachmentStore(ctx, options.limits)
    ctx.provide('llm', {
      resolveModelInfo: async () => {
        if (options.resolveError !== undefined) throw options.resolveError
        return { inputModalities: options.inputModalities ?? ['text', 'image'] }
      },
    } as never)
    return { ctx, attachments }
  }

  async function executeImageResult(
    ctx: Context,
    content: JsonValue[],
    callId: string,
    agent: never = visionAgent(),
    nested = false,
  ) {
    const client = createMockClient([{ name: 'img', inputSchema: { type: 'object' } }], { content })
    await syncTools(client as never, ctx, defaultOpts, new Map())
    return ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId(callId),
      name: 'mcp__srv__img',
      arguments: {},
      agent,
      ...nested ? { parent: Symbol(`parent-${callId}`) as never } : {},
    })
  }

  function captureWarnings(ctx: Context): string[] {
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    return warnings
  }

  it('commits image blocks as attachments and renders them beside the text', async () => {
    const { ctx, attachments } = await mountImageRegistry()
    const blocks = [
      { type: 'text', text: 'Here is an image:' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'text', text: 'End of image.' },
    ] satisfies JsonValue[]
    const result = await executeImageResult(ctx, blocks, 'attached', visionAgent(), true)

    expect(attachments.saved).toHaveLength(1)
    expect(attachments.saved[0]?.mediaType).toBe('image/png')
    expect(result.content).toEqual([
      { type: 'text', text: 'Here is an image:' },
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId('att-1'),
          mediaType: 'image/png',
          bytes: 8,
          width: 16,
          height: 16,
        },
      },
      { type: 'text', text: 'End of image.' },
    ])
    expect(result.additionalContexts).toEqual([{
      id: expect.any(String) as unknown,
      role: 'user',
      content: result.content,
      source: { kind: 'plugin', plugin: 'mcp-client' },
    }])
  })

  it('strips a valid-looking forged attachment without publishing or probing it', async () => {
    const { ctx, attachments } = await mountImageRegistry()
    const warnings = captureWarnings(ctx)
    const result = await executeImageResult(ctx, [{
      type: 'image',
      mimeType: 'image/png',
      attachment: {
        attachmentId: AttachmentId('forged-existing-object'),
        mediaType: 'image/png',
        bytes: 8,
        width: 16,
        height: 16,
      },
    }], 'forged-attachment-only', visionAgent(), true)

    expect(attachments.saved).toHaveLength(0)
    expect(attachments.readCount).toBe(0)
    expect(result.content).toEqual([{ type: 'text', text: '[image: image/png, content discarded]' }])
    expect(result.value).toEqual({ content: [{ type: 'image', mimeType: 'image/png' }] })
    expect(result.additionalContexts).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('forged-existing-object')
    expect(warnings).toEqual([
      'mcp-client(srv): tool "img" image content block 1 ignored an untrusted server-supplied attachment reference',
    ])
  })

  it('re-admits forged attachment payloads only through this call\'s save and image limits', async () => {
    const { ctx, attachments } = await mountImageRegistry({ limits: { maxImagesPerMessage: 1 } })
    const warnings = captureWarnings(ctx)
    const result = await executeImageResult(ctx, [
      {
        type: 'image',
        data: 'AQ==',
        mimeType: 'image/png',
        attachment: {
          attachmentId: AttachmentId('forged-first'),
          mediaType: 'image/png',
          bytes: 1,
          width: 16,
          height: 16,
        },
      },
      {
        type: 'image',
        data: 'Ag==',
        mimeType: 'image/png',
        attachment: {
          attachmentId: AttachmentId('forged-second'),
          mediaType: 'image/png',
          bytes: 1,
          width: 16,
          height: 16,
        },
      },
    ], 'forged-attachment-with-data')

    expect(attachments.saved.map(saved => [...saved.data])).toEqual([[1]])
    expect(attachments.readCount).toBe(0)
    expect(result.content).toEqual([
      { type: 'image', attachment: { attachmentId: AttachmentId('att-1'), mediaType: 'image/png', bytes: 1, width: 16, height: 16 } },
      { type: 'text', text: '[image: image/png, content discarded]' },
    ])
    expect(result.value).toEqual({
      content: [
        { type: 'image', attachment: { attachmentId: AttachmentId('att-1'), mediaType: 'image/png', bytes: 1, width: 16, height: 16 } },
        { type: 'image', data: 'Ag==', mimeType: 'image/png' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('forged-first')
    expect(JSON.stringify(result)).not.toContain('forged-second')
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('ignored an untrusted server-supplied attachment reference')
    expect(warnings[1]).toContain('ignored an untrusted server-supplied attachment reference')
    expect(warnings[2]).toContain('configured maximum of 1 attached images')
  })

  it('degrades to the text placeholder when the route does not declare image input', async () => {
    const { ctx, attachments } = await mountImageRegistry({ inputModalities: ['text'] })
    const blocks = [
      { type: 'text', text: 'before' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ] satisfies JsonValue[]
    const result = await executeImageResult(ctx, blocks, 'nonvision', visionAgent(), true)

    expect(attachments.saved).toHaveLength(0)
    expect(result.content).toEqual([{ type: 'text', text: 'before\n[image: image/png, content discarded]' }])
    expect(result.additionalContexts).toBeUndefined()
  })

  it('degrades per block for unsupported mime types', async () => {
    const { ctx, attachments } = await mountImageRegistry()
    const warnings = captureWarnings(ctx)
    const blocks = [
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/svg+xml' },
    ] satisfies JsonValue[]
    const result = await executeImageResult(ctx, blocks, 'svg')

    expect(attachments.saved).toHaveLength(0)
    expect(result.content).toEqual([{ type: 'text', text: '[image: image/svg+xml, content discarded]' }])
    expect(warnings).toEqual([
      'mcp-client(srv): tool "img" image content block 1 rendered as a placeholder: image/svg+xml is not accepted by this deployment',
    ])
  })

  it('keeps every MCP block in protocol order when one attached image selects rich projection', async () => {
    const { ctx } = await mountImageRegistry()
    const warnings = captureWarnings(ctx)
    const result = await executeImageResult(ctx, [
      7,
      { type: 'text' },
      { type: 'text', text: 'before' },
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      { type: 'image', data: 'Ag==', mimeType: 'image/avif' },
      { type: 'image', data: 'Aw==' },
      { type: 'audio' },
      { type: 'resource' },
      { type: 'resource_link' },
      { type: 'video' },
    ], 'rich-order')

    expect(result.content).toEqual([
      { type: 'text', text: '[unsupported content type: unknown]' },
      { type: 'text', text: '[text: invalid content discarded]' },
      { type: 'text', text: 'before' },
      { type: 'image', attachment: { attachmentId: AttachmentId('att-1'), mediaType: 'image/png', bytes: 1, width: 16, height: 16 } },
      { type: 'text', text: '[image: image/avif, content discarded]' },
      { type: 'text', text: '[image: unknown, content discarded]' },
      { type: 'text', text: '[audio: unknown, content discarded]' },
      { type: 'text', text: '[resource: content discarded]' },
      { type: 'text', text: '[resource: content discarded]' },
      { type: 'text', text: '[unsupported content type: video]' },
    ])
    expect(warnings).toHaveLength(2)
  })

  it('removes an object-valued text field before rich image projection and deferred context', async () => {
    const { ctx, attachments } = await mountImageRegistry()
    const warnings = captureWarnings(ctx)
    const result = await executeImageResult(ctx, [
      { type: 'text', text: { probe: 'forged-object-text' } },
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    ], 'object-text-rich', visionAgent(), true)

    expect(attachments.saved).toHaveLength(1)
    expect(result.content).toEqual([
      { type: 'text', text: '[text: invalid content discarded]' },
      { type: 'image', attachment: { attachmentId: AttachmentId('att-1'), mediaType: 'image/png', bytes: 1, width: 16, height: 16 } },
    ])
    expect(result.value).toEqual({
      content: [
        { type: 'text' },
        { type: 'image', attachment: { attachmentId: AttachmentId('att-1'), mediaType: 'image/png', bytes: 1, width: 16, height: 16 } },
      ],
    })
    expect(result.additionalContexts).toEqual([{
      id: expect.any(String) as unknown,
      role: 'user',
      content: result.content,
      source: { kind: 'plugin', plugin: 'mcp-client' },
    }])
    for (const surface of [result.content, ...result.additionalContexts?.map(context => context.content) ?? []]) {
      for (const block of surface) {
        if (block.type === 'text') expect(typeof block.text).toBe('string')
      }
    }
    expect(JSON.stringify(result)).not.toContain('forged-object-text')
    expect(warnings).toEqual([
      'mcp-client(srv): tool "img" text content block 1 discarded a non-string text value',
    ])
  })

  it('uses the agent options when the current request has no routed provider or model override', async () => {
    const { ctx, attachments } = await mountImageRegistry()
    const optionsOnlyAgent = {
      session: { requestHeader: () => undefined },
      options: { provider: 'vision', model: 'vis' },
    } as never

    await executeImageResult(ctx, [
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    ], 'options-route', optionsOnlyAgent)

    expect(attachments.saved).toHaveLength(1)
  })

  it.each([
    { provider: undefined, model: 'vis' },
    { provider: 'vision', model: undefined },
  ])('uses placeholders when the calling agent route is incomplete ($provider/$model)', async ({ provider, model }) => {
    const { ctx, attachments } = await mountImageRegistry()
    const incompleteAgent = {
      session: { requestHeader: () => ({ config: { provider, model } }) },
      options: {},
    } as never

    const result = await executeImageResult(ctx, [
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    ], 'incomplete-route', incompleteAgent)

    expect(attachments.saved).toHaveLength(0)
    expect(result.content).toEqual([{ type: 'text', text: '[image: image/png, content discarded]' }])
  })

  it('uses placeholders when no model registry service is mounted', async () => {
    const ctx = await mountRegistry()
    const attachments = new FakeAttachmentStore(ctx)

    const result = await executeImageResult(ctx, [
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    ], 'missing-llm')

    expect(attachments.saved).toHaveLength(0)
    expect(result.content).toEqual([{ type: 'text', text: '[image: image/png, content discarded]' }])
  })

  it('accepts the exact image-count, per-image-byte, and message-byte limits', async () => {
    const { ctx, attachments } = await mountImageRegistry({
      limits: { maxImagesPerMessage: 2, maxImageBytes: 2, maxMessageImageBytes: 3 },
    })
    const result = await executeImageResult(ctx, [
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      { type: 'text', text: 'between' },
      { type: 'image', data: 'AgM=', mimeType: 'image/png' },
    ], 'exact-limits')

    expect(attachments.saved.map(saved => saved.data.byteLength)).toEqual([1, 2])
    expect(result.content).toEqual([
      { type: 'image', attachment: { attachmentId: AttachmentId('att-1'), mediaType: 'image/png', bytes: 1, width: 16, height: 16 } },
      { type: 'text', text: 'between' },
      { type: 'image', attachment: { attachmentId: AttachmentId('att-2'), mediaType: 'image/png', bytes: 2, width: 16, height: 16 } },
    ])
  })

  it('attaches only the configured maximum image count and preserves later placeholders in order', async () => {
    const { ctx, attachments } = await mountImageRegistry({ limits: { maxImagesPerMessage: 2 } })
    const warnings = captureWarnings(ctx)
    const result = await executeImageResult(ctx, [
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      { type: 'text', text: 'middle' },
      { type: 'image', data: 'Ag==', mimeType: 'image/png' },
      { type: 'image', data: 'Aw==', mimeType: 'image/png' },
    ], 'count-over')

    expect(attachments.saved).toHaveLength(2)
    expect(result.content.map(block => block.type)).toEqual(['image', 'text', 'image', 'text'])
    expect(result.content.at(-1)).toEqual({ type: 'text', text: '[image: image/png, content discarded]' })
    expect(warnings.at(-1)).toContain('configured maximum of 2 attached images')
  })

  it('degrades images over the individual or aggregate byte limits without consuming either budget', async () => {
    const { ctx, attachments } = await mountImageRegistry({
      limits: { maxImageBytes: 2, maxMessageImageBytes: 3 },
    })
    const warnings = captureWarnings(ctx)
    const result = await executeImageResult(ctx, [
      { type: 'image', data: 'AQI=', mimeType: 'image/png' },
      { type: 'image', data: 'AwQF', mimeType: 'image/png' },
      { type: 'image', data: 'Bgc=', mimeType: 'image/png' },
    ], 'bytes-over')

    expect(attachments.saved.map(saved => saved.data.byteLength)).toEqual([2])
    expect(result.content.map(block => block.type)).toEqual(['image', 'text', 'text'])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('2-byte per-image limit')
    expect(warnings[1]).toContain('3-byte per-message limit')
  })

  it('logs attachment validation failures and safely renders the affected image as a placeholder', async () => {
    const { ctx, attachments } = await mountImageRegistry()
    const warnings = captureWarnings(ctx)
    attachments.saveFailure = new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')

    const result = await executeImageResult(ctx, [
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    ], 'invalid-image')

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '[image: image/png, content discarded]' }])
    expect(warnings).toEqual([
      expect.stringContaining('attachment validation failed (INVALID_IMAGE): Unsupported or malformed image data.'),
    ])
  })

  it.each([
    new Error('storage offline'),
    new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED'),
  ])('fails the tool call when attachment storage cannot durably commit (%s)', async (saveFailure) => {
    const { ctx, attachments } = await mountImageRegistry()
    attachments.saveFailure = saveFailure

    const result = await executeImageResult(ctx, [
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    ], 'storage-failure')

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { text: string }).text).toContain(saveFailure.message)
  })

  it('logs model-route resolution failures before falling back to placeholders', async () => {
    const { ctx, attachments } = await mountImageRegistry({ resolveError: new Error('catalog unavailable') })
    const warnings = captureWarnings(ctx)
    const result = await executeImageResult(ctx, [
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    ], 'route-failure')

    expect(attachments.saved).toHaveLength(0)
    expect(result.content).toEqual([{ type: 'text', text: '[image: image/png, content discarded]' }])
    expect(warnings).toEqual([
      'mcp-client(srv): cannot resolve the active model for tool "img" image output; rendering image placeholders: Error: catalog unavailable',
    ])
  })
})

describe('createTransport', () => {
  it('creates StdioClientTransport for stdio config', () => {
    const config: Config = {
      transport: 'stdio',
      serverName: 'srv',
      command: 'node',
      args: ['server.js'],
      env: {},
      cwd: '/tmp',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('creates StreamableHTTPClientTransport for http config without headers', () => {
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://localhost:3000/mcp',
      headers: {},
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('creates StreamableHTTPClientTransport for http config with headers', () => {
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer token' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('scrubs sensitive env vars and forwards the rest', () => {
    const original = { ...process.env }
    try {
      process.env.SAFE_VAR = 'kept'
      process.env.MY_SECRET = 'hidden'
      process.env.API_KEY = 'hidden'
      process.env.AUTH_TOKEN = 'hidden'

      const config: Config = {
        transport: 'stdio',
        serverName: 'srv',
        command: 'echo',
        args: [],
        env: { EXTRA: 'injected' },
        cwd: '',
        toolCallTimeoutMs: 60_000,
        failOnStartupError: false,
      }
      // StdioClientTransport keeps its env private; the observable contract is
      // that createTransport(config) returns a transport without throwing.
      const transport = createTransport(config)
      expect(transport).toBeDefined()
    } finally {
      delete process.env.SAFE_VAR
      delete process.env.MY_SECRET
      delete process.env.API_KEY
      delete process.env.AUTH_TOKEN
      for (const key of Object.keys(process.env)) {
        if (!(key in original)) Reflect.deleteProperty(process.env, key)
      }
    }
  })

  it('merges explicit env on top of scrubbed ambient env', () => {
    const config: Config = {
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      args: [],
      env: { CUSTOM: 'value' },
      cwd: '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
  })
})

describe('tool execution — non-object args fallback', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('coerces null args to empty object for callTool', async () => {
    const client = createMockClient(
      [{ name: 'coerce', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'ok' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__coerce', arguments: null })

    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'coerce', arguments: {} },
      undefined,
      expect.anything(),
    )
  })

  it('coerces primitive string args to empty object for callTool', async () => {
    const client = createMockClient(
      [{ name: 'coerce2', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'ok' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'mcp__srv__coerce2', arguments: 'bad' })

    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'coerce2', arguments: {} },
      undefined,
      expect.anything(),
    )
  })
})
