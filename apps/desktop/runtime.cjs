'use strict'

const { spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

const PROCESS_TREE_GRACE_MS = 3_000
const PROCESS_TREE_FORCE_WAIT_MS = 3_000
const PROCESS_TREE_POLL_MS = 50

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
 * @param {{ pid?: number, exitCode: number | null, signalCode: string | null }} child - Spawned pnpm child.
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
  classifyNavigation,
  createProcessTreeStopper,
  harnessArguments,
}
