'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const PROCESS_TREE_GRACE_MS = 3_000
const PROCESS_TREE_FORCE_WAIT_MS = 3_000
const PROCESS_TREE_POLL_MS = 50
const PACKAGED_DEPLOYMENT = 'packaged'
const DESKTOP_READY_MESSAGE = 'dsh:desktop-ready'
const DESKTOP_SHUTDOWN_MESSAGE = 'dsh:desktop-shutdown'

/** Environment names removed before the launcher installs its packaged-runtime values. */
const PACKAGED_ENVIRONMENT_OWNED = new Set([
  'DSH_DESKTOP_PATCHES',
  'DSH_DESKTOP_DEPLOYMENT',
  'DSH_HOME',
  'DSH_REPO_ROOT',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
])

/**
 * Classify one renderer navigation without handing unsafe schemes to the OS.
 * @param {string} target - Absolute URL requested by the renderer.
 * @param {string} internalOrigin - Origin served by this desktop process.
 * @returns {{ kind: 'internal', url: string } | { kind: 'external', url: string } | { kind: 'blocked' }} The navigation decision.
 */
function classifyNavigation(target, internalOrigin) {
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    return { kind: 'blocked' }
  }

  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== '' || parsed.password !== '') {
    return { kind: 'blocked' }
  }
  if (parsed.origin === internalOrigin) return { kind: 'internal', url: parsed.href }
  return { kind: 'external', url: parsed.href }
}

/**
 * Parse the optional desktop patch list.
 * @param {string | undefined} raw - JSON text from DSH_DESKTOP_PATCHES.
 * @returns {string[]} Patch paths in command-line order.
 */
function parsePatchFiles(raw) {
  if (raw === undefined || raw.trim() === '') return []

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('DSH_DESKTOP_PATCHES must be a JSON array of patch-file paths.')
  }
  if (!Array.isArray(parsed)
    || parsed.some(value => typeof value !== 'string' || value.trim() === '' || value.includes('\0'))) {
    throw new Error('DSH_DESKTOP_PATCHES must be a JSON array of non-empty patch-file paths.')
  }
  return [...parsed]
}

/**
 * Build the source CLI arguments for one desktop backend.
 * @param {string | undefined} rawPatches - JSON text from DSH_DESKTOP_PATCHES.
 * @returns {string[]} Arguments passed to pnpm.
 */
function harnessArguments(rawPatches) {
  const args = ['dsh', 'web']
  for (const patch of parsePatchFiles(rawPatches)) args.push('--patch', patch)
  args.push('--port', '0')
  return args
}

/**
 * Build the immutable launch contract for either the source shell or an installed application.
 * @param {{
 *   packaged: boolean,
 *   repositoryRoot: string,
 *   resourcesPath: string,
 *   execPath: string,
 *   dshHome: string,
 *   workspaceRoot: string,
 *   inheritedEnvironment: NodeJS.ProcessEnv,
 *   rawPatches?: string,
 *   platform?: NodeJS.Platform,
 * }} options - Runtime locations and inherited process facts.
 * @returns {{ command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, ipc: boolean, backendEntry?: string }} Spawn contract.
 */
function backendLaunch(options) {
  if (!options.packaged) {
    return {
      command: (options.platform ?? process.platform) === 'win32' ? 'pnpm.cmd' : 'pnpm',
      args: harnessArguments(options.rawPatches),
      cwd: path.resolve(options.repositoryRoot),
      env: {
        ...options.inheritedEnvironment,
        DSH_HOME: options.dshHome,
      },
      ipc: false,
    }
  }

  const env = { ...options.inheritedEnvironment }
  // Windows treats environment names case-insensitively even though the
  // ordinary object above can retain two differently-cased keys. Normalize
  // the comparison before installing the launcher's authoritative values so
  // a host `node_options` cannot survive beside the controlled entries.
  for (const name of Object.keys(env)) {
    if (PACKAGED_ENVIRONMENT_OWNED.has(name.toUpperCase())) delete env[name]
  }
  env.DSH_DESKTOP_DEPLOYMENT = PACKAGED_DEPLOYMENT
  env.DSH_HOME = options.dshHome
  env.ELECTRON_RUN_AS_NODE = '1'
  const backendEntry = path.join(options.resourcesPath, 'backend', 'lib', 'bin.js')
  return {
    command: options.execPath,
    args: [backendEntry, ...harnessArguments(undefined).slice(1)],
    cwd: options.workspaceRoot,
    env,
    ipc: true,
    backendEntry,
  }
}

/**
 * Accept only the exact loopback readiness message emitted by the packaged Web runtime.
 * @param {unknown} message - One child-process IPC payload.
 * @returns {string | undefined} Canonical loopback URL when the payload is trusted.
 */
function desktopReadyUrl(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const candidate = /** @type {{ type?: unknown, url?: unknown }} */ (message)
  if (candidate.type !== DESKTOP_READY_MESSAGE || typeof candidate.url !== 'string') return undefined
  let parsed
  try {
    parsed = new URL(candidate.url)
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

/**
 * Return whether a detached POSIX process group still exists.
 * @param {number} pid - Process-group leader pid.
 * @returns {boolean} True while the group can still receive a signal.
 */
function posixTreeAlive(pid) {
  if (pid <= 0) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ESRCH') return false
    if (error !== null && typeof error === 'object' && error.code === 'EPERM') return true
    throw error
  }
}

/**
 * Signal a detached POSIX process group. A group that already exited is a successful no-op.
 * @param {number} pid - Process-group leader pid.
 * @param {'SIGTERM' | 'SIGKILL'} signal - Signal delivered to the whole group.
 */
function signalPosixTree(pid, signal) {
  if (pid <= 0) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ESRCH') return
    throw error
  }
}

/**
 * Force-terminate one Windows process tree.
 * @param {number} pid - Root process pid.
 */
function taskkillProcessTree(pid) {
  if (pid <= 0) return
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  if (result.error !== undefined) throw result.error
  // A non-zero status can mean the tree exited between the liveness probe and
  // taskkill. The controller polls the child afterward and reports only a tree
  // that actually remains alive.
}

/**
 * Create one idempotent controller that stops the complete pnpm/dsh tree.
 * @param {{
 *   pid?: number,
 *   exitCode: number | null,
 *   signalCode: string | null,
 *   connected?: boolean,
 *   send?: (message: unknown) => boolean,
 * }} child - Spawned backend child.
 * @param {{
 *   platform?: NodeJS.Platform,
 *   graceMs?: number,
 *   forceWaitMs?: number,
 *   pollMs?: number,
 *   sleep?: (milliseconds: number) => Promise<void>,
 *   treeAlive?: (pid: number) => boolean,
 *   signalPosixTree?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void,
 *   taskkill?: (pid: number) => void,
 * }} [internals] - Platform facts and test seams.
 * @returns {{ stop: () => Promise<void> }} Whole-tree stop controller.
 */
function createProcessTreeStopper(child, internals = {}) {
  const platform = internals.platform ?? process.platform
  const graceMs = internals.graceMs ?? PROCESS_TREE_GRACE_MS
  const forceWaitMs = internals.forceWaitMs ?? PROCESS_TREE_FORCE_WAIT_MS
  const pollMs = internals.pollMs ?? PROCESS_TREE_POLL_MS
  const sleep = internals.sleep ?? (milliseconds => delay(milliseconds))
  const treeAlive = internals.treeAlive ?? (platform === 'win32'
    ? () => child.exitCode === null && child.signalCode === null
    : posixTreeAlive)
  const signalTree = internals.signalPosixTree ?? signalPosixTree
  const taskkill = internals.taskkill ?? taskkillProcessTree
  const pid = child.pid ?? -1
  let stopPromise

  if (!Number.isFinite(graceMs) || graceMs < 0 || !Number.isFinite(forceWaitMs) || forceWaitMs < 0
    || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('desktop process-tree waits must be finite non-negative durations with a positive poll interval.')
  }

  /** @param {number} budgetMs - Maximum wait budget. */
  const waitUntilGone = async (budgetMs) => {
    const polls = Math.ceil(budgetMs / pollMs)
    for (let attempt = 0; attempt < polls; attempt += 1) {
      if (!treeAlive(pid)) return true
      await sleep(pollMs)
    }
    return !treeAlive(pid)
  }

  const stopOnce = async () => {
    if (pid <= 0 || !treeAlive(pid)) return
    if (child.connected === true && child.send !== undefined) {
      try {
        child.send({ type: DESKTOP_SHUTDOWN_MESSAGE })
        if (await waitUntilGone(graceMs)) return
      } catch {
        // A closing IPC channel is a race, not a failed shutdown; platform
        // termination below remains the authoritative fallback.
      }
    }
    if (platform === 'win32') {
      taskkill(pid)
      if (await waitUntilGone(forceWaitMs)) return
      throw new Error(`desktop backend tree ${String(pid)} remained alive after taskkill.`)
    }

    signalTree(pid, 'SIGTERM')
    if (await waitUntilGone(graceMs)) return
    signalTree(pid, 'SIGKILL')
    if (await waitUntilGone(forceWaitMs)) return
    throw new Error(`desktop backend process group ${String(pid)} remained alive after SIGKILL.`)
  }

  return {
    stop() {
      stopPromise ??= stopOnce()
      return stopPromise
    },
  }
}

module.exports = {
  backendLaunch,
  classifyNavigation,
  createProcessTreeStopper,
  desktopReadyUrl,
  harnessArguments,
}
