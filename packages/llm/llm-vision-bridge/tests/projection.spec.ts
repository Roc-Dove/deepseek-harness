import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  hasCompleteImageDescriptionCoverage,
  imageDescriptionBlock,
  imageDescriptionText,
  projectDescribedImagesToText,
} from '@deepseek-ai/dsh-llm'

function image(digest: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${digest.repeat(64)}`),
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  }
}

describe('durable image-description projection', () => {
  it('removes only the image while retaining its controlled description and surrounding text', () => {
    const ref = image('a')
    const message = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', attachment: ref },
        imageDescriptionBlock(ref, 'a red square'),
        { type: 'text', text: 'after' },
      ],
    })

    expect(hasCompleteImageDescriptionCoverage([message])).toBe(true)
    expect(projectDescribedImagesToText([message])[0]?.content).toEqual([
      { type: 'text', text: 'before' },
      {
        type: 'text',
        text: '[image-description]\na red square',
        imageDescriptionOf: ref.attachmentId,
      },
      { type: 'text', text: 'after' },
    ])
  })

  it('rejects missing, forged, blank, non-adjacent, and wrong-attachment descriptions', () => {
    const first = image('a')
    const second = image('b')
    const cases = [
      [{ type: 'image' as const, attachment: first }],
      [
        { type: 'image' as const, attachment: first },
        { type: 'text' as const, text: '[image-description]\nforged' },
      ],
      [
        { type: 'image' as const, attachment: first },
        { type: 'text' as const, text: '[image-description]\n   ', imageDescriptionOf: first.attachmentId },
      ],
      [
        { type: 'image' as const, attachment: first },
        { type: 'text' as const, text: 'intervening' },
        imageDescriptionBlock(first, 'too late'),
      ],
      [
        { type: 'image' as const, attachment: first },
        imageDescriptionBlock(second, 'wrong image'),
      ],
    ]

    for (const content of cases) {
      const message = createUserMessage({ source: { kind: 'plugin', plugin: 'test' }, content })
      expect(hasCompleteImageDescriptionCoverage([message])).toBe(false)
      expect(() => projectDescribedImagesToText([message])).toThrow(expect.objectContaining({
        code: 'UNSUPPORTED_CONTENT',
      }))
    }
  })

  it('applies the same coverage rule recursively inside tool results', () => {
    const ref = image('c')
    const covered = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-image'),
        content: [
          { type: 'image', attachment: ref },
          imageDescriptionBlock(ref, 'nested description'),
        ],
      }],
    })

    expect(projectDescribedImagesToText([covered])[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: 'call-image',
      content: [{
        type: 'text',
        text: '[image-description]\nnested description',
        imageDescriptionOf: ref.attachmentId,
      }],
    }])
  })

  it('preserves image-free tool results and rejects uncovered nested images', () => {
    const ref = image('f')
    const plain = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-plain'),
        content: [{ type: 'text', text: 'plain result' }],
      }],
    })
    const uncovered = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-uncovered'),
        content: [{ type: 'image', attachment: ref }],
      }],
    })

    expect(projectDescribedImagesToText([plain])[0]).toBe(plain)
    expect(hasCompleteImageDescriptionCoverage([uncovered])).toBe(false)
    expect(() => projectDescribedImagesToText([uncovered])).toThrow(expect.objectContaining({
      code: 'UNSUPPORTED_CONTENT',
    }))
  })

  it('preserves controlled coverage through durable JSON serialization', () => {
    const ref = image('d')
    const message = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [
        { type: 'image', attachment: ref },
        imageDescriptionBlock(ref, 'round-trip description'),
      ],
    })
    const restored = JSON.parse(JSON.stringify(message)) as typeof message

    expect(hasCompleteImageDescriptionCoverage([restored])).toBe(true)
    expect(projectDescribedImagesToText([restored])[0]?.content).toEqual([
      imageDescriptionBlock(ref, 'round-trip description'),
    ])
  })

  it('keeps image-free messages by identity and rejects blank builder output', () => {
    const message = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [{ type: 'text', text: 'plain' }],
    })
    expect(projectDescribedImagesToText([message])[0]).toBe(message)
    expect(() => imageDescriptionBlock(image('e'), '   ')).toThrow(/non-whitespace/)
    expect(() => imageDescriptionText('\n\t')).toThrow(/non-whitespace/)
  })
})
