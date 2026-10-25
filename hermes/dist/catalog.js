import { HermesCatalog } from './db-catalog.js';
/**
 * dsh-tui SessionCatalog over Hermes' local store: lists the user's existing
 * Hermes sessions (the ones ACP `session/list` cannot see) and previews their
 * trailing exchanges. Read-only — these are not ACP-source sessions, so they
 * are browsed, not replayed into a live conversation.
 */
export function createHermesCatalog() {
    const store = new HermesCatalog();
    return {
        async list(_scope) {
            const rows = store.list(200);
            const out = rows.map((r) => ({
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
            }));
            return out;
        },
        async preview(sessionId, options) {
            const rows = store.preview(sessionId, options?.limit ?? 8);
            return rows.map((r) => ({ role: r.role, text: r.text, at: r.at }));
        },
    };
}
