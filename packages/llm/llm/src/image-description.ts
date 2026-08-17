/**
 * Controlled durable image-description markers and safe text-only projection.
 *
 * Descriptions remain ordinary text blocks so every text adapter and
 * compaction path preserves their model-visible content. The extra
 * `imageDescriptionOf` field records which adjacent durable image produced
 * the description and survives the session log's JSON representation.
 * @module @deepseek-ai/dsh-llm/image-description
 */

import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Message } from './message.ts'
import type { ContentBlock, TextBlock, ToolResultBlock } from './types.ts'
import { LlmError } from './error.ts'

const IMAGE_DESCRIPTION_PREFIX = '[image-description]\n'

/** Optional controls accepted by the provider-neutral vision bridge seam. */
export interface VisionDescribeOptions {
  /** Extra question about the image; the implementation keeps its configured base prompt. */
  question?: string
  /** Cancellation forwarded to the vision provider call. */
  signal?: AbortSignal
}

/** Minimal optional service face consumed by image-admission boundaries. */
export interface VisionBridgeService {
  /** Per-description wait bound admission consumers use to fence a hung provider. */
  readonly describeTimeoutMs: number
  /**
   * Describe one durably stored image as model-visible text.
   * @param ref - durable image reference the implementation resolves to bytes.
   * @param options - optional question and cooperative cancellation.
   * @returns nonblank text that an admission boundary can persist beside the image.
   */
  describeImage(ref: ImageAttachmentRef, options?: VisionDescribeOptions): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional provider-neutral image-description service. */
    visionBridge: VisionBridgeService
  }
}

/** A controlled text block tied to the adjacent durable image reference. */
export interface ImageDescriptionTextBlock extends TextBlock {
  /** Attachment whose pixels produced this description. */
  readonly imageDescriptionOf: AttachmentId
}

/**
 * Wrap one image description in the stable model-visible envelope.
 * @param description - nonblank image-description text.
 * @returns the block text persisted beside the image in durable history.
 */
export function imageDescriptionText(description: string): string {
  if (description.trim().length === 0) {
    throw new Error('image description must contain non-whitespace text')
  }
  return `${IMAGE_DESCRIPTION_PREFIX}${description}`
}

/**
 * Build one controlled durable description beside its source image.
 * @param ref - durable image whose pixels produced the description.
 * @param description - nonblank model-visible description text.
 * @returns an ordinary text block carrying the attachment-specific marker.
 */
export function imageDescriptionBlock(
  ref: ImageAttachmentRef,
  description: string,
): ImageDescriptionTextBlock {
  return {
    type: 'text',
    text: imageDescriptionText(description),
    imageDescriptionOf: ref.attachmentId,
  }
}

/** True when one block is a controlled, nonblank description for `ref`. */
function describes(block: ContentBlock | undefined, ref: ImageAttachmentRef): boolean {
  if (block?.type !== 'text') return false
  const candidate = block as TextBlock & { imageDescriptionOf?: unknown }
  return candidate.imageDescriptionOf === ref.attachmentId
    && candidate.text.startsWith(IMAGE_DESCRIPTION_PREFIX)
    && candidate.text.slice(IMAGE_DESCRIPTION_PREFIX.length).trim().length > 0
}

interface ProjectedContent {
  content: ContentBlock[]
  changed: boolean
}

/**
 * Remove images only when the immediately following controlled text block
 * describes that exact attachment. Tool-result content follows the same rule.
 */
function projectContent(blocks: readonly ContentBlock[]): ProjectedContent | undefined {
  const content: ContentBlock[] = []
  let changed = false
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      if (!describes(blocks[index + 1], block.attachment)) return undefined
      changed = true
      continue
    }
    if (block.type === 'tool-result') {
      const nested = projectContent(block.content)
      if (nested === undefined) return undefined
      if (nested.changed) {
        content.push({ ...block, content: nested.content } satisfies ToolResultBlock)
        changed = true
      } else {
        content.push(block)
      }
      continue
    }
    content.push(block)
  }
  return { content: changed ? content : [...blocks], changed }
}

/**
 * Whether every image, including nested tool-result images, has an adjacent
 * controlled durable description for the same attachment.
 * @param messages - current derived or pending model history.
 * @returns true for image-free history and completely described image history.
 */
export function hasCompleteImageDescriptionCoverage(
  messages: readonly { content: readonly ContentBlock[] }[],
): boolean {
  return messages.every(message => projectContent(message.content) !== undefined)
}

/**
 * Project durable image history for a text-only adapter. Images are removed
 * only after coverage validation; their ordinary text descriptions remain in
 * the same order. Any uncovered image fails before provider I/O.
 * @param messages - immutable harness history.
 * @returns history with covered image blocks removed and all other content retained.
 */
export function projectDescribedImagesToText(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    const projected = projectContent(message.content)
    if (projected === undefined) {
      throw new LlmError(
        'text-only image projection requires a durable bridge description for every image',
        'UNSUPPORTED_CONTENT',
      )
    }
    return projected.changed ? { ...message, content: projected.content } : message
  })
}
