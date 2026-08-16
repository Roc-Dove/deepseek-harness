/**
 * Archived sessions settings section: the recovery surface for sessions the
 * grouping surfaces hide. Each row shows the session title, its absolute
 * update time, and an Unarchive action; activating the row first restores the
 * session, then opens it and closes the settings panel. Row data arrives through the framework's
 * standard hooks — the sessions list still carries archived rows, and the
 * workspaces snapshot carries the registry-global archive set.
 */
import { useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the settings shell's SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './ArchivedSessionsSection.module.css'

/** Registration-side business face for the section. */
export interface ArchivedSessionsInjected {
  /** Open a restored Session (the section then closes the settings panel). */
  open: (sessionId: SessionId) => void
  /** Restore one session into its previous grouping position. */
  unarchiveSession: (sessionId: SessionId) => Promise<void>
}

/** Props the renderer binds for the section. */
export type ArchivedSessionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'workspace'>
  & ArchivedSessionsInjected

/** Absolute update time through the workspace dictionary's date template. */
function updatedLabel(updatedAt: number, t: ArchivedSessionsSectionProps['t']): string {
  const d = new Date(updatedAt)
  const pad2 = (v: number): string => String(v).padStart(2, '0')
  const date = t('date.ymd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return t('settings.updatedAt', { time: `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` })
}

/** One archived-session row with its update time. */
interface ArchivedRow {
  id: SessionId
  summary: SessionSummary
}

/**
 * The archived-sessions settings page: title rows that restore and then open
 * their session, and a per-row Unarchive action that only restores the
 * session's grouping position. The archive set is append-ordered by the Host,
 * so rows follow archive order.
 */
export function ArchivedSessionsSection({
  t, close, open, unarchiveSession, useSessions, useWorkspaces,
}: ArchivedSessionsSectionProps) {
  const byId = useSessions(state => state.byId)
  const phase = useSessions(state => state.phase)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const [busyIds, setBusyIds] = useState<ReadonlySet<SessionId>>(() => new Set())
  const [error, setError] = useState<string>()

  // Only rows the list store already carries are renderable; a pending list
  // keeps the section silent until the host baseline lands.
  const rows = useMemo(() => {
    const present: ArchivedRow[] = []
    for (const id of archivedSessionIds) {
      const summary = byId[id]
      if (summary !== undefined) present.push({ id, summary })
    }
    return present
  }, [archivedSessionIds, byId])

  const unarchive = (id: SessionId, after?: () => void): void => {
    setError(undefined)
    setBusyIds(previous => new Set(previous).add(id))
    void unarchiveSession(id)
      .then(() => { after?.() })
      .catch((failure: unknown) => {
        // Runtime failure strings pass through untranslated by policy.
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => {
        setBusyIds((previous) => {
          /* v8 ignore next 3 -- this sole remover cannot miss id; the guard preserves identity if that changes */
          if (!previous.has(id)) return previous
          const next = new Set(previous)
          next.delete(id)
          return next
        })
      })
  }

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('settings.archivedTitle')}</h2>
      <p className={css.intro}>{t('settings.archivedIntro')}</p>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {rows.length > 0 && (
        <ul className={css.rows}>
          {rows.map(({ id, summary }) => {
            const busy = busyIds.has(id)
            const label = summary.displayTitle
            return (
              <li key={id} className={css.row}>
                <button
                  type="button"
                  className={css.open}
                  aria-label={t('settings.open.aria', { name: label })}
                  disabled={busy}
                  onClick={() => { unarchive(id, () => { open(id); close() }) }}
                >
                  <span className={css.title}>{label}</span>
                  <span className={css.time}>{updatedLabel(summary.updatedAt, t)}</span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={css.unarchive}
                  disabled={busy}
                  onClick={() => { unarchive(id) }}
                >
                  {t('settings.unarchive')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {rows.length === 0 && phase === 'ready' && (
        <p className={css.empty}>{t('settings.archivedEmpty')}</p>
      )}
    </div>
  )
}
