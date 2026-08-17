/**
 * Image-to-text bridge: converts attached images into model-visible text
 * descriptions through a configured vision-capable model route, so an agent
 * whose selected model is text-only still consumes images in the same task.
 *
 * Composition: a deployment enables the plugin row with an explicit
 * `provider`/`model` route that declares `image` input. Consumers read the
 * optional `visionBridge` service and call {@link VisionBridge.describeImage};
 * the plugin also registers the model-facing `describe_image` tool for
 * on-demand image questions over workspace files.
 * @module @deepseek-ai/dsh-llm-vision-bridge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { VisionBridgeService, VisionDescribeOptions } from '@deepseek-ai/dsh-llm'
import { describeImageTool } from './tool.ts'

export {
  hasCompleteImageDescriptionCoverage,
  imageDescriptionBlock,
  imageDescriptionText,
  projectDescribedImagesToText,
} from '@deepseek-ai/dsh-llm'
export type {
  ImageDescriptionTextBlock,
  VisionBridgeService,
  VisionDescribeOptions,
} from '@deepseek-ai/dsh-llm'

/** Stable instruction the vision model receives for every description; configurable, never inferred. */
export const DEFAULT_DESCRIBE_PROMPT =
  'Describe the image in detail and accurately: the main subject, any text content (transcribe it verbatim), and key details. Answer in Chinese.'

/** Per-description output cap; the model-facing description replaces the image, so it stays a summary. */
export const DEFAULT_MAX_TOKENS = 2048

/** Cooperative per-description budget: the `describe_image` tool-call limit and the admission wait bound. */
export const DEFAULT_DESCRIBE_TIMEOUT_MS = 60_000

/** Deployment configuration; `provider`/`model` are required so enabling the row without a route fails loud. */
export interface Config {
  /** Provider of the vision-capable route answering description requests. */
  provider: string
  /** Model of the vision-capable route; the bridge fails loud when it does not declare image input. */
  model: string
  /** Stable instruction every description call receives; defaults to {@link DEFAULT_DESCRIBE_PROMPT}. */
  describePrompt?: string
  /** Per-description output cap; defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number
  /** Cooperative per-description budget; defaults to {@link DEFAULT_DESCRIBE_TIMEOUT_MS}. */
  describeTimeoutMs?: number
}

/** Cordis plugin name. */
export const name = 'llm-vision-bridge'
/** The LLM service is the bridge's only hard dependency; tools/fs/attachments are read per call. */
export const inject = ['llm']

/** Loader schema; required route, configurable prompt, output, and per-description budget. */
export const Config: z<Config> = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  describePrompt: z.string().default(DEFAULT_DESCRIBE_PROMPT),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  describeTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DESCRIBE_TIMEOUT_MS),
})

/** Config with every optional default materialized, owned by one bridge instance. */
interface ResolvedConfig {
  provider: string
  model: string
  describePrompt: string
  maxTokens: number
  describeTimeoutMs: number
}

/**
 * The `visionBridge` service: one configured vision route answering
 * image-description requests as plain text.
 */
export class VisionBridge extends Service implements VisionBridgeService {
  /** Per-description wait bound admission consumers use to fence a hung provider. */
  readonly describeTimeoutMs: number
  private readonly resolved: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx, 'visionBridge')
    this.resolved = {
      provider: config.provider,
      model: config.model,
      describePrompt: config.describePrompt ?? DEFAULT_DESCRIBE_PROMPT,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      describeTimeoutMs: config.describeTimeoutMs ?? DEFAULT_DESCRIBE_TIMEOUT_MS,
    }
    this.describeTimeoutMs = this.resolved.describeTimeoutMs
  }

  /**
   * Describe one durably stored image through the configured vision route.
   * Fails loud when the route is not registered or does not declare image
   * input; a provider error surfaces as the thrown reason.
   * @param ref - durable image reference resolved by the vision adapter.
   * @param options - optional question and cancellation.
   * @returns the model-visible description text.
   */
  async describeImage(ref: ImageAttachmentRef, options: VisionDescribeOptions = {}): Promise<string> {
    const llm = this.ctx.llm
    if (!llm.listProviders().some(provider => provider.id === this.resolved.provider)) {
      throw new Error(
        `vision bridge: provider "${this.resolved.provider}" is not registered; configure the vision route before enabling the bridge`,
      )
    }
    const info = await llm.resolveModelInfo(this.resolved.provider, this.resolved.model, options.signal)
    if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
      throw new Error(
        `vision bridge: model "${this.resolved.model}" does not declare image input; select an image-capable vision model`,
      )
    }
    const question = options.question?.trim()
    const prompt = question === undefined || question.length === 0
      ? this.resolved.describePrompt
      : `${this.resolved.describePrompt}\n\nUser question: ${question}`
    const stream = llm.stream({
      provider: this.resolved.provider,
      model: this.resolved.model,
      messages: [createUserMessage({
        content: [
          { type: 'text', text: prompt },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'plugin', plugin: name },
      })],
      maxTokens: this.resolved.maxTokens,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
      } else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error') {
          throw new Error(`vision bridge: model call failed: ${chunk.reason.failure.message}`)
        }
        if (chunk.reason.kind === 'aborted') {
          throw new Error('vision bridge: model call aborted')
        }
      }
    }
    const description = text.trim()
    if (description.length === 0) {
      throw new Error('vision bridge: model returned an empty description')
    }
    return description
  }
}

/**
 * Register the vision bridge service and the `describe_image` tool.
 * The service provides immediately; the tool waits on the optional `tools`
 * seam through `ctx.inject` (a sibling row's service is not readable at apply
 * time), and each execution re-checks `fs` and `attachments`.
 * @param ctx - plugin scope exposing the LLM service.
 * @param config - validated route, prompt, output, and per-description budget.
 */
export function apply(ctx: Context, config: Config): void {
  const bridge = new VisionBridge(ctx, config)
  const timeoutMs = config.describeTimeoutMs ?? DEFAULT_DESCRIBE_TIMEOUT_MS
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register(describeImageTool(toolsCtx, bridge, timeoutMs))
  })
}
