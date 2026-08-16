// Keyless assembled transcript for the image-to-text admission path. The real
// Web composition, API proxy, durable attachment store, agent loop, and
// DeepSeek adapter run unchanged. Only the two external model endpoints are
// deterministic: an in-process vision adapter and a loopback DeepSeek SSE
// server. The golden pins the admitted durable blocks and both model requests.
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory,
  compareOrRefreshGolden,
  launchWebScaffold,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'

const OVERLAY = fileURLToPath(new URL('./vision-admission.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/vision-admission-deepseek-projection', import.meta.url))
const TRANSCRIPT_EXPECTED = fileURLToPath(new URL(
  './snapshots/vision-admission-deepseek-projection/transcript.expected.json',
  import.meta.url,
))
const MODE = webSnapshotMode()
const IMAGE_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const DESCRIPTION = 'A one-pixel red PNG fixture.'

interface CapturedVisionRequest {
  provider: string
  model: string
  messages: Array<{
    role: string
    content: GenerateOptions['messages'][number]['content']
  }>
}

/** Deterministic external vision provider; every harness component after the provider remains real. */
class SnapshotVisionAdapter extends LlmAdapter {
  readonly requests: CapturedVisionRequest[] = []

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider,
      id: 'snapshot-vision-model',
      name: 'Snapshot Vision Model',
      inputModalities: ['text', 'image'],
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Snapshot Vision Model',
      inputModalities: ['text', 'image'],
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({
      provider: options.provider,
      model: options.model,
      messages: options.messages.map(message => ({
        role: message.role,
        content: structuredClone(message.content),
      })),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: DESCRIPTION }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: DESCRIPTION } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface DeepSeekWireMessage {
  role: string
  content?: string
}

interface DeepSeekWireRequest {
  model: string
  messages: DeepSeekWireMessage[]
}

async function rpc<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `vision-snapshot-${method}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
}

describe('web e2e: vision admission reaches the real DeepSeek text request', () => {
  let scaffold: WebScaffold
  let provider: Server
  let vision: SnapshotVisionAdapter
  let settledSessionId: SessionId | undefined
  const deepSeekRequests: DeepSeekWireRequest[] = []
  const sessionEvents: SessionEvent[] = []
  const originalEnvironment = {
    baseURL: process.env.DSH_VISION_SNAPSHOT_DEEPSEEK_BASE_URL,
    apiKey: process.env.DSH_VISION_SNAPSHOT_DEEPSEEK_API_KEY,
    defaultApiKey: process.env.DEEPSEEK_API_KEY,
  }

  beforeAll(async () => {
    provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        deepSeekRequests.push(JSON.parse(body) as DeepSeekWireRequest)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
          'data: {"choices":[{"delta":{"content":"DONE"}}]}',
          'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
      })
    })
    await new Promise<void>(resolveListen => provider.listen(0, '127.0.0.1', resolveListen))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('DeepSeek snapshot server has no IP port')
    process.env.DSH_VISION_SNAPSHOT_DEEPSEEK_BASE_URL = `http://127.0.0.1:${String(address.port)}`
    process.env.DSH_VISION_SNAPSHOT_DEEPSEEK_API_KEY = 'keyless-vision-snapshot'
    // Record mode checks that a key source exists before loading any overlay.
    // This scenario still routes only to the loopback endpoint above.
    process.env.DEEPSEEK_API_KEY ??= 'keyless-vision-snapshot-record-check'

    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      ...MODE === 'record' ? {} : { deepSeekMissingCredential: true },
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    vision = new SnapshotVisionAdapter()
    scaffold.ctx.llm.registerAdapter(['snapshot-vision'], vision)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await closeServer(provider).catch((error: unknown) => failures.push(error))
    if (originalEnvironment.baseURL === undefined) delete process.env.DSH_VISION_SNAPSHOT_DEEPSEEK_BASE_URL
    else process.env.DSH_VISION_SNAPSHOT_DEEPSEEK_BASE_URL = originalEnvironment.baseURL
    if (originalEnvironment.apiKey === undefined) delete process.env.DSH_VISION_SNAPSHOT_DEEPSEEK_API_KEY
    else process.env.DSH_VISION_SNAPSHOT_DEEPSEEK_API_KEY = originalEnvironment.apiKey
    if (originalEnvironment.defaultApiKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = originalEnvironment.defaultApiKey
    if (failures.length > 0) throw new AggregateError(failures, 'vision admission snapshot cleanup failed')
  })

  it('admits a pure image and settles one main-model turn', async () => {
    const created = await rpc<{ sessionId: SessionId }>(scaffold.baseUrl, 'session.create', {})
    const settled = scaffold.whenTurnSettled()
    await rpc<{ accepted: true }>(scaffold.baseUrl, 'session.prompt', {
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{
        type: 'image',
        mediaType: 'image/png',
        data: IMAGE_DATA,
        name: 'red.png',
      }],
    })
    settledSessionId = await settled
    expect(settledSessionId).toBe(created.sessionId)
  }, 60_000)

  it('matches the durable admission and both assembled model requests', async () => {
    if (settledSessionId === undefined) throw new Error('the image turn did not settle')
    expect(vision.requests).toHaveLength(1)
    expect(deepSeekRequests).toHaveLength(1)

    const durable = sessionEvents.find(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    if (durable?.type !== 'user/message') throw new Error('image admission produced no durable user message')
    const deepSeek = deepSeekRequests[0]!
    const projected = deepSeek.messages.find(message =>
      message.role === 'user' && message.content?.includes('[image omitted: DeepSeek cannot inspect this image]'))
    if (projected?.content === undefined) throw new Error('DeepSeek wire request contains no projected image message')

    const transcript = JSON.stringify({
      durableUserContent: durable.data.content,
      visionRequest: vision.requests[0],
      deepSeekRequest: {
        model: deepSeek.model,
        projectedUserContent: projected.content,
      },
    }, null, 2)
    await compareOrRefreshGolden(TRANSCRIPT_EXPECTED, transcript, MODE)

    expect(durable.data.content.map(block => block.type)).toEqual(['image', 'text'])
    const [image, description] = durable.data.content
    if (image?.type !== 'image' || description?.type !== 'text') {
      throw new Error('durable image and description are not adjacent')
    }
    expect((description as typeof description & { imageDescriptionOf?: unknown }).imageDescriptionOf)
      .toBe(image.attachment.attachmentId)
    expect(description.text).toBe(`[image-description]\n${DESCRIPTION}`)
    expect(projected.content).toBe(
      `[image omitted: DeepSeek cannot inspect this image][image-description]\n${DESCRIPTION}`,
    )
    expect(JSON.stringify(deepSeek)).not.toContain('"type":"image"')
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['transcript.expected.json'])
  })
})
