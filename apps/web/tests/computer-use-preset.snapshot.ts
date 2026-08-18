import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, type WebScaffold,
} from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/computer-use-preset', import.meta.url))
const CONNECTED_FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const MISSING_FIXTURE = join(SNAPSHOT_DIR, 'missing-session.jsonl')
const SHIPPED_PRESET = fileURLToPath(new URL('../../cli/config/agent-presets/computer-use', import.meta.url))
const MCP_FIXTURE = fileURLToPath(new URL('./fixtures/computer-use-mcp-server.mjs', import.meta.url))
const CONNECTED_PROMPT = 'Call mcp__kimi-cu__greet with name "Snapshot". '
  + 'After the tool result, reply exactly COMPUTER_USE_TOOL_OK and stop.'
const MISSING_PROMPT = 'Reply exactly COMPUTER_USE_UNAVAILABLE_OK and stop.'
const KIMICU_COMMAND = '/Applications/KimiCU.app/Contents/MacOS/kimi-cu'
const KIMICU_ARGS = 'args: [mcp, -s, user]'
const KIMICU_GUIDANCE = 'You can operate macOS applications on-screen through the mcp__kimi-cu__* tools when those tools are present in your catalog. For screen tasks, use them to list apps, inspect app state and accessibility text, click, type text, press keys, scroll, and set values. Treat returned screenshots as visual evidence only when your active model route accepts image input; otherwise do not claim that you inspected the pixels. Do not launch or invoke KimiCU directly through shell; use only the registered mcp__kimi-cu__* tools. If the tools are absent, say computer use is unavailable; do not claim that you can see or control the screen or that Screen Recording or Accessibility permission has been granted.'

interface PresetFixture {
  callLog: string
  root: string
  close(): Promise<void>
}

interface FixtureCall {
  name: string
  arguments: Record<string, unknown>
}

interface AssembledPreset {
  handle: AgentHandle
  preset: PresetFixture
  scaffold: WebScaffold
}

interface PendingApproval {
  answer: PromiseWithResolvers<ApprovalOutcome>
  requested: PromiseWithResolvers<ApprovalRequest>
  requests: ApprovalRequest[]
  dispose(): void
}

async function fixtureCalls(path: string): Promise<FixtureCall[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as FixtureCall)
}

async function presetFixture(kind: 'connected' | 'missing'): Promise<PresetFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-use-preset-'))
  const callLog = join(root, 'mcp-calls.jsonl')
  const preset = join(root, 'computer-use')
  await mkdir(preset)
  const shipped = await readFile(join(SHIPPED_PRESET, 'agent.cordis.yml'), 'utf8')
  const command = kind === 'connected' ? process.execPath : join(root, 'missing-kimicu')
  const args = kind === 'connected'
    ? `args: [${JSON.stringify(MCP_FIXTURE)}]\n    env:\n      DSH_COMPUTER_USE_MCP_CALL_LOG: ${JSON.stringify(callLog)}`
    : KIMICU_ARGS
  const composition = shipped
    .replace(`command: ${KIMICU_COMMAND}`, `command: ${JSON.stringify(command)}`)
    .replace(KIMICU_ARGS, args)
  if (composition === shipped || !composition.includes(`command: ${JSON.stringify(command)}`)) {
    throw new Error('computer-use snapshot could not patch the reviewed KimiCU command seam')
  }
  await Promise.all([
    writeFile(join(preset, 'agent.cordis.yml'), composition),
    readFile(join(SHIPPED_PRESET, 'preset.yml')).then(content => writeFile(join(preset, 'preset.yml'), content)),
  ])
  return {
    callLog,
    root,
    close: () => rm(root, { recursive: true, force: true }),
  }
}

async function assemblePreset(
  kind: 'connected' | 'missing',
  replayFixture: string,
  label: string,
): Promise<AssembledPreset> {
  const preset = await presetFixture(kind)
  let scaffold: WebScaffold | undefined
  try {
    const activeScaffold = await launchWebScaffold({
      replayFixture,
      agentPresets: {
        roots: [{ path: preset.root, trust: 'system' }],
        default: 'computer-use',
      },
    })
    scaffold = activeScaffold
    const handle = await activeScaffold.ctx.agents.create({
      sessionId: SessionId(`computer-use-preset-${label}`),
      meta: { cwd: activeScaffold.workspaceCwd, agentPreset: 'computer-use' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => activeScaffold.ctx.agentPresets.mount(agentCtx, 'computer-use').then(() => undefined),
    })
    return { handle, preset, scaffold }
  } catch (error) {
    await scaffold?.close().catch(() => {})
    await preset.close().catch(() => {})
    throw error
  }
}

function startTurn(subject: AssembledPreset, prompt: string): void {
  subject.handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }))
}

function holdApproval(subject: AssembledPreset): PendingApproval {
  const answer = Promise.withResolvers<ApprovalOutcome>()
  const requested = Promise.withResolvers<ApprovalRequest>()
  const requests: ApprovalRequest[] = []
  const dispose = subject.scaffold.ctx.on('approval/request', (request) => {
    requests.push(request)
    requested.resolve(request)
    return answer.promise
  }, { prepend: true })
  return { answer, requested, requests, dispose }
}

function toolResult(subject: AssembledPreset, name: string): string {
  const call = subject.handle.agent.session.events.find(event => event.type === 'tool/call'
    && event.data.name === name)
  if (call === undefined || call.type !== 'tool/call') throw new Error(`no ${name} tool call was logged`)
  const result = subject.handle.agent.session.events.find(event => event.type === 'tool/result'
    && event.data.message.source.callId === call.data.callId)
  if (result === undefined || result.type !== 'tool/result') throw new Error(`no ${name} tool result was logged`)
  return JSON.stringify(result.data.message.content[0])
}

async function closeAssembled(subject: AssembledPreset): Promise<void> {
  const failures: unknown[] = []
  await subject.handle.dispose().catch((error: unknown) => failures.push(error))
  await subject.scaffold.close().catch((error: unknown) => failures.push(error))
  await subject.preset.close().catch((error: unknown) => failures.push(error))
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'computer-use preset teardown failed')
}

describe('computer-use agent preset', () => {
  it('holds the real MCP call pending, then dispatches it exactly once after approval', async () => {
    const subject = await assemblePreset('connected', CONNECTED_FIXTURE, 'allowed')
    const approval = holdApproval(subject)
    try {
      expect(fixtureUserPrompts(await readFile(CONNECTED_FIXTURE, 'utf8'))).toEqual([CONNECTED_PROMPT])
      startTurn(subject, CONNECTED_PROMPT)
      const requestToApprove = await approval.requested.promise
      expect(requestToApprove.toolName).toBe('mcp__kimi-cu__greet')
      expect(approval.requests).toHaveLength(1)
      expect(await fixtureCalls(subject.preset.callLog)).toEqual([])

      const request = subject.handle.agent.session.requestHeader()
      if (request === undefined) throw new Error('the computer-use agent issued no model request')
      const names = request.tools?.map(tool => tool.name) ?? []
      const computerTools = names.filter(name => name.startsWith('mcp__kimi-cu__')).toSorted()
      expect(computerTools).toEqual(['mcp__kimi-cu__greet'])
      expect(names).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'web_search']))
      expect(request.system).toContain(KIMICU_GUIDANCE)
      expect(request.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
        .toEqual(subject.scaffold.ctx.tools.schemas(subject.handle.agent).toSorted(
          (left, right) => left.name.localeCompare(right.name),
        ))

      approval.answer.resolve('allowed-once')
      await subject.handle.agent.whenIdle()
      expect(await fixtureCalls(subject.preset.callLog)).toEqual([
        { name: 'greet', arguments: { name: 'Snapshot' } },
      ])
      expect(toolResult(subject, 'mcp__kimi-cu__greet')).toContain('Hello, Snapshot!')
      expect(subject.handle.agent.session.events.some(event => event.type === 'approval/decided'
        && event.data.outcome === 'allowed-once')).toBe(true)
    } finally {
      approval.answer.resolve('rejected')
      approval.dispose()
      await closeAssembled(subject)
    }
  }, 120_000)

  it('returns a rejection to the model without dispatching to the MCP server', async () => {
    const subject = await assemblePreset('connected', CONNECTED_FIXTURE, 'rejected')
    const approval = holdApproval(subject)
    try {
      startTurn(subject, CONNECTED_PROMPT)
      await approval.requested.promise
      expect(await fixtureCalls(subject.preset.callLog)).toEqual([])
      approval.answer.resolve('rejected')
      await subject.handle.agent.whenIdle()
      expect(await fixtureCalls(subject.preset.callLog)).toEqual([])
      expect(toolResult(subject, 'mcp__kimi-cu__greet')).toContain('the user rejected tool')
      expect(subject.handle.agent.session.events.some(event => event.type === 'approval/decided'
        && event.data.outcome === 'rejected')).toBe(true)
    } finally {
      approval.answer.resolve('rejected')
      approval.dispose()
      await closeAssembled(subject)
    }
  }, 120_000)

  it('keeps Standard mode usable and carries the no-tools guidance when KimiCU is absent', async () => {
    const subject = await assemblePreset('missing', MISSING_FIXTURE, 'missing')
    try {
      expect(fixtureUserPrompts(await readFile(MISSING_FIXTURE, 'utf8'))).toEqual([MISSING_PROMPT])
      startTurn(subject, MISSING_PROMPT)
      await subject.handle.agent.whenIdle()
      const request = subject.handle.agent.session.requestHeader()
      if (request === undefined) throw new Error('the degraded computer-use agent issued no model request')
      const names = request.tools?.map(tool => tool.name) ?? []
      expect(names.some(name => name.startsWith('mcp__kimi-cu__'))).toBe(false)
      expect(names).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'web_search']))
      expect(request.system).toContain(KIMICU_GUIDANCE)
      expect(subject.handle.agent.session.header.agentPreset).toBe('computer-use')
      await assertFixtureInventory(SNAPSHOT_DIR, ['missing-session.jsonl', 'session.jsonl'])
    } finally {
      await closeAssembled(subject)
    }
  }, 120_000)
})
