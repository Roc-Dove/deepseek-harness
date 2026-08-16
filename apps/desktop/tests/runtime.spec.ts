import { describe, expect, it, vi } from 'vitest'
import runtimeModule from '../runtime.cjs'

const runtime = runtimeModule

describe('desktop navigation policy', () => {
  const origin = 'http://127.0.0.1:51904'

  it('keeps safe same-origin pages internal and sends safe HTTP(S) origins external', () => {
    expect(runtime.classifyNavigation(`${origin}/settings?tab=models`, origin)).toEqual({
      kind: 'internal',
      url: `${origin}/settings?tab=models`,
    })
    expect(runtime.classifyNavigation('https://example.com/docs?q=desktop', origin)).toEqual({
      kind: 'external',
      url: 'https://example.com/docs?q=desktop',
    })
    expect(runtime.classifyNavigation('http://example.com/', origin)).toEqual({
      kind: 'external',
      url: 'http://example.com/',
    })
  })

  it.each([
    'file:///tmp/private.txt',
    'javascript:alert(1)',
    'dsh://settings',
    'https://user:secret@example.com/',
    'http://user@127.0.0.1:51904/private',
    'not a url',
  ])('blocks unsafe or malformed renderer target %s', (target) => {
    expect(runtime.classifyNavigation(target, origin)).toEqual({ kind: 'blocked' })
  })
})

describe('desktop patch arguments', () => {
  it('preserves JSON-array order as repeatable web --patch options', () => {
    expect(runtime.harnessArguments('["./vision.yml","/tmp/local settings.yml"]')).toEqual([
      'dsh',
      'web',
      '--patch',
      './vision.yml',
      '--patch',
      '/tmp/local settings.yml',
      '--port',
      '0',
    ])
    expect(runtime.harnessArguments(undefined)).toEqual(['dsh', 'web', '--port', '0'])
  })

  it.each([
    '{"patch":"./vision.yml"}',
    '["./vision.yml",""]',
    '["./vision.yml",42]',
    '["bad\\u0000path"]',
    'not-json',
  ])('rejects invalid DSH_DESKTOP_PATCHES value %s', (raw) => {
    expect(() => runtime.harnessArguments(raw)).toThrow(/DSH_DESKTOP_PATCHES/)
  })
})

describe('desktop backend process tree', () => {
  const child = () => ({ pid: 421, exitCode: null, signalCode: null })

  it('terminates a POSIX process group, escalates surviving descendants, and coalesces callers', async () => {
    const signals: Array<[number, 'SIGTERM' | 'SIGKILL']> = []
    const sleep = vi.fn(() => Promise.resolve())
    const liveness = [true, true, true, true, true, false]
    const stopper = runtime.createProcessTreeStopper(child(), {
      platform: 'darwin',
      graceMs: 2,
      forceWaitMs: 2,
      pollMs: 1,
      sleep,
      treeAlive: () => liveness.shift() ?? false,
      signalPosixTree: (pid, signal) => { signals.push([pid, signal]) },
    })

    const first = stopper.stop()
    const second = stopper.stop()
    expect(second).toBe(first)
    await first

    expect(signals).toEqual([[421, 'SIGTERM'], [421, 'SIGKILL']])
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('returns after graceful POSIX group exit without force-killing', async () => {
    const signals: Array<'SIGTERM' | 'SIGKILL'> = []
    const liveness = [true, false]
    const stopper = runtime.createProcessTreeStopper(child(), {
      platform: 'linux',
      graceMs: 10,
      pollMs: 1,
      sleep: () => Promise.resolve(),
      treeAlive: () => liveness.shift() ?? false,
      signalPosixTree: (_pid, signal) => { signals.push(signal) },
    })

    await stopper.stop()

    expect(signals).toEqual(['SIGTERM'])
  })

  it('uses taskkill once for a Windows tree and waits for root exit', async () => {
    const taskkill = vi.fn()
    const liveness = [true, false]
    const stopper = runtime.createProcessTreeStopper(child(), {
      platform: 'win32',
      forceWaitMs: 10,
      pollMs: 1,
      sleep: () => Promise.resolve(),
      treeAlive: () => liveness.shift() ?? false,
      taskkill,
    })

    await Promise.all([stopper.stop(), stopper.stop()])

    expect(taskkill).toHaveBeenCalledOnce()
    expect(taskkill).toHaveBeenCalledWith(421)
  })

  it('is a no-op when the tree already exited or spawn produced no pid', async () => {
    const signal = vi.fn()
    await runtime.createProcessTreeStopper(
      { pid: 421, exitCode: 0, signalCode: null },
      { platform: 'linux', treeAlive: () => false, signalPosixTree: signal },
    ).stop()
    await runtime.createProcessTreeStopper(
      { exitCode: null, signalCode: null },
      { platform: 'win32', treeAlive: () => true, taskkill: signal },
    ).stop()

    expect(signal).not.toHaveBeenCalled()
  })

  it('fails explicitly if a POSIX tree survives SIGKILL', async () => {
    const signals: string[] = []
    const stopper = runtime.createProcessTreeStopper(child(), {
      platform: 'linux',
      graceMs: 0,
      forceWaitMs: 0,
      pollMs: 1,
      treeAlive: () => true,
      signalPosixTree: (_pid, signal) => { signals.push(signal) },
    })

    await expect(stopper.stop()).rejects.toThrow(/remained alive after SIGKILL/)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
