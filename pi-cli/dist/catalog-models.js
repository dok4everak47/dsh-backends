import { execFile } from 'node:child_process';
/**
 * pi's own catalog, read from the CLI that will run the turn. `pi --list-models`
 * prints a fixed-width table whose first two columns are what `--model` accepts
 * as `provider/id`, so the picker offers exactly the routes this CLI resolves.
 * The listing runs a real `pi` invocation (~0.8 s), so it is only ever called
 * from `list()`.
 */
export function readPiCatalog(env = process.env) {
    return new Promise(resolve => {
        execFile('pi', ['--list-models'], { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                resolve([]);
                return;
            }
            resolve(parseListing(stdout));
        });
    });
}
/** Split the table `pi --list-models` prints: provider, model, then columns this
 *  backend does not use. The header row is the one naming `provider`. */
export function parseListing(text) {
    const lines = text.split('\n');
    const rows = [];
    for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed === '' || /^\s*provider\s+model\b/.test(trimmed))
            continue;
        // Model ids never carry spaces, so the first two blank-separated fields are
        // the route and everything after them is the table's own columns.
        const fields = trimmed.split(/\s{2,}|\t/);
        if (fields.length < 2)
            continue;
        const [provider, id] = fields;
        if (provider === undefined || id === undefined || provider === '' || id === '')
            continue;
        rows.push({ provider, id, name: `${provider}/${id}` });
    }
    return rows;
}
/** The route `pi` accepts on `--model`: `provider/id`, or a bare id. */
export function modelSpec(provider, id) {
    return provider === undefined || provider === '' ? id : `${provider}/${id}`;
}
