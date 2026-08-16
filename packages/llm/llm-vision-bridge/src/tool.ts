/**
 * The model-facing `describe_image` tool: reads a PNG/JPEG/WebP/GIF file,
 * durably commits its bytes through the attachment service, and returns the
 * vision bridge's text description — the companion of `read_image` for
 * agents whose selected model cannot consume images directly.
 * @module @deepseek-ai/dsh-llm-vision-bridge/tool
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type { VisionBridge } from './index.ts'

/** Extensions `describe_image` accepts; magic-byte validation at the attachment service stays authoritative. */
function mediaTypeForPath(filePath: string): ImageMediaType | undefined {
  switch (extname(filePath).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}

/** The canonical outcome declared by the `describe_image` output schema. */
interface ImageDescriptionValue {
  path: string
  description: string
}

/**
 * Build the `describe_image` tool definition bound to one bridge instance.
 * @param ctx - context read per execution for the optional `fs` and
 *   `attachments` services.
 * @param bridge - the configured vision bridge answering the description.
 * @param timeoutMs - cooperative tool-call budget forwarded from config.
 * @returns the registered tool definition.
 */
export function describeImageTool(ctx: Context, bridge: VisionBridge, timeoutMs: number): ToolDefinition {
  return defineTool({
    name: 'describe_image',
    description: 'Describe a PNG/JPEG/WebP/GIF image file through the configured vision model and return the text description. Use it to understand images when the current model cannot read them directly, e.g. to read text or errors in a screenshot.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
      question: { type: 'string', description: 'Optional specific question about the image, e.g. "transcribe every error message". Omit for a full description.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.description }]
      },
    },
    timeoutMs,
    // Provider reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ImageDescriptionValue> {
      const imagePath = args.file_path
      if (imagePath.trim().length === 0) {
        throw new Error('describe_image: file_path must be a non-empty string')
      }
      const fs = ctx.get('fs')
      const attachments = ctx.get('attachments')
      if (fs === undefined || attachments === undefined) {
        throw new Error('describe_image: filesystem or attachment service is unavailable')
      }
      const mediaType = mediaTypeForPath(imagePath)
      if (mediaType === undefined) {
        throw new Error(`describe_image: unsupported image extension in "${imagePath}" (use png/jpg/jpeg/webp/gif)`)
      }
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`describe_image: ${mediaType} images are not accepted by this deployment`)
      }
      const cwd = exec.agent?.session.header.cwd
      const target = await fs.resolve(imagePath, {
        ...cwd === undefined ? {} : { cwd },
        signal: exec.signal,
      })
      const info = await fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`describe_image: image file not found: ${target.displayPath}`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`describe_image: not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE')
      }
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await fs.readBytes(target, exec.signal, byteCap)
      const ref = await attachments.saveImage({
        data,
        mediaType,
        name: basename(target.displayPath),
      }).catch((error: unknown) => {
        if (!(error instanceof AttachmentError) || error.code !== 'IMAGE_TYPE_MISMATCH') throw error
        throw new Error(
          `describe_image: the ${extname(target.displayPath).toLowerCase()} extension declares ${mediaType}, but the bytes use a different image format`,
          { cause: error },
        )
      })
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      const description = await bridge.describeImage(ref, {
        ...typeof args.question === 'string' ? { question: args.question } : {},
        signal: exec.signal,
      })
      return { path: target.displayPath, description }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Describe image ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  })
}
