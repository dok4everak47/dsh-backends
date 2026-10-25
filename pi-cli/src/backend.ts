import type {
  AgentBackend,
  BackendDetection,
  BackendHost,
  OpenTarget,
} from '@deepseek-harness-tui/dsh-tui/lib/types/agent/backend.js'
import type { BackendManifest } from '@deepseek-harness-tui/dsh-tui/lib/types/agent/backend-manifest.js'
import { spawnSync } from 'node:child_process'
import { PiCliSession, piSessionPrefs } from './session.js'
import { createPiCliCatalog } from './catalog.js'

export const piCliManifest: BackendManifest = {
  id: 'pi-cli',
  label: { kind: 'literal', text: 'Pi (CLI)' },
  shortLabel: 'Pi CLI',
  inTree: false,
  backendExport: 'backend',
  // The session serves `/model` off the `pi` CLI's own catalog; declaring it is
  // how dst admits the capability name and offers the command.
  capabilities: ['models'],
  grants: [],
}

function piInstalled(): boolean {
  try {
    const r = spawnSync('pi', ['--version'], { timeout: 5000 })
    return !r.error
  } catch {
    return false
  }
}

export const piCliBackend: AgentBackend = {
  id: 'pi-cli',
  descriptor: { label: 'Pi (CLI)' },
  async detect(_host: BackendHost): Promise<BackendDetection> {
    const installed = piInstalled()
    const r = spawnSync('pi', ['--version'], { timeout: 5000 })
    return { installed, auth: installed ? 'unknown' : 'missing', version: (r.stdout?.toString().trim() || 'pi') }
  },
  open(target: OpenTarget, host: BackendHost): Promise<PiCliSession> {
    const session = new PiCliSession(target, host)
    return session.start().then(() => session)
  },
  launch: {
    sessionPrefs: (host: BackendHost) => piSessionPrefs(host),
    resumeCommand: (sessionId: string) => `dsh --profile dsh-tui --resume pi-cli:${sessionId}`,
  },
  catalog: createPiCliCatalog(),
}
