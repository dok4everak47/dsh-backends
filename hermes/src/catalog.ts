import { HermesCatalog } from './db-catalog.js'
import type { SessionSummary, PreviewEntry } from '@deepseek-harness-tui/dsh-tui/lib/types/adapter/ports/channel-session.js'
import type { SessionCatalog, SessionListScope } from '@deepseek-harness-tui/dsh-tui/lib/types/agent/backend.js'

/**
 * dsh-tui SessionCatalog over Hermes' local store: lists the user's existing
 * Hermes sessions (the ones ACP `session/list` cannot see) and previews their
 * trailing exchanges. Read-only — these are not ACP-source sessions, so they
 * are browsed, not replayed into a live conversation.
 */
export function createHermesCatalog(): SessionCatalog {
  const store = new HermesCatalog()
  return {
    async list(_scope?: SessionListScope): Promise<readonly SessionSummary[]> {
      const rows = store.list(200)
      const out: SessionSummary[] = rows.map((r) => ({
        id: r.id,
        backendId: 'hermes',
        kind: { kind: 'root' },
        title: { text: r.title, source: 'prompt' },
        cwd: r.cwd,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        bytes: undefined,
        hasPrompt: r.hasPrompt,
        agentPreset: undefined,
        model: r.model,
        label: undefined,
        branch: undefined,
        childCount: 0,
      }))
      return out
    },
    async preview(sessionId: string, options?: { cwd?: string; limit?: number }): Promise<readonly PreviewEntry[]> {
      const rows = store.preview(sessionId, options?.limit ?? 8)
      return rows.map((r) => ({ role: r.role, text: r.text, at: r.at }))
    },
  }
}
