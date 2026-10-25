/**
 * Minimal catalog for the Pi CLI backend: no history browser for v1. Resume of a
 * past Pi session works through launch.sessionPrefs + resumeCommand instead.
 */
export function createPiCliCatalog() {
    return {
        async list(_scope) {
            return [];
        },
        async preview(_sessionId, _options) {
            return [];
        },
    };
}
