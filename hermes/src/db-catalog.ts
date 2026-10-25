import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'

/** One row as the browser shows it (subset of dsh-tui's SessionSummary). */
export interface CatalogRow {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  bytes: undefined
  hasPrompt: boolean
  model: string | undefined
}

/**
 * Read-only catalog over Hermes' `state.db` (sessions + messages tables).
 * Hermes' own ACP server filters its `session/list` to source='acp', so the
 * CLI/Telegram sessions a user actually has are invisible there; this reads
 * the durable store directly instead, listing + previewing only (no replay
 * into a live ACP conversation — those sessions are not ACP-source).
 */
export class HermesCatalog {
  private dbPath: string

  constructor(dbPath?: string) {
    const home = process.env.HOME ?? homedir()
    this.dbPath = dbPath ?? `${home}/.hermes/state.db`
  }

  private open(): DatabaseSync | null {
    try { return new DatabaseSync(this.dbPath, { readOnly: true }) }
    catch { return null }
  }

  list(limit = 50): CatalogRow[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db.prepare(`
        SELECT id, title, cwd, model, started_at, last_activity_at, message_count, source
        FROM sessions
        WHERE source <> 'acp' AND message_count > 0
        ORDER BY (last_activity_at IS NULL), last_activity_at DESC, started_at DESC
        LIMIT ?
      `).all(limit) as any[]
      return rows.map((r) => ({
        id: r.id,
        title: r.title ?? '(untitled)',
        cwd: r.cwd ?? '',
        createdAt: (r.started_at ?? 0) * 1000,
        updatedAt: ((r.last_activity_at ?? r.started_at) ?? 0) * 1000,
        bytes: undefined,
        hasPrompt: (r.message_count ?? 0) > 0,
        model: r.model ?? undefined,
      }))
    } finally { db.close() }
  }

  /** Trailing exchanges for the browser preview, oldest first. */
  preview(sessionId: string, count = 8): { role: 'user' | 'assistant'; text: string; at: number | undefined }[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db.prepare(`
        SELECT role, content, timestamp
        FROM messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
        ORDER BY display_order ASC, timestamp ASC
      `).all(sessionId) as any[]
      const out: { role: 'user' | 'assistant'; text: string; at: number | undefined }[] = []
      for (const r of rows) {
        let text = ''
        try { text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content) } catch { text = String(r.content ?? '') }
        out.push({ role: r.role, text: text.slice(0, 400), at: r.timestamp ? r.timestamp * 1000 : undefined })
      }
      return out.slice(-count)
    } finally { db.close() }
  }
}
