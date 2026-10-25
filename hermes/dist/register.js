import { hermesBackend, hermesManifest } from './backend.js';
/**
 * Third-party backend entry. dsh-tui's bundle scanner reads `dsh-plugin.json`
 * at the package root, then imports this module and takes the `backend`
 * (AgentBackend) and `manifest` (BackendManifest) named exports — it validates
 * and admits them itself. No manual `registerBackend` call (that is in-tree
 * only). The module is only imported once the backend is actually selected.
 */
export const backend = hermesBackend;
export const manifest = hermesManifest;
