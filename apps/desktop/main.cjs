const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const {
  classifyNavigation,
  createProcessTreeStopper,
  harnessArguments,
} = require('./runtime.cjs')

const STARTUP_TIMEOUT_MS = 45_000
const STARTUP_LOG_TAIL_CHARS = 64 * 1024

const APP_ICON = path.join(__dirname, 'assets', 'icon.png')

function applyDockIcon() {
  if (process.platform === 'darwin' && app.dock !== undefined) {
    app.dock.setIcon(APP_ICON)
  }
}

let harnessProcess
let harnessStopper
let mainWindow
let desktopStartPromise
let stopping = false
let quitAfterStop = false
let quitPromise
let runtimeFailureReported = false

app.setName('DeepSeek Harness')
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
  process.exit(0)
}

function repositoryRoot() {
  const configuredRoot = process.env.DSH_REPO_ROOT
  if (configuredRoot) return path.resolve(configuredRoot)
  return path.resolve(__dirname, '../..')
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function waitForHarnessUrl(child) {
  return new Promise((resolve, reject) => {
    let startupLogTail = ''
    let startupSettled = false
    let backendReady = false
    const timer = setTimeout(() => {
      finishStartup(startupError(`DeepSeek Harness did not start within ${STARTUP_TIMEOUT_MS / 1000}s.`))
    }, STARTUP_TIMEOUT_MS)

    const startupError = (message) => {
      const detail = startupLogTail.trim().split('\n').slice(-12).join('\n')
      return new Error(detail === '' ? message : `${message}\n${detail}`)
    }

    const stopAccumulatingOutput = () => {
      child.stdout.off('data', readStartupOutput)
      child.stderr.off('data', readStartupOutput)
      child.stdout.resume()
      child.stderr.resume()
      startupLogTail = ''
    }

    const finishStartup = (error, url) => {
      if (startupSettled) return
      startupSettled = true
      backendReady = error === undefined
      clearTimeout(timer)
      stopAccumulatingOutput()
      if (error !== undefined) reject(error)
      else resolve(url)
    }

    const readStartupOutput = (chunk) => {
      const candidate = startupLogTail + chunk.toString()
      const match = candidate.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      startupLogTail = candidate.slice(-STARTUP_LOG_TAIL_CHARS)
      if (match) finishStartup(undefined, match[1])
    }

    child.stdout.on('data', readStartupOutput)
    child.stderr.on('data', readStartupOutput)
    child.on('error', (error) => {
      if (backendReady) {
        reportHarnessRuntimeFailure(`DeepSeek Harness 后端在启动后发生进程错误：${error instanceof Error ? error.message : String(error)}`)
      } else if (!startupSettled) {
        finishStartup(startupError(`DeepSeek Harness failed before startup: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    child.on('exit', (code, signal) => {
      if (backendReady) {
        reportHarnessRuntimeFailure(`DeepSeek Harness 后端在启动后意外退出（code=${String(code)}, signal=${String(signal)}）。`)
      } else if (!startupSettled) {
        finishStartup(startupError(`DeepSeek Harness exited before startup (code=${String(code)}, signal=${String(signal)}).`))
      }
    })
  })
}

async function stopHarness() {
  stopping = true
  await harnessStopper?.stop()
}

function openExternalUrl(target) {
  void Promise.resolve(shell.openExternal(target)).catch((error) => {
    dialog.showErrorBox('DeepSeek Harness 无法打开链接', error instanceof Error ? error.message : String(error))
  })
}

function loadInternalUrl(target) {
  if (mainWindow === undefined) return
  void mainWindow.loadURL(target).catch((error) => {
    dialog.showErrorBox('DeepSeek Harness 无法打开页面', error instanceof Error ? error.message : String(error))
  })
}

function reportHarnessRuntimeFailure(message) {
  if (stopping || runtimeFailureReported) return
  runtimeFailureReported = true
  dialog.showErrorBox('DeepSeek Harness 后端已停止', message)
  beginOrderlyQuit()
}

function beginOrderlyQuit() {
  quitPromise ??= stopHarness()
    .then(() => {
      quitAfterStop = true
      app.quit()
    })
    .catch((error) => {
      dialog.showErrorBox('DeepSeek Harness 关闭失败', error instanceof Error ? error.message : String(error))
    })
}

function createDesktopWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'DeepSeek Harness',
    backgroundColor: '#171717',
    icon: APP_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const origin = new URL(url).origin
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    const decision = classifyNavigation(target, origin)
    if (decision.kind === 'internal') loadInternalUrl(decision.url)
    if (decision.kind === 'external') openExternalUrl(decision.url)
    return { action: 'deny' }
  })

  const handleNavigation = (event, target) => {
    const decision = classifyNavigation(target, origin)
    if (decision.kind === 'internal') return
    event.preventDefault()
    if (decision.kind === 'external') openExternalUrl(decision.url)
  }
  mainWindow.webContents.on('will-navigate', handleNavigation)
  mainWindow.webContents.on('will-redirect', handleNavigation)

  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
  loadInternalUrl(url)
  // macOS Dock 注册窗口后可能重置图标，窗口出现后再次应用
  applyDockIcon()
  setTimeout(applyDockIcon, 1000).unref()
}

async function startDesktopOnce() {
  app.setAppUserModelId('ai.deepseek.harness')
  const dshHome = path.join(app.getPath('userData'), 'dsh')
  fs.mkdirSync(dshHome, { recursive: true })

  harnessProcess = spawn(pnpmCommand(), harnessArguments(process.env.DSH_DESKTOP_PATCHES), {
    cwd: repositoryRoot(),
    env: {
      ...process.env,
      DSH_HOME: dshHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  harnessStopper = createProcessTreeStopper(harnessProcess)

  const url = await waitForHarnessUrl(harnessProcess)
  if (!stopping) createDesktopWindow(url)
}

function startDesktop() {
  desktopStartPromise ??= startDesktopOnce()
  return desktopStartPromise
}

app.on('second-instance', () => {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  applyDockIcon()
  try {
    await startDesktop()
  } catch (error) {
    if (stopping) return
    dialog.showErrorBox('DeepSeek Harness 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (quitAfterStop) return
  event.preventDefault()
  beginOrderlyQuit()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === undefined && !stopping) {
    void startDesktop().catch((error) => {
      if (stopping) return
      dialog.showErrorBox('DeepSeek Harness 启动失败', error instanceof Error ? error.message : String(error))
    })
  }
})
