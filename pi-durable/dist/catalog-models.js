import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** The one api pi-durable knows how to stream. A provider declared with
 *  another api is left out rather than offered and then failed on the wire. */
const STREAMABLE_API = 'openai-completions';
function readProviders(home) {
    const file = join(home, '.pi', 'agent', 'models.json');
    if (!existsSync(file))
        return [];
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return [];
    }
    return Object.entries(parsed.providers ?? {}).filter(([, block]) => (block?.api ?? STREAMABLE_API) === STREAMABLE_API);
}
/**
 * pi's own model catalog, read from `~/.pi/agent/models.json` — the file the
 * `pi` CLI resolves `--model` against, so the picker offers exactly the routes
 * that CLI would accept. Read once per listing: the file is small and a
 * running session must not keep a catalog the user has since edited.
 */
export function readPiCatalog(home = homedir()) {
    const rows = [];
    for (const [provider, block] of readProviders(home)) {
        for (const model of block.models ?? []) {
            if (typeof model.id !== 'string' || model.id === '')
                continue;
            rows.push({
                provider,
                id: model.id,
                name: model.name ?? model.id,
                ...(block.api === undefined ? {} : { description: `${provider} · ${block.api}` }),
            });
        }
    }
    return rows;
}
/** Every provider block pi-durable can build a stream from, keyed by provider
 *  id, so a switch rebuilds nothing: every route in the picker already has a
 *  provider behind it. */
export function readPiProviders(home = homedir()) {
    return new Map(readProviders(home));
}
