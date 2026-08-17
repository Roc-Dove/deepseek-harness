/**
 * REAL-composition coverage for the vision bridge plugin: the `visionBridge`
 * service resolves through the Loader, describes images through its
 * configured route, fails loud on misconfiguration, and registers the
 * `describe_image` tool against the real tools/fs/attachment seams.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import { CallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as visionBridgePlugin from '@deepseek-ai/dsh-llm-vision-bridge'
import { describeImageTool } from '../src/tool.ts'

let root: string | undefined
let context: Context | undefined

class VisionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly describedText: string

  constructor(describedText: string) {
    super()
    this.describedText = describedText
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider: 'vision-route', id: 'vision-model', name: 'Vision Model' }])
  }

  override resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider: 'vision-route',
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: this.describedText }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class TextOnlyAdapter extends LlmAdapter {
  override resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider: 'text-route', id: model, name: model, inputModalities: ['text'] })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Route-capability tests never enter provider streaming.
  }
}

async function raster(format: 'png' | 'webp' | 'gif' = 'png'): Promise<Uint8Array> {
  const image = sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
  return new Uint8Array(await image.toFormat(format).toBuffer())
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface LoadedComposition {
  ctx: Context
  adapter: VisionAdapter
}

function toolExec(callId = 'call-1', cwd?: string): ToolRunContext {
  return {
    callId: CallId(callId),
    name: 'describe_image',
    arguments: {},
    signal: undefined,
    ...cwd === undefined ? {} : { agent: { session: { header: { cwd } } } },
  } as unknown as ToolRunContext
}

function ref() {
  return {
    attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
    mediaType: 'image/png' as const,
    bytes: 1,
    width: 1,
    height: 1,
  }
}

class ScriptedVisionAdapter extends LlmAdapter {
  constructor(
    private readonly chunks: readonly StreamChunk[],
    private readonly modalities: NonNullable<LlmResolvedModelInfo['inputModalities']> | null = ['text', 'image'],
  ) {
    super()
  }

  override resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider: 'direct-route', id: model, name: model,
      ...this.modalities === null ? {} : { inputModalities: this.modalities },
    })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    yield* this.chunks
  }
}

async function directBridge(
  chunks: readonly StreamChunk[],
  modalities: NonNullable<LlmResolvedModelInfo['inputModalities']> | null = ['text', 'image'],
): Promise<visionBridgePlugin.VisionBridge> {
  context = new Context()
  await context.plugin(LlmRuntime)
  context.llm.registerAdapter(['direct-route'], new ScriptedVisionAdapter(chunks, modalities))
  return new visionBridgePlugin.VisionBridge(context, { provider: 'direct-route', model: 'direct-model' })
}

async function loadComposition(visionConfig: { provider: string; model: string }): Promise<LoadedComposition> {
  root = await mkdtemp(join(tmpdir(), 'dsh-vision-bridge-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    '  config:',
    "    persona: ''",
    "- name: '@deepseek-ai/dsh-tools'",
    '- name: \'@deepseek-ai/dsh-fs-local\'',
    '  config:',
    `    cwd: '${root}'`,
    '- name: \'@deepseek-ai/dsh-attachment-local\'',
    '  config:',
    `    dshHome: '${root}'`,
    '- name: \'@deepseek-ai/dsh-llm-vision-bridge\'',
    '  config:',
    `    provider: '${visionConfig.provider}'`,
    `    model: '${visionConfig.model}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRegistry],
    ['@deepseek-ai/dsh-fs-local', FsLocal],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-llm-vision-bridge', visionBridgePlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const unloaded = [...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])

  const adapter = new VisionAdapter('Loader composed description')
  context.llm.registerAdapter(['vision-route'], adapter)
  context.llm.registerAdapter(['text-route'], new TextOnlyAdapter())
  return { ctx: context, adapter }
}

describe('vision bridge composition', () => {
  it('describes a saved image through the configured route and registers the tool', async () => {
    const { ctx, adapter } = await loadComposition({ provider: 'vision-route', model: 'vision-model' })
    const bridge = ctx.get('visionBridge')
    if (bridge === undefined) throw new Error('test composition failed to mount the visionBridge service')
    const attachments = ctx.attachments
    const ref = await attachments.saveImage({ data: await raster(), mediaType: 'image/png' })

    await expect(bridge.describeImage(ref)).resolves.toBe('Loader composed description')
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]
    expect(request?.provider).toBe('vision-route')
    expect(request?.model).toBe('vision-model')
    const content = request?.messages[0]?.content ?? []
    expect(content.some(block => block.type === 'text' && block.text.includes('Describe the image in detail'))).toBe(true)
    const imageBlock = content.find(block => block.type === 'image')
    expect(imageBlock).toMatchObject({
      type: 'image',
      attachment: { attachmentId: ref.attachmentId, mediaType: ref.mediaType },
    })

    const tool = ctx.tools.get('describe_image')
    expect(tool?.name).toBe('describe_image')
    expect(tool?.timeoutMs).toBe(60_000)

    // The real tool path resolves a workspace file, saves it durably, and returns text.
    const imagePath = join(root!, 'shot.png')
    await writeFile(imagePath, await raster())
    const observed: string[] = []
    ctx.on('fs/observed', target => void observed.push(target.displayPath))
    await expect(tool?.execute({ file_path: 'shot.png', question: '' }, toolExec()))
      .resolves.toEqual({ path: imagePath, description: 'Loader composed description' })
    expect(observed).toEqual([imagePath])
    expect(tool?.presentCall?.({ file_path: 'shot.png' })).toEqual({
      card: 'generic',
      title: 'Describe image shot.png',
      kind: 'read',
      locations: [{ path: 'shot.png' }],
    })
    expect(adapter.requests).toHaveLength(2)
    const second = adapter.requests[1]
    expect(second?.messages[0]?.content.some(block => block.type === 'text' && block.text.includes('User question')))
      .toBe(false)
    expect(tool?.output.render({}, { path: imagePath, description: 'visible' })).toEqual([
      { type: 'text', text: 'visible' },
    ])
    expect(tool?.isConcurrencySafe?.({ file_path: 'shot.png' })).toBe(true)
  })

  it('rejects invalid paths, non-files, and extension/content mismatches before description', async () => {
    const { ctx, adapter } = await loadComposition({ provider: 'vision-route', model: 'vision-model' })
    const tool = ctx.tools.get('describe_image')
    if (tool === undefined) throw new Error('test composition failed to register describe_image')

    await expect(tool.execute({ file_path: '   ' }, toolExec('empty'))).rejects.toThrow(/non-empty/)
    await expect(tool.execute({ file_path: 'notes.txt' }, toolExec('extension'))).rejects.toThrow(/unsupported image extension/)
    await expect(tool.execute({ file_path: 'missing.png' }, toolExec('missing'))).rejects.toThrow(/not found/)

    await mkdir(join(root!, 'folder.png'))
    await expect(tool.execute({ file_path: 'folder.png' }, toolExec('directory'))).rejects.toThrow(/not a regular file/)

    await writeFile(join(root!, 'wrong.jpg'), await raster())
    await expect(tool.execute({ file_path: 'wrong.jpg' }, toolExec('mismatch'))).rejects.toThrow(/extension declares image\/jpeg/)
    expect(adapter.requests).toHaveLength(0)
  })

  it('accepts WebP and GIF files, resolves an explicit session cwd, and omits absent questions', async () => {
    const { ctx, adapter } = await loadComposition({ provider: 'vision-route', model: 'vision-model' })
    const tool = ctx.tools.get('describe_image')
    if (tool === undefined) throw new Error('test composition failed to register describe_image')

    for (const format of ['webp', 'gif'] as const) {
      const path = join(root!, `image.${format}`)
      await writeFile(path, await raster(format))
      await expect(tool.execute({ file_path: `image.${format}` }, toolExec(format, root)))
        .resolves.toEqual({ path, description: 'Loader composed description' })
    }
    expect(adapter.requests).toHaveLength(2)
  })

  it('rethrows attachment failures other than a declared/content type mismatch', async () => {
    const { ctx, adapter } = await loadComposition({ provider: 'vision-route', model: 'vision-model' })
    const tool = ctx.tools.get('describe_image')
    if (tool === undefined) throw new Error('test composition failed to register describe_image')
    await writeFile(join(root!, 'large.png'), await raster())
    vi.spyOn(ctx.attachments, 'saveImage').mockRejectedValueOnce(
      new AttachmentError('too large', 'IMAGE_TOO_LARGE'),
    )

    await expect(tool.execute({ file_path: 'large.png' }, toolExec('attachment-failure')))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    expect(adapter.requests).toHaveLength(0)
  })

  it('honors deployment media-type policy before filesystem I/O', async () => {
    const { ctx, adapter } = await loadComposition({ provider: 'vision-route', model: 'vision-model' })
    const tool = ctx.tools.get('describe_image')
    if (tool === undefined) throw new Error('test composition failed to register describe_image')
    Object.defineProperty(ctx.attachments, 'imageLimits', {
      value: Object.freeze({
        ...ctx.attachments.imageLimits,
        mediaTypes: Object.freeze(['image/jpeg'] as const),
      }),
    })

    await expect(tool.execute({ file_path: 'denied.png' }, toolExec('media-policy')))
      .rejects.toThrow(/image\/png images are not accepted/)
    expect(adapter.requests).toHaveLength(0)
  })

  it('fails loud when the configured provider is not registered', async () => {
    const { ctx } = await loadComposition({ provider: 'missing-route', model: 'vision-model' })
    const bridge = ctx.get('visionBridge')
    if (bridge === undefined) throw new Error('test composition failed to mount the visionBridge service')
    const ref = await ctx.attachments.saveImage({ data: await raster(), mediaType: 'image/png' })
    await expect(bridge.describeImage(ref)).rejects.toThrow(/provider "missing-route" is not registered/)
  })

  it('fails loud when the configured model does not declare image input', async () => {
    const { ctx } = await loadComposition({ provider: 'text-route', model: 'text-model' })
    const bridge = ctx.get('visionBridge')
    if (bridge === undefined) throw new Error('test composition failed to mount the visionBridge service')
    const ref = await ctx.attachments.saveImage({ data: await raster(), mediaType: 'image/png' })
    await expect(bridge.describeImage(ref)).rejects.toThrow(/does not declare image input/)
  })

  it('fails loud when model modalities are unknown', async () => {
    const bridge = await directBridge([], null)
    await expect(bridge.describeImage(ref())).rejects.toThrow(/does not declare image input/)
  })

  it.each([
    ['provider error', [{ type: 'finish', reason: { kind: 'error', failure: { message: 'denied', code: 'SERVER' } } }] as StreamChunk[], /model call failed: denied/],
    ['provider abort', [{ type: 'finish', reason: { kind: 'aborted' } }] as StreamChunk[], /model call aborted/],
    ['empty output', [{ type: 'finish', reason: { kind: 'stop' } }] as StreamChunk[], /empty description/],
  ])('surfaces %s from direct bridge calls', async (_case, chunks, expected) => {
    const bridge = await directBridge(chunks)
    await expect(bridge.describeImage(ref(), {
      question: 'What is shown?',
      signal: new AbortController().signal,
    })).rejects.toThrow(expected)
  })

  it('applies direct description defaults without schema materialization', async () => {
    context = new Context()
    await context.plugin(LlmRuntime).await()
    await context.plugin(SystemPrompt, { persona: '' }).await()
    await context.plugin(ToolRegistry).await()
    context.llm.registerAdapter(['direct-route'], new ScriptedVisionAdapter([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'text-delta', index: 0, text: ' direct answer ' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    visionBridgePlugin.apply(context, { provider: 'direct-route', model: 'direct-model' })

    await expect(context.visionBridge.describeImage(ref(), {
      question: 'What is shown?', signal: new AbortController().signal,
    })).resolves.toBe('direct answer')
  })

  it('fails before filesystem work when describe_image services are absent', async () => {
    const bare = new Context()
    const tool = describeImageTool(bare, {} as visionBridgePlugin.VisionBridge, 1000)
    await expect(tool.execute({ file_path: 'image.png' }, toolExec('missing-services')))
      .rejects.toThrow(/service is unavailable/)
    await bare.fiber.dispose()
  })
})
