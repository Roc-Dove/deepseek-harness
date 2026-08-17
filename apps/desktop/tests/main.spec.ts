import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

interface NavigationEvent {
  preventDefault: () => void
}

interface WindowOpenResult {
  action: 'allow' | 'deny'
}

type NavigationKind = 'will-navigate' | 'will-redirect'

interface FakeWebContents {
  on: (event: NavigationKind, listener: (event: NavigationEvent, target: string) => void) => void
  setWindowOpenHandler: (listener: (details: { url: string }) => WindowOpenResult) => void
}

interface RuntimeModule {
  backendLaunch: (options: {
    packaged: boolean
    repositoryRoot: string
    resourcesPath: string
    execPath: string
    dshHome: string
    workspaceRoot: string
    inheritedEnvironment: NodeJS.ProcessEnv
    rawPatches?: string
    platform?: NodeJS.Platform
  }) => {
    command: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    ipc: boolean
    backendEntry?: string
  }
  classifyNavigation: (
    target: string,
    internalOrigin: string,
  ) => { kind: 'internal' | 'external'; url: string } | { kind: 'blocked' }
  desktopReadyUrl: (message: unknown) => string | undefined
  harnessArguments: (rawPatches?: string) => string[]
}

function deferred(): Deferred {
  let resolvePromise!: () => void
  const promise = new Promise<void>((accept) => {
    resolvePromise = accept
  })
  return { promise, resolve: resolvePromise }
}

async function flushTasks(): Promise<void> {
  await new Promise<void>(resolveTask => setImmediate(resolveTask))
}

class FakeApp extends EventEmitter {
  readonly dock = { setIcon: vi.fn() }
  readonly quit = vi.fn()

  constructor(private readonly ready: Promise<void>, readonly isPackaged: boolean) {
    super()
  }

  getPath(): string { return '/test/user-data' }
  requestSingleInstanceLock(): boolean { return true }
  setAppUserModelId(): void {}
  setName(): void {}
  whenReady(): Promise<void> { return this.ready }
}

class FakeOutput extends EventEmitter {
  readonly resume = vi.fn(() => this)
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeOutput()
  readonly stderr = new FakeOutput()
  readonly pid = 421
  exitCode: number | null = null
  signalCode: string | null = null
}

class FakeWindow extends EventEmitter {
  readonly loadURL = vi.fn(() => Promise.resolve())
  readonly focus = vi.fn()
  readonly restore = vi.fn()
  private windowOpenHandler?: (details: { url: string }) => WindowOpenResult
  private readonly navigationHandlers = new Map<NavigationKind, (event: NavigationEvent, target: string) => void>()
  readonly webContents: FakeWebContents = {
    on: (event, listener) => { this.navigationHandlers.set(event, listener) },
    setWindowOpenHandler: (listener) => { this.windowOpenHandler = listener },
  }

  isMinimized(): boolean { return false }

  open(target: string): WindowOpenResult {
    if (this.windowOpenHandler === undefined) throw new Error('window-open handler was not installed')
    return this.windowOpenHandler({ url: target })
  }

  navigate(target: string, event: NavigationEvent): void {
    this.dispatchNavigation('will-navigate', target, event)
  }

  redirect(target: string, event: NavigationEvent): void {
    this.dispatchNavigation('will-redirect', target, event)
  }

  private dispatchNavigation(kind: NavigationKind, target: string, event: NavigationEvent): void {
    const handler = this.navigationHandlers.get(kind)
    if (handler === undefined) throw new Error(`${kind} handler was not installed`)
    handler(event, target)
  }
}

interface LoadedDesktop {
  app: FakeApp
  child: FakeChild
  openExternal: ReturnType<typeof vi.fn>
  ready: Deferred
  showErrorBox: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  windows: FakeWindow[]
}

const MAIN_PATH = resolve(import.meta.dirname, '../main.cjs')
const nodeRequire = createRequire(import.meta.url)
const runtime = nodeRequire('../runtime.cjs') as RuntimeModule

function loadDesktopMain(options: { packaged?: boolean; backendExists?: boolean } = {}): LoadedDesktop {
  const ready = deferred()
  const app = new FakeApp(ready.promise, options.packaged ?? false)
  const child = new FakeChild()
  const windows: FakeWindow[] = []
  const spawn = vi.fn(() => child)
  const stop = vi.fn(() => Promise.resolve())
  const openExternal = vi.fn(() => Promise.resolve())
  const showErrorBox = vi.fn()

  const BrowserWindow = class extends FakeWindow {
    constructor() {
      super()
      windows.push(this)
    }
  }
  const fakeRequire = (id: string): unknown => {
    if (id === 'electron') {
      return {
        app,
        BrowserWindow,
        dialog: { showErrorBox },
        shell: { openExternal },
      }
    }
    if (id === 'node:child_process') return { spawn }
    if (id === 'node:fs') {
      return {
        existsSync: vi.fn(() => options.backendExists ?? true),
        mkdirSync: vi.fn(),
      }
    }
    if (id === './runtime.cjs') {
      return {
        ...runtime,
        createProcessTreeStopper: () => ({ stop }),
      }
    }
    return nodeRequire(id)
  }
  const fakeProcess = {
    env: {
      ...process.env,
      DSH_DESKTOP_PATCHES: '["./vision.yml","./desktop.yml"]',
      ...(options.packaged
        ? {
          DSH_REPO_ROOT: '/injected/repository',
          NODE_OPTIONS: '--require=/tmp/injected.cjs',
          NODE_PATH: '/tmp/injected-modules',
        }
        : {}),
    },
    execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    exit: vi.fn(),
    platform: 'darwin',
    resourcesPath: '/Applications/DeepSeek Harness.app/Contents/Resources',
  }

  vm.runInNewContext(readFileSync(MAIN_PATH, 'utf8'), {
    URL,
    __dirname: dirname(MAIN_PATH),
    clearTimeout: vi.fn(),
    process: fakeProcess,
    require: fakeRequire,
    setTimeout: () => ({ unref() { return this } }),
  }, { filename: MAIN_PATH })

  return { app, child, openExternal, ready, showErrorBox, spawn, stop, windows }
}

describe('desktop main integration', () => {
  it('starts one detached source backend with ordered patches and coalesces activation', async () => {
    const desktop = loadDesktopMain()

    desktop.ready.resolve()
    await flushTasks()
    desktop.app.emit('activate')
    desktop.app.emit('activate')

    expect(desktop.spawn).toHaveBeenCalledOnce()
    expect(desktop.spawn).toHaveBeenCalledWith('pnpm', [
      'dsh',
      'web',
      '--patch',
      './vision.yml',
      '--patch',
      './desktop.yml',
      '--port',
      '0',
    ], expect.objectContaining({ cwd: resolve(dirname(MAIN_PATH), '../..'), detached: true }))
    expect(desktop.child.stdout.listenerCount('data')).toBe(1)
    expect(desktop.child.stderr.listenerCount('data')).toBe(1)

    desktop.child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:51904'))
    await flushTasks()
    expect(desktop.windows).toHaveLength(1)
    expect(desktop.child.stdout.listenerCount('data')).toBe(0)
    expect(desktop.child.stderr.listenerCount('data')).toBe(0)
    expect(desktop.child.stdout.resume).toHaveBeenCalledOnce()
    expect(desktop.child.stderr.resume).toHaveBeenCalledOnce()
  })

  it('starts a packaged backend from application resources without host Node or checkout injection', async () => {
    const desktop = loadDesktopMain({ packaged: true })

    desktop.ready.resolve()
    await flushTasks()

    expect(desktop.spawn).toHaveBeenCalledOnce()
    expect(desktop.spawn).toHaveBeenCalledWith(
      '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      [
        '/Applications/DeepSeek Harness.app/Contents/Resources/backend/lib/bin.js',
        'web',
        '--port',
        '0',
      ],
      expect.objectContaining({
        cwd: '/test/user-data/workspace',
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    )
    const spawnOptions = desktop.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }
    expect(spawnOptions.env).toMatchObject({
      DSH_DESKTOP_DEPLOYMENT: 'packaged',
      DSH_HOME: '/test/user-data/dsh',
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(spawnOptions.env).not.toHaveProperty('DSH_DESKTOP_PATCHES')
    expect(spawnOptions.env).not.toHaveProperty('DSH_REPO_ROOT')
    expect(spawnOptions.env).not.toHaveProperty('NODE_OPTIONS')
    expect(spawnOptions.env).not.toHaveProperty('NODE_PATH')

    desktop.child.emit('message', { type: 'dsh:desktop-ready', url: 'http://example.com:51904' })
    await flushTasks()
    expect(desktop.windows).toHaveLength(0)
    desktop.child.emit('message', { type: 'dsh:desktop-ready', url: 'http://127.0.0.1:51904' })
    await flushTasks()
    expect(desktop.windows).toHaveLength(1)
    expect(desktop.child.listenerCount('message')).toBe(0)
  })

  it('fails before spawn when the packaged backend entry is absent', async () => {
    const desktop = loadDesktopMain({ packaged: true, backendExists: false })

    desktop.ready.resolve()
    await flushTasks()

    expect(desktop.spawn).not.toHaveBeenCalled()
    expect(desktop.showErrorBox).toHaveBeenCalledWith(
      'DeepSeek Harness 启动失败',
      expect.stringContaining('Packaged DeepSeek Harness backend is missing'),
    )
    expect(desktop.app.quit).toHaveBeenCalledOnce()
  })

  it('retains only a bounded startup-log tail before reporting startup exit', async () => {
    const desktop = loadDesktopMain()
    desktop.ready.resolve()
    await flushTasks()

    desktop.child.stdout.emit('data', Buffer.from(`discarded-head\n${'x'.repeat(100_000)}\nkept-tail`))
    desktop.child.exitCode = 17
    desktop.child.emit('exit', 17, null)
    await flushTasks()

    expect(desktop.showErrorBox).toHaveBeenCalledOnce()
    const message = String(desktop.showErrorBox.mock.calls[0]?.[1])
    expect(message).not.toContain('discarded-head')
    expect(message).toContain('kept-tail')
    expect(message.length).toBeLessThan(66_000)
    expect(desktop.child.stdout.listenerCount('data')).toBe(0)
    expect(desktop.child.stderr.listenerCount('data')).toBe(0)
    expect(desktop.child.stdout.resume).toHaveBeenCalledOnce()
    expect(desktop.child.stderr.resume).toHaveBeenCalledOnce()
  })

  it('opens only safe external HTTP(S) links and keeps same-origin navigation internal', async () => {
    const desktop = loadDesktopMain()
    desktop.ready.resolve()
    await flushTasks()
    desktop.child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:51904'))
    await flushTasks()
    const window = desktop.windows[0]

    expect(window.open('http://127.0.0.1:51904/settings')).toEqual({ action: 'deny' })
    expect(window.loadURL).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:51904/settings')
    expect(desktop.windows).toHaveLength(1)
    expect(window.open('https://example.com/docs')).toEqual({ action: 'deny' })
    expect(window.open('file:///tmp/private.txt')).toEqual({ action: 'deny' })
    expect(window.open('https://user:secret@example.com/')).toEqual({ action: 'deny' })
    expect(window.open('malformed')).toEqual({ action: 'deny' })

    const internalEvent = { preventDefault: vi.fn() }
    window.navigate('http://127.0.0.1:51904/chat', internalEvent)
    expect(internalEvent.preventDefault).not.toHaveBeenCalled()

    const externalEvent = { preventDefault: vi.fn() }
    window.navigate('http://example.com/', externalEvent)
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce()
    await flushTasks()
    expect(desktop.openExternal).toHaveBeenCalledTimes(2)
    expect(desktop.openExternal).toHaveBeenNthCalledWith(1, 'https://example.com/docs')
    expect(desktop.openExternal).toHaveBeenNthCalledWith(2, 'http://example.com/')
  })

  it('applies the same allowlist to redirects without opening blocked targets', async () => {
    const desktop = loadDesktopMain()
    desktop.ready.resolve()
    await flushTasks()
    desktop.child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:51904'))
    await flushTasks()
    const window = desktop.windows[0]

    const internalEvent = { preventDefault: vi.fn() }
    window.redirect('http://127.0.0.1:51904/redirected', internalEvent)
    expect(internalEvent.preventDefault).not.toHaveBeenCalled()

    const externalEvent = { preventDefault: vi.fn() }
    window.redirect('https://example.com/redirected', externalEvent)
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce()

    const blockedEvent = { preventDefault: vi.fn() }
    window.redirect('file:///tmp/redirected-secret', blockedEvent)
    expect(blockedEvent.preventDefault).toHaveBeenCalledOnce()
    await flushTasks()
    expect(desktop.openExternal).toHaveBeenCalledOnce()
    expect(desktop.openExternal).toHaveBeenCalledWith('https://example.com/redirected')
  })

  it('reports a backend process error after startup and quits through tree cleanup once', async () => {
    const desktop = loadDesktopMain()
    desktop.ready.resolve()
    await flushTasks()
    desktop.child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:51904'))
    await flushTasks()

    desktop.child.emit('error', new Error('runtime pipe broke'))
    desktop.child.emit('exit', 1, null)
    await flushTasks()

    expect(desktop.showErrorBox).toHaveBeenCalledOnce()
    expect(desktop.showErrorBox).toHaveBeenCalledWith(
      'DeepSeek Harness 后端已停止',
      expect.stringContaining('runtime pipe broke'),
    )
    expect(desktop.stop).toHaveBeenCalledOnce()
    expect(desktop.app.quit).toHaveBeenCalledOnce()
  })

  it('reports an unexpected backend exit after startup and uses orderly quit', async () => {
    const desktop = loadDesktopMain()
    desktop.ready.resolve()
    await flushTasks()
    desktop.child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:51904'))
    await flushTasks()

    desktop.child.exitCode = 23
    desktop.child.emit('exit', 23, null)
    await flushTasks()

    expect(desktop.showErrorBox).toHaveBeenCalledWith(
      'DeepSeek Harness 后端已停止',
      expect.stringContaining('code=23'),
    )
    expect(desktop.stop).toHaveBeenCalledOnce()
    expect(desktop.app.quit).toHaveBeenCalledOnce()
  })

  it('waits for one coalesced tree stop before allowing Electron to quit', async () => {
    const desktop = loadDesktopMain()
    desktop.ready.resolve()
    await flushTasks()
    desktop.child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:51904'))
    await flushTasks()

    const first = { preventDefault: vi.fn() }
    const second = { preventDefault: vi.fn() }
    desktop.app.emit('before-quit', first)
    desktop.app.emit('before-quit', second)
    desktop.child.emit('error', new Error('expected shutdown race'))
    desktop.child.exitCode = 0
    desktop.child.emit('exit', 0, null)
    await flushTasks()

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(desktop.stop).toHaveBeenCalledOnce()
    expect(desktop.app.quit).toHaveBeenCalledOnce()
    expect(desktop.showErrorBox).not.toHaveBeenCalled()

    const final = { preventDefault: vi.fn() }
    desktop.app.emit('before-quit', final)
    expect(final.preventDefault).not.toHaveBeenCalled()
  })
})
