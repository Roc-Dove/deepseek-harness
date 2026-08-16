/**
 * Tool bridge: discovers MCP tools, registers them on the harness ToolRuntime
 * under deterministic server-qualified public names, and handles re-sync when
 * the server's tool list changes.
 *
 * Naming contract (see the mcp-client Agent Note "Naming invariants"): every MCP tool
 * has the stable identity `(serverName, rawName)`; the model-facing public name
 * is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
 * constraints. The raw name is only ever sent on the wire (`tools/call`); the
 * public name is never parsed to recover it.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, JsonValue } from '@deepseek-ai/dsh-tools'

/** Resolved options relevant to tool bridging. */
export interface ToolBridgeOptions {
  /** Whether a registry conflict is contained or rejects this synchronization. */
  registrationFailure: 'contain' | 'throw'
  serverName: string
  toolCallTimeoutMs: number
}

/** State for one sync generation: the current set of disposers keyed by public name. */
export type ToolDisposers = Map<string, () => void>

/** Canonical MCP result exposed to Code Mode; admitted images carry durable attachment references. */
export type McpResult<Structured extends JsonValue = JsonValue> = {
  content: JsonValue[]
  structuredContent?: Structured
}

/**
 * DeepSeek function-name contract: at most 64 characters. Wire-protocol
 * constant, not configuration.
 */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** Raw result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/** List without mutating the SDK's per-page output-validator cache. */
function listToolsUncached(client: Client, cursor?: string) {
  return client.request(
    { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
    ListToolsResultSchema,
  )
}

/** Call without the SDK pre-validating an output schema the bridge may not support. */
function callToolUncached(
  client: Client,
  rawName: string,
  args: Record<string, unknown>,
  exec: ToolExecution,
  opts: ToolBridgeOptions,
) {
  return client.request(
    { method: 'tools/call', params: { name: rawName, arguments: args } },
    RawCallToolResultSchema,
    {
      signal: exec.signal,
      timeout: opts.toolCallTimeoutMs,
    },
  )
}

/**
 * Derive the model-facing public name for one MCP tool.
 *
 * Deterministic pure function of `(serverName, rawName)`: the clean case is
 * `mcp__<serverName>__<rawName>` verbatim. When character replacement or
 * truncation to the DeepSeek function-name contract (64 chars,
 * `[A-Za-z0-9_-]`) changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into the
 * same public name.
 *
 * @param serverName - Stable local namespace from plugin config.
 * @param rawName - The MCP server's own tool name.
 * @returns The globally unique, model-facing ToolRuntime name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Sync the MCP server's tool list into the harness ToolRuntime.
 *
 * Two phases keep the swap safe:
 *
 * 1. Fetch: drain uncached `tools/list` pagination and build the full next
 *    generation of `ToolDefinition`s under public names. Any failure here
 *    (network error, duplicate raw name in the server's list) rejects and
 *    leaves the previous generation registered untouched.
 * 2. Swap: dispose the previous generation, register the new one. A registry
 *    conflict here can only mean a foreign registration squats on this
 *    server's `mcp__<serverName>__` namespace — the partial generation is
 *    rolled back (zero tools from this server) and logged. Initial strict
 *    synchronization may propagate the conflict so its parent transaction
 *    rejects; ordinary clients and later re-syncs return an empty map.
 *
 * @param client - Connected MCP Client instance used to list and call tools.
 * @param ctx - Cordis context providing the `tools` service for registration.
 * @param opts - Bridge options: server namespace and per-call timeout.
 * @param previous - Disposer map from the prior sync generation; disposed
 *   during the swap phase (only after the fetch phase succeeded).
 * @returns A map of registered public tool names to their unregister
 *   disposers — the exact set of live registrations owned by this server.
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
): Promise<ToolDisposers> {
  // Phase 1: fetch and build the next generation without touching the registry.
  const definitions = new Map<string, ToolDefinition>()
  let cursor: string | undefined
  do {
    const response = await listToolsUncached(client, cursor)
    for (const tool of response.tools) {
      const publicName = publicToolName(opts.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(
          `mcp-client(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
        )
      }
      definitions.set(publicName, {
        name: publicName,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
        execute: createExecutor(ctx, client, tool.name, tool.execution?.taskSupport === 'required', opts),
      })
    }
    cursor = response.nextCursor
  } while (cursor)

  // Phase 2: swap generations.
  for (const dispose of previous.values()) dispose()
  const disposers: ToolDisposers = new Map()
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, ctx.tools.register(definition))
    }
  } catch (error) {
    // A conflict on an `mcp__<serverName>__`-qualified name means a foreign
    // registration occupies this server's namespace. Roll back so the model
    // sees either the full generation or none of it — never a partial set.
    for (const dispose of disposers.values()) dispose()
    ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
    if (opts.registrationFailure === 'throw') throw error
    return new Map()
  }
  return disposers
}

/**
 * The shape we read from each MCP content block. Intentionally looser than the
 * SDK's `ContentBlock` type: we're at a network trust boundary (data arrives
 * from an external MCP server process via JSON-RPC), so fields that the SDK
 * declares required may be absent at runtime if the server is buggy.
 */
interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
  data?: string
  attachment?: ImageAttachmentRef
}

/**
 * Sanitize content supplied by an external MCP server.
 *
 * Attachment references are local capabilities: accepting an arbitrary
 * server-provided ID would let remote content bypass image validation and
 * admission limits, or probe an attachment already present in this harness.
 * The only trusted attachment blocks are minted later from this call's own
 * successful `saveImage()` results. Invalid text values are removed before
 * the canonical result is published, so an object or number cannot cross the
 * wire boundary as `ContentBlock.text` or enter deferred model context.
 */
function sanitizeServerContent(
  ctx: Context,
  content: JsonValue[],
  serverName: string,
  rawName: string,
): JsonValue[] {
  return content.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const block = value as Record<string, JsonValue>
    if (block.type === 'image' && Object.hasOwn(block, 'attachment')) {
      const sanitized = { ...block }
      delete sanitized.attachment
      ctx.logger.warn(
        `mcp-client(${serverName}): tool "${rawName}" image content block ${index + 1} ignored an untrusted server-supplied attachment reference`,
      )
      return sanitized
    }
    if (block.type === 'text' && Object.hasOwn(block, 'text') && typeof block.text !== 'string') {
      const sanitized = { ...block }
      delete sanitized.text
      ctx.logger.warn(
        `mcp-client(${serverName}): tool "${rawName}" text content block ${index + 1} discarded a non-string text value`,
      )
      return sanitized
    }
    return value
  })
}

/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to JsonValue. */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** Build the canonical result schema and Native content projection. */
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      const result = value as unknown as McpResult
      return projectContent(result.content, rawName)
    },
  }
}

/**
 * Create an execute function for one MCP tool. The executor closes over the
 * raw MCP tool name and sends an uncached `tools/call` request with it (never
 * the public name), with abort signal and timeout, then maps the result to
 * harness ContentBlocks. Owning the raw request prevents the SDK's internal
 * per-page schema cache from pre-validating a different contract.
 *
 * When the MCP server returns `isError: true`, the executor throws so that
 * the ToolRuntime's catch path produces an `isError` result for the model.
 */
function createExecutor(
  ctx: Context,
  client: Client,
  rawName: string,
  taskRequired: boolean,
  opts: ToolBridgeOptions,
): ToolDefinition['execute'] {
  return async (args: unknown, exec: ToolRunContext) => {
    if (taskRequired) {
      throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`)
    }
    // The agent loop passes `JSON.parse(model_arguments)` which is usually an
    // object, but can be any JSON value if the model misbehaves (outputs a bare
    // string/number/null). Fallback to {} lets the MCP server produce a
    // specific "missing required param" error the model can learn from.
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const result = await callToolUncached(client, rawName, argsObj, exec, opts)

    // The SDK may return a legacy `toolResult` shape; normalize to content array.
    if (!Array.isArray(result.content)) {
      const rendered: unknown = 'toolResult' in result
        ? JSON.stringify(result.toolResult)
        : '(no output)'
      const text = typeof rendered === 'string' ? rendered : '(no output)'
      if (result.isError === true) throw new Error(text)
      return {
        content: [{ type: 'text', text }],
        ...result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent as JsonValue }
          : {},
      }
    }

    // Trust boundary: the uncached result schema deliberately leaves content
    // unknown. Sanitize every block before error rendering, admission, or
    // publication as the canonical value.
    const rawContent = sanitizeServerContent(
      ctx,
      result.content as JsonValue[],
      opts.serverName,
      rawName,
    )
    const text = extractText(rawContent, rawName)

    // MCP isError → throw so ToolRuntime produces an isError result for the model.
    if (result.isError === true) {
      throw new Error(text)
    }

    // Image blocks enter model context through the durable attachment seam:
    // each image is committed before the tool/result event is appended, so the
    // image block references a stored object. Unsupported or inadmissible
    // blocks retain their raw shape and render as text placeholders; storage
    // failures reject the tool call instead of reporting a successful result.
    const content = await convertImageBlocks(ctx, exec, rawContent, opts.serverName, rawName)

    if (exec.parent !== undefined && content.some(isAttachedImageBlock)) {
      exec.deferContext(createUserMessage({
        content: projectContent(content, rawName),
        source: { kind: 'plugin', plugin: 'mcp-client' },
      }))
    }

    return {
      content,
      ...result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent as JsonValue }
        : {},
    }
  }
}

/** MIME types the version-one attachment path accepts, keyed by MCP image mimeType. */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/** Whether an MCP content block is a raw image carrying base64 bytes. */
function isRawImageBlock(value: JsonValue): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const block = value as unknown as McpContentBlock
  return block.type === 'image' && typeof block.data === 'string'
}

/** Whether a content block is an image already projected onto the attachment seam. */
function isAttachedImageBlock(value: JsonValue): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const block = value as unknown as McpContentBlock
  return block.type === 'image' && block.attachment !== undefined
}

/**
 * Whether the calling route declares image input. Unknown or unresolvable
 * routes answer no: attaching an image to a route that cannot carry it would
 * strand the next request, while the text placeholder costs nothing.
 * @param ctx - plugin context providing the optional `llm` service.
 * @param exec - tool execution carrying the calling agent's route.
 * @param serverName - configured MCP server namespace used in diagnostics.
 * @param rawName - MCP tool name used in diagnostics.
 * @returns true only when the exact resolved route declares `image` input.
 */
async function routeAcceptsImages(
  ctx: Context,
  exec: ToolRunContext,
  serverName: string,
  rawName: string,
): Promise<boolean> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return false
  try {
    const active = await llm.resolveModelInfo(provider, model, exec.signal)
    return active.inputModalities?.includes('image') === true
  } catch (error: unknown) {
    ctx.logger.warn(
      `mcp-client(${serverName}): cannot resolve the active model for tool "${rawName}" image output; rendering image placeholders: ${String(error)}`,
    )
    return false
  }
}

/** Attachment validation failures that safely degrade one untrusted MCP image block. */
const IMAGE_VALIDATION_FAILURE_CODES = new Set([
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
])

/** Read a stable attachment validation code without importing the optional runtime peer. */
function imageValidationFailure(error: unknown): { code: string; message: string } | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') {
    return undefined
  }
  if (!IMAGE_VALIDATION_FAILURE_CODES.has(error.code)) return undefined
  return {
    code: error.code,
    message: error.message,
  }
}

/** Log one safe image-to-placeholder degradation without including image bytes. */
function warnImagePlaceholder(
  ctx: Context,
  serverName: string,
  rawName: string,
  contentIndex: number,
  reason: string,
): void {
  ctx.logger.warn(
    `mcp-client(${serverName}): tool "${rawName}" image content block ${contentIndex + 1} rendered as a placeholder: ${reason}`,
  )
}

/**
 * Convert raw MCP image blocks into durable attachment references.
 *
 * A block the deployment cannot carry (no attachment store, no image-capable
 * route, unsupported media type, invalid bytes, or a configured limit) keeps
 * its raw shape and renders as a text placeholder. Validation failures are
 * logged; storage failures reject the call because no durable reference was
 * committed.
 * @param ctx - plugin context providing the optional `attachments`/`llm` services.
 * @param exec - tool execution carrying the calling agent's route.
 * @param content - MCP content after untrusted server attachment claims were stripped.
 * @param serverName - configured MCP server namespace used in diagnostics.
 * @param rawName - MCP tool name used in diagnostics.
 * @returns the content array with every storable image replaced by its attachment block.
 */
async function convertImageBlocks(
  ctx: Context,
  exec: ToolRunContext,
  content: JsonValue[],
  serverName: string,
  rawName: string,
): Promise<JsonValue[]> {
  if (!content.some(isRawImageBlock)) return content
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return content
  if (!(await routeAcceptsImages(ctx, exec, serverName, rawName))) return content
  const converted = [...content]
  let messageBytes = 0
  let imageCount = 0
  for (let index = 0; index < converted.length; index += 1) {
    const value = converted[index] as JsonValue
    if (!isRawImageBlock(value)) continue
    const block = value as unknown as McpContentBlock
    const mediaType = IMAGE_MEDIA_TYPES[block.mimeType ?? '']
    if (mediaType === undefined || !attachments.imageLimits.mediaTypes.includes(mediaType)) {
      warnImagePlaceholder(ctx, serverName, rawName, index, `${block.mimeType ?? 'unknown'} is not accepted by this deployment`)
      continue
    }
    if (imageCount >= attachments.imageLimits.maxImagesPerMessage) {
      warnImagePlaceholder(
        ctx,
        serverName,
        rawName,
        index,
        `the message already contains the configured maximum of ${attachments.imageLimits.maxImagesPerMessage} attached images`,
      )
      continue
    }
    const encoded = block.data as string
    const decodedBytes = Buffer.byteLength(encoded, 'base64')
    if (decodedBytes > attachments.imageLimits.maxImageBytes) {
      warnImagePlaceholder(
        ctx,
        serverName,
        rawName,
        index,
        `the image exceeds the configured ${attachments.imageLimits.maxImageBytes}-byte per-image limit`,
      )
      continue
    }
    const remainingMessageBytes = attachments.imageLimits.maxMessageImageBytes - messageBytes
    if (decodedBytes > remainingMessageBytes) {
      warnImagePlaceholder(
        ctx,
        serverName,
        rawName,
        index,
        `the attached images would exceed the configured ${attachments.imageLimits.maxMessageImageBytes}-byte per-message limit`,
      )
      continue
    }
    const data = Uint8Array.from(Buffer.from(encoded, 'base64'))
    let ref: ImageAttachmentRef
    try {
      ref = await attachments.saveImage({ data, mediaType })
    } catch (error: unknown) {
      const failure = imageValidationFailure(error)
      if (failure === undefined) throw error
      warnImagePlaceholder(
        ctx,
        serverName,
        rawName,
        index,
        `attachment validation failed (${failure.code}): ${failure.message}`,
      )
      continue
    }
    imageCount += 1
    messageBytes += decodedBytes
    converted[index] = {
      type: 'image',
      attachment: { ...ref },
    }
  }
  return converted
}

/**
 * Project one MCP content array into model-facing blocks. When no image was
 * attached, the whole array collapses into one text block — the pre-attachment
 * projection, placeholders included. With at least one attached image, text
 * and image blocks stay separate so the model reads the image beside its text.
 * @param mcpContent - the (possibly attachment-converted) MCP content array.
 * @param toolName - raw tool name for the no-content fallback text.
 * @returns model-facing content blocks.
 */
function projectContent(mcpContent: JsonValue[], toolName: string): ContentBlock[] {
  if (!mcpContent.some(isAttachedImageBlock)) {
    return [{ type: 'text', text: extractText(mcpContent, toolName) }]
  }
  const blocks: ContentBlock[] = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      blocks.push({ type: 'text', text: '[unsupported content type: unknown]' })
      continue
    }
    const block = value as unknown as McpContentBlock
    switch (block.type) {
      case 'text':
        blocks.push(typeof block.text === 'string'
          ? { type: 'text', text: block.text }
          : { type: 'text', text: '[text: invalid content discarded]' })
        break
      case 'image':
        if (block.attachment !== undefined) {
          blocks.push({ type: 'image', attachment: block.attachment })
        } else {
          blocks.push({ type: 'text', text: `[image: ${block.mimeType ?? 'unknown'}, content discarded]` })
        }
        break
      case 'audio':
        blocks.push({ type: 'text', text: `[audio: ${block.mimeType ?? 'unknown'}, content discarded]` })
        break
      case 'resource':
      case 'resource_link':
        blocks.push({ type: 'text', text: '[resource: content discarded]' })
        break
      default:
        blocks.push({ type: 'text', text: `[unsupported content type: ${block.type}]` })
    }
  }
  return blocks
}

/**
 * Extract text from an MCP content array into a single string.
 * - text blocks: join with '\n'
 * - image/audio/resource blocks: replaced with a placeholder
 *
 * Defensive: fields that the MCP spec declares required (mimeType, text) are
 * guarded with fallbacks because this is a network trust boundary.
 */
function extractText(mcpContent: JsonValue[], toolName: string): string {
  const parts: string[] = []

  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value as unknown as McpContentBlock
    switch (block.type) {
      case 'text':
        parts.push(typeof block.text === 'string'
          ? block.text
          : '[text: invalid content discarded]')
        break
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${block.type}]`)
    }
  }

  return parts.join('\n') || `(${toolName} returned no text content)`
}
