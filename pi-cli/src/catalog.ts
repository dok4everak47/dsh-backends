import type { SessionSummary, PreviewEntry } from '@deepseek-harness-tui/dsh-tui/lib/types/adapter/ports/channel-session.js'
import type { SessionCatalog, SessionListScope } from '@deepseek-harness-tui/dsh-tui/lib/types/agent/backend.js'

/**
 * Minimal catalog for the Pi CLI backend: no history browser for v1. Resume of a
 * past Pi session works through launch.sessionPrefs + resumeCommand instead.
 */
export function createPiCliCatalog(): SessionCatalog {
  return {
    async list(_scope?: SessionListScope): Promise<readonly SessionSummary[]> {
      return []
    },
    async preview(_sessionId: string, _options?: { cwd?: string; limit?: number }): Promise<readonly PreviewEntry[]> {
      return []
    },
  }
}
