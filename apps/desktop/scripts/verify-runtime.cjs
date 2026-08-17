'use strict'

const { spawn } = require('node:child_process')
const { get } = require('node:http')
const { lstat, mkdir, mkdtemp, rm, unlink } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const MAX_LOG_BYTES = 64 * 1024
const VERSION_TIMEOUT_MS = 20_000
const READY_TIMEOUT_MS = 45_000
const HTTP_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 15_000
const FORCE_TIMEOUT_MS = 5_000
const CONTROLLED_ENVIRONMENT_NAMES = [
  'DSH_DESKTOP_DEPLOYMENT',
  'DSH_DESKTOP_PATCHES',
  'DSH_HOME',
  'DSH_REPO_ROOT',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
]

function packagedExecutable(packaged, request) {
  return request.builderPlatform === 'mac'
    ? join(packaged.application, 'Contents', 'MacOS', 'DeepSeek Harness')
    : join(packaged.application, 'DeepSeek Harness.exe')
}

function smokeEnvironment(inheritedEnvironment, dshHome) {
  const environment = { ...inheritedEnvironment }
  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase()
    if (/(?:KEY|SECRET|TOKEN|PASSWORD)/.test(upper)
      || CONTROLLED_ENVIRONMENT_NAMES.includes(upper)) {
      delete environment[name]
    }
  }
  environment.DSH_DESKTOP_DEPLOYMENT = 'packaged'
  environment.DSH_HOME = dshHome
  environment.ELECTRON_RUN_AS_NODE = '1'
  environment.NO_COLOR = '1'
  return environment
}

function readyUrl(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  if (message.type !== 'dsh:desktop-ready' || typeof message.url !== 'string') return undefined
  let parsed
  try {
    parsed = new URL(message.url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
    || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/'
    || parsed.search !== '' || parsed.hash !== '') return undefined
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return parsed.origin
}

function appendLog(log, chunk) {
  const combined = Buffer.concat([log, Buffer.from(chunk)])
  return combined.length <= MAX_LOG_BYTES ? combined : combined.subarray(combined.length - MAX_LOG_BYTES)
}

function formatFailure(label, logs) {
  const output = Buffer.concat([logs.stdout, logs.stderr]).toString('utf8').trim()
  return output === '' ? label : `${label}\n${output}`
}

function childExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`desktop-package: child did not exit within ${timeoutMs} ms.`))
    }, timeoutMs)
    const exit = (code, signal) => {
      cleanup()
      resolvePromise({ code, signal })
    }
    const error = (cause) => {
      cleanup()
      reject(cause)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', exit)
      child.off('error', error)
    }
    child.once('exit', exit)
    child.once('error', error)
  })
}

async function runVersionSmoke(executable, backendEntry, backendVersion, environment, workspace) {
  const child = spawn(executable, [backendEntry, '--version'], {
    cwd: workspace,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  child.stdout.on('data', chunk => { stdout = appendLog(stdout, chunk) })
  child.stderr.on('data', chunk => { stderr = appendLog(stderr, chunk) })
  let result
  try {
    result = await childExit(child, VERSION_TIMEOUT_MS)
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(formatFailure(
      `desktop-package: packaged --version failed with ${result.code === null ? `signal ${result.signal}` : `exit ${result.code}`}.`,
      { stdout, stderr },
    ))
  }
  const versionOutput = stdout.toString('utf8').trim()
  if (versionOutput !== backendVersion) {
    throw new Error(`desktop-package: packaged --version printed ${JSON.stringify(versionOutput)}, expected ${JSON.stringify(backendVersion)}.`)
  }
}

function waitForReady(child, logs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(formatFailure(
        `desktop-package: packaged web backend did not send readiness within ${READY_TIMEOUT_MS} ms.`,
        logs,
      )))
    }, READY_TIMEOUT_MS)
    const message = (payload) => {
      const url = readyUrl(payload)
      if (url === undefined) return
      cleanup()
      resolvePromise(url)
    }
    const exit = (code, signal) => {
      cleanup()
      reject(new Error(formatFailure(
        `desktop-package: packaged web backend exited before readiness (${code === null ? `signal ${signal}` : `exit ${code}`}).`,
        logs,
      )))
    }
    const error = (cause) => {
      cleanup()
      reject(cause)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', message)
      child.off('exit', exit)
      child.off('error', error)
    }
    child.on('message', message)
    child.once('exit', exit)
    child.once('error', error)
  })
}

function requestWebRoot(url) {
  return new Promise((resolvePromise, reject) => {
    const request = get(url, { headers: { Accept: 'text/html' } }, (response) => {
      let bytes = 0
      const chunks = []
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) {
          request.destroy(new Error('desktop-package: packaged Web root exceeded the 2 MiB smoke limit.'))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`desktop-package: packaged Web root returned HTTP ${response.statusCode ?? 'unknown'}.`))
          return
        }
        const body = Buffer.concat(chunks).toString('utf8')
        if (!/<(?:!doctype\s+html|html)\b/i.test(body)) {
          reject(new Error('desktop-package: packaged Web root did not return an HTML document.'))
          return
        }
        resolvePromise()
      })
    })
    request.setTimeout(HTTP_TIMEOUT_MS, () => {
      request.destroy(new Error(`desktop-package: packaged Web root timed out after ${HTTP_TIMEOUT_MS} ms.`))
    })
    request.once('error', reject)
  })
}

function taskkill(pid) {
  return new Promise((resolvePromise) => {
    const child = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', () => resolvePromise())
    child.once('exit', () => resolvePromise())
  })
}

async function terminateProcessTree(child, platform) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  if (child.connected) {
    try {
      child.send({ type: 'dsh:desktop-shutdown' })
      await childExit(child, 2_000)
      return
    } catch {
      // Platform termination below owns cleanup when the control channel is unavailable.
    }
  }
  if (platform === 'win32') {
    await taskkill(child.pid)
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EPERM') child.kill('SIGTERM')
      else if (error !== null && typeof error === 'object' && error.code !== 'ESRCH') throw error
    }
  }
  try {
    await childExit(child, FORCE_TIMEOUT_MS)
    return
  } catch {
    // A surviving POSIX process group is force-killed below.
  }
  if (platform === 'win32') {
    await taskkill(child.pid)
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EPERM') child.kill('SIGKILL')
      else if (error !== null && typeof error === 'object' && error.code !== 'ESRCH') throw error
    }
  }
  await childExit(child, FORCE_TIMEOUT_MS)
}

async function removeSmokeDirectory(directory) {
  let metadata
  try {
    metadata = await lstat(directory)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink()) {
    await unlink(directory)
    return
  }
  await rm(directory, { recursive: true })
}

async function runRuntimeSmoke(packaged, request) {
  const executable = packagedExecutable(packaged, request)
  const executableMetadata = await lstat(executable)
  if (!executableMetadata.isFile() || executableMetadata.size === 0) {
    throw new Error(`desktop-package: packaged executable is missing or empty: ${executable}`)
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-desktop-smoke-'))
  const dshHome = join(temporaryDirectory, 'home')
  const workspace = join(temporaryDirectory, 'workspace')
  await Promise.all([mkdir(dshHome), mkdir(workspace)])
  const environment = smokeEnvironment(process.env, dshHome)
  let webChild
  try {
    await runVersionSmoke(
      executable,
      packaged.backendEntry,
      packaged.backendManifest.version,
      environment,
      workspace,
    )
    const logs = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    webChild = spawn(executable, [packaged.backendEntry, 'web', '--port', '0'], {
      cwd: workspace,
      detached: request.platform !== 'win32',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    webChild.stdout.on('data', chunk => { logs.stdout = appendLog(logs.stdout, chunk) })
    webChild.stderr.on('data', chunk => { logs.stderr = appendLog(logs.stderr, chunk) })
    const url = await waitForReady(webChild, logs)
    try {
      await requestWebRoot(url)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(formatFailure(`desktop-package: packaged Web root request failed: ${detail}`, logs), {
        cause: error,
      })
    }
    if (!webChild.connected) {
      throw new Error('desktop-package: packaged Web backend disconnected before the shutdown smoke.')
    }
    webChild.send({ type: 'dsh:desktop-shutdown' })
    const result = await childExit(webChild, SHUTDOWN_TIMEOUT_MS)
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(formatFailure(
        `desktop-package: packaged Web backend shutdown failed (${result.code === null ? `signal ${result.signal}` : `exit ${result.code}`}).`,
        logs,
      ))
    }
  } finally {
    if (webChild !== undefined) await terminateProcessTree(webChild, request.platform)
    await removeSmokeDirectory(temporaryDirectory)
  }
}

module.exports = {
  packagedExecutable,
  readyUrl,
  runRuntimeSmoke,
  smokeEnvironment,
}
