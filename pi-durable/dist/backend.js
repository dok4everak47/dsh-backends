import { createRequire } from 'node:module';
import { PiSession, piSessionPrefs } from './session.js';
import { createPiCatalog } from './catalog.js';
export const piManifest = {
    id: 'pi',
    label: { kind: 'literal', text: 'Pi (Durable)' },
    shortLabel: 'Pi',
    inTree: false,
    backendExport: 'backend',
    // The session serves `/model` off pi's own catalog; declaring it is how dst
    // admits the capability name and offers the command.
    capabilities: ['models'],
    grants: [],
};
export const piBackend = {
    id: 'pi',
    descriptor: { label: 'Pi (Durable)' },
    async detect(_host) {
        try {
            await import('@earendil-works/pi-durable');
            const req = createRequire(import.meta.url);
            const v = req('@earendil-works/pi-durable/package.json').version;
            return { installed: true, auth: 'unknown', version: v };
        }
        catch {
            return { installed: false, auth: 'missing', version: 'pi-durable' };
        }
    },
    open(target, host) {
        const session = new PiSession(target, host);
        return session.start().then(() => session);
    },
    launch: {
        sessionPrefs: (host) => piSessionPrefs(host),
        resumeCommand: (sessionId) => `dsh --profile dsh-tui --resume pi:${sessionId}`,
    },
    catalog: createPiCatalog(),
};
