/**
 * Translate DeepSeek SSE payloads with one stateful harness block per content, reasoning, or tool
 * call index. An empty initial reasoning delta does not open a block. Finish reason and the latest
 * usage are deferred until `[DONE]`, covering both finish-attached and trailing usage-only shapes
 * while ensuring no chunk follows `finish`.
 *
 * Translate DeepSeek wire chunks into the harness `StreamChunk` protocol.
 * @module dsh-llm-deepseek/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk, WireUsage } from './types.ts'

/** One open text or reasoning block under assembly. */
interface OpenTextBlock {
  index: number
  kind: 'text' | 'reasoning'
  text: string
}

/** One open tool-call block whose durable identity was established by its first wire delta. */
interface OpenToolCallBlock {
  index: number
  kind: 'tool-call'
  text: string
  callId: CallId
  name: string
}

type OpenBlock = OpenTextBlock | OpenToolCallBlock

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields. DeepSeek's `prompt_tokens` INCLUDES cache hits
 * (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`,
 * api/create-chat-completion); the harness TokenUsage convention is
 * DISJOINT counts, so cache reads are subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: block.callId,
      name: block.name,
      arguments: block.text,
    }
  }
}

/** Classify a provider tool-call identity violation without echoing model-supplied values. */
function malformedToolCall(index: number | undefined, detail: string): LlmError {
  const location = index === undefined ? '' : ` at index ${index}`
  return new LlmError(`malformed tool call${location}: ${detail}`, 'MALFORMED_RESPONSE')
}

/** Accept only the protocol's non-negative integer tool-call index. */
function validToolCallIndex(index: unknown): number {
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw malformedToolCall(undefined, 'index must be a non-negative safe integer')
  }
  return index
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads or unstable/empty tool-call identities abort the stream with
 * `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
 *   `EMPTY_RESPONSE` error finish instead of a successful empty message.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenTextBlock | undefined
  let reasoningBlock: OpenTextBlock | undefined
  const toolBlocks = new Map<number, OpenToolCallBlock>()
  const toolCallIds = new Map<string, number>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenTextBlock['kind']): OpenTextBlock {
    const block: OpenTextBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: thinking mode interleaves it before text. The
      // empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        const wireIndex = validToolCallIndex(call.index)
        let block = toolBlocks.get(wireIndex)
        if (!block) {
          const callId = call.id
          const name = call.function?.name
          if (typeof callId !== 'string' || callId.trim().length === 0
            || typeof name !== 'string' || name.trim().length === 0) {
            throw malformedToolCall(wireIndex, 'first delta requires non-blank id and function.name')
          }
          const existingIndex = toolCallIds.get(callId)
          if (existingIndex !== undefined && existingIndex !== wireIndex) {
            throw malformedToolCall(wireIndex, 'id duplicates another tool call')
          }
          block = {
            index: nextIndex++,
            kind: 'tool-call',
            text: '',
            callId: CallId(callId),
            name,
          }
          order.push(block)
          toolBlocks.set(wireIndex, block)
          toolCallIds.set(callId, wireIndex)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        } else {
          // Some compatible gateways repeat empty identity placeholders on continuation
          // deltas. Treat those like omitted fields, but reject a non-empty identity change.
          if (call.id !== undefined && call.id !== ''
            && (typeof call.id !== 'string' || call.id !== block.callId)) {
            throw malformedToolCall(wireIndex, 'non-empty id changed after the first delta')
          }
          if (call.function?.name !== undefined && call.function.name !== ''
            && (typeof call.function.name !== 'string' || call.function.name !== block.name)) {
            throw malformedToolCall(wireIndex, 'non-empty function.name changed after the first delta')
          }
        }
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId,
          name: block.name,
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
