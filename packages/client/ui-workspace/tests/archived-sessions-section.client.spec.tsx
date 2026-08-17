// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId, SessionListState, SessionSummary, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { ArchivedSessionsSection } from '../src/client/ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionProps } from '../src/client/ArchivedSessionsSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// Standard locale seat stub mirroring the real ns → common → key chain (zh default).
const t = makeTranslate(zh, commonZh) as never

const sid = (id: string) => id as SessionId

/** Minimal session row carrying only what the section reads. */
function summary(id: string, title: string, updatedAt: number): SessionSummary {
  return { id: sid(id), displayTitle: title, updatedAt, blank: false, running: false }
}

/** Session list state with the given rows (archived ids stay listed, as in production). */
function sessionState(rows: SessionSummary[], phase: 'pending' | 'ready' = 'ready'): SessionListState {
  const byId: Record<SessionId, SessionSummary> = {}
  for (const row of rows) byId[row.id] = row
  return {
    ids: rows.map(row => row.id), byId, current: undefined, phase,
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

/** Workspace list state with the given registry-global archive set. */
function workspaceState(archivedSessionIds: SessionId[]): WorkspaceListState {
  return {
    items: [], archivedSessionIds, state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }
}

/** Drive one framework selector hook from an immutable test snapshot. */
function selectorHook<T>(state: T): SnapshotSelectorHook<T> {
  return selector => selector(state)
}

/** Section props with driven standard hooks; actions and close are spies. */
function props(overrides: Partial<ArchivedSessionsSectionProps> = {}): ArchivedSessionsSectionProps {
  const rows = sessionState([summary('arch', 'Archived One', 1)])
  return {
    t,
    close: vi.fn(),
    open: vi.fn(),
    unarchiveSession: vi.fn().mockResolvedValue(undefined),
    useSessions: selectorHook(rows),
    useWorkspaces: selectorHook(workspaceState([sid('arch')])),
    ...overrides,
  }
}

describe('archived sessions settings section', () => {
  it('lists archived rows in archive order with titles and update times', () => {
    render(<ArchivedSessionsSection {...props({
      useSessions: selectorHook(sessionState([
        summary('one', 'First Archived', 1_700_000_000_000),
        summary('two', 'Second Archived', 1_700_100_000_000),
      ])),
      useWorkspaces: selectorHook(workspaceState([sid('two'), sid('one')])),
    })} />)
    const openers = screen.getAllByRole('button', { name: /打开会话/ })
    expect(openers.map(button => button.textContent)).toEqual([
      expect.stringContaining('Second Archived'),
      expect.stringContaining('First Archived'),
    ])
    expect(screen.getByText('已归档会话')).toBeTruthy()
  })

  it('skips archived ids the session list does not carry', () => {
    render(<ArchivedSessionsSection {...props({
      useWorkspaces: selectorHook(workspaceState([sid('ghost'), sid('arch')])),
    })} />)
    expect(screen.getAllByRole('button', { name: /打开会话/ })).toHaveLength(1)
  })

  it('restores before opening and closes only after the restore settles', async () => {
    const open = vi.fn()
    const close = vi.fn()
    let resolveUnarchive: (() => void) | undefined
    const unarchiveSession = vi.fn(() => new Promise<void>((resolve) => { resolveUnarchive = resolve }))
    render(<ArchivedSessionsSection {...props({ open, close, unarchiveSession })} />)
    fireEvent.click(screen.getByRole('button', { name: /打开会话/ }))
    expect(unarchiveSession).toHaveBeenCalledWith(sid('arch'))
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /打开会话/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '取消归档' })).toHaveProperty('disabled', true)
    await act(async () => { resolveUnarchive?.() })
    expect(open).toHaveBeenCalledWith(sid('arch'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not open or close when row activation fails to restore', async () => {
    const open = vi.fn()
    const close = vi.fn()
    const unarchiveSession = vi.fn().mockRejectedValue(new Error('storage down'))
    render(<ArchivedSessionsSection {...props({ open, close, unarchiveSession })} />)
    fireEvent.click(screen.getByRole('button', { name: /打开会话/ }))
    await act(async () => { await Promise.resolve() })
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('storage down')
  })

  it('unarchives a row and disables its action until the call settles', async () => {
    let resolveUnarchive: (() => void) | undefined
    const unarchiveSession = vi.fn(() => new Promise<void>((resolve) => { resolveUnarchive = resolve }))
    render(<ArchivedSessionsSection {...props({ unarchiveSession })} />)
    fireEvent.click(screen.getByRole('button', { name: '取消归档' }))
    expect(unarchiveSession).toHaveBeenCalledWith(sid('arch'))
    expect(screen.getByRole('button', { name: '取消归档' })).toHaveProperty('disabled', true)
    await act(async () => { resolveUnarchive?.() })
    expect(screen.getByRole('button', { name: '取消归档' })).toHaveProperty('disabled', false)
  })

  it('shows the wire failure and re-enables the action when unarchiving rejects', async () => {
    const unarchiveSession = vi.fn().mockRejectedValue(new Error('storage down'))
    render(<ArchivedSessionsSection {...props({ unarchiveSession })} />)
    fireEvent.click(screen.getByRole('button', { name: '取消归档' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toBe('storage down')
    expect(screen.getByRole('button', { name: '取消归档' })).toHaveProperty('disabled', false)
  })

  it('stringifies a non-Error rejection into the failure line', async () => {
    const unarchiveSession = vi.fn().mockRejectedValue('wire gone')
    render(<ArchivedSessionsSection {...props({ unarchiveSession })} />)
    fireEvent.click(screen.getByRole('button', { name: '取消归档' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toBe('wire gone')
  })

  it('renders the empty copy once the list baseline is ready', () => {
    render(<ArchivedSessionsSection {...props({
      useSessions: selectorHook(sessionState([])),
      useWorkspaces: selectorHook(workspaceState([])),
    })} />)
    expect(screen.getByText('暂无已归档会话')).toBeTruthy()
  })

  it('renders nothing while the session list baseline is still pending', () => {
    render(<ArchivedSessionsSection {...props({
      useSessions: selectorHook(sessionState([], 'pending')),
      useWorkspaces: selectorHook(workspaceState([sid('arch')])),
    })} />)
    expect(screen.queryByText('暂无已归档会话')).toBeNull()
    expect(screen.queryAllByRole('button', { name: /打开会话/ })).toHaveLength(0)
  })
})
