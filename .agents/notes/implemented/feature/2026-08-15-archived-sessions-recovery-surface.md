# Agent Note: Archived sessions get a settings recovery surface and an unarchive RPC

Status: implemented

English | [中文](2026-08-15-archived-sessions-recovery-surface.zh.md)

## Problem

The [registry-global archive-set decision](2026-07-31-session-archive-global-set.md) deliberately kept a session's log and workspace accounting slot while hiding it from every grouping surface, but its first iteration exposed no list of the archived set and no inverse operation. A user who archived a session could never find or restore it — the data was there, the way back was not.

## Decision

**Unarchiving is a registry-global display-set write, not a session operation.** The workspace registry gains `unarchiveSession(sessionId)`: remove the id from `archivedSessionIds` and commit through the existing `setState` path, so the `domain/changed` listener broadcasts the same `host/archived-sessions-changed` frame archiving uses. No session-existence check runs — an unarchive never needs the session's data, and a stale marker for a missing id only clears a display bit. An id not in the set resolves without writing (the archive idempotence mirror).

**The wire surface mirrors `workspace.archiveSession`.** `workspace.unarchiveSession` carries the same payload and returns the full updated set, so the client's echo installation (`installArchived`) and the changed-frame handler share one path with archiving. Request and frame generations prevent an older full-set unary echo from replacing a newer frame or local request. The client `IWorkspaces` face, the runtime manager/service, the apiproxy schema/handler/client rows, and the test doubles all extend in the same shape.

**The recovery UI lives in ui-workspace as a `settings.section`.** The workspace domain already owns the archive menu item, its locale namespace, and the browsing surfaces, so the "Archived sessions" settings page stays in that package instead of a new one. The section reads the standard framework hooks (`useSessions` for rows — the list store still carries archived sessions, the browser only filters them — and `useWorkspaces` for the archive set). Activating a row first awaits `ctx.workspaces.unarchiveSession`, then opens it through `ctx.sessions.open` and closes the panel; this ordering is required because the runtime clears any current selection that is still archived. The explicit **Unarchive** action restores without opening. Rows follow the Host's append-ordered archive set; the empty state renders only after the session-list baseline is ready, and a pending baseline keeps the section silent.

## Alternatives considered

**Treat unarchive as a Session operation and reject missing sessions.** Rejected because the archive set is registry-global display metadata, not session-owned state. Clearing a stale marker must remain possible even when the corresponding session log has already disappeared.

**Open an archived row without restoring it.** Rejected because the runtime clears any current selection that remains in the archive set. Row activation therefore combines restore and open, while the explicit **Unarchive** action preserves the restore-without-open intent.

**Create a separate recovery UI package.** Rejected because ui-workspace already owns the archive action, locale namespace, grouping semantics, and workspace hooks. Contributing one section through the existing settings slot keeps ownership together without extending the settings shell.

## Consequences

- Unarchiving restores the session to its previous grouping position because archiving never touched the workspace `sessionIds` account.
- The changed frame reaches every connected tab, so a restore in one tab unhides the row in the others without a refresh.
- The section adds a `@deepseek-ai/dsh-client-ui-settings` peer/dev edge and tsconfig reference to ui-workspace (the slot is declared by ui-settings-general's shell; registration rides `slots.inject` like every cross-package slot).
- Dynamic Cordis plugins are unaffected: nothing about the archive set or the settings slot changed shape; a new RPC and a new list entry are additive.
