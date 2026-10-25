import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { HermesSession, hermesSessionPrefs } from './session.js';
import { createHermesCatalog } from './catalog.js';
const BIN = homedir() + '/.local/bin/hermes-acp';
export const hermesManifest = {
    id: 'hermes',
    label: { kind: 'literal', text: 'Hermes (DeepSeek)' },
    shortLabel: 'Hermes',
    inTree: false,
    backendExport: 'backend',
    // The session serves `/model` over ACP's session/set_model; declaring it is
    // how dst admits the capability name and offers the command.
    capabilities: ['models'],
    grants: [],
};
export const hermesBackend = {
    id: 'hermes',
    descriptor: { label: 'Hermes (DeepSeek)' },
    async detect(_host) {
        const installed = existsSync(BIN);
        return { installed, auth: installed ? 'unknown' : 'missing', version: 'hermes-acp' };
    },
    open(target, host) {
        const session = new HermesSession(target, host);
        return session.start().then(() => session);
    },
    launch: {
        sessionPrefs: (host) => hermesSessionPrefs(host),
        resumeCommand: (sessionId) => `dsh --profile dsh-tui --resume hermes:${sessionId}`,
    },
    catalog: createHermesCatalog(),
};
