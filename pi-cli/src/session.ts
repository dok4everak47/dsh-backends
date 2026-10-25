import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type {
  AgentEvent,
  AgentEventMeta,
} from '@deepseek-harness-tui/dsh-tui/lib/types/agent/events.js'
import type {
  AgentInput,
  AgentSession,
  CancelCause,
  CancelReceipt,
  SubmitPlacement,
} from '@deepseek-harness-tui/dsh-tui/lib/types/agent/session.js'
import type { BackendHost, OpenTarget } from '@deepseek-harness-tui/dsh-tui/lib/types/agent/backend.js'
import type { SessionCapabilities } from '@deepseek-harness-tui/dsh-tui/lib/types/agent/capabilities.js'
import { modelSpec, readPiCatalog } from './catalog-models.js'

const MODEL_CONTEXT_WINDOW = 1_000_000

// The `pi` CLI is pi.dev's own entry point, which drives the same pi-durable
// core as the library backend but through the user's full pi configuration
// (extensions, skills, MCP, provider auth). We shell out to `pi --mode json
// --print` and translate its JSON-lines event stream. The default route is the
// one pi's own catalog lists for the local magpie gateway; set PI_MODEL to
// another `provider/model` from `pi --list-models`.
function piModelSpec(): string {
  return process.env.PI_MODEL ?? 'magpie/auto/deepseek-v4.1-flash'
}

type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void
type SubmitResult = { readonly accepted: boolean; readonly reason?: string }

function ev(e: Record<string, unknown>): AgentEvent {
  return e as unknown as AgentEvent
}

export class PiCliSession implements AgentSession {
  readonly backendId = 'pi-cli'
  readonly sessionId: string
  readonly ref: { backendId: string; sessionId: string }
  /** `models` is what makes dst offer `/model`; without it the command is
   *  refused as backend-unavailable and no picker opens. */
  readonly capabilities: SessionCapabilities = {
    native: {},
    models: {
      list: async () => (await readPiCatalog()).map(model => ({
        provider: model.provider,
        id: model.id,
        label: model.name,
      })),
      // The pieces `list()` gave, passed back whole: `pi` takes them joined.
      current: () => ({ provider: this.providerId, model: this.modelId }),
      set: async ref => {
        // dst sends the provider only when it differs from the current one, and
        // a provider name is passed back exactly as `list()` gave it, so a spec
        // built from both is the whole route even with slashes inside either.
        const rows = await readPiCatalog()
        const row = ref.provider === undefined || ref.provider === ''
          ? rows.find(model => model.provider === this.providerId && model.id === ref.model)
            ?? rows.find(model => modelSpec(model.provider, model.id) === ref.model)
          : rows.find(model => modelSpec(model.provider, model.id) === modelSpec(ref.provider, ref.model))
        if (row === undefined) return { kind: 'refused', reason: `unknown model: ${modelSpec(ref.provider, ref.model)}` }
        this.setRoute(row.provider, row.id)
        this.emitLive(
          [ev({ type: 'model.changed', model: this.modelId, provider: this.providerId, source: 'user' })],
          { replay: false },
        )
        return { kind: 'switched' }
      },
    },
  }
  readonly cwd: string

  private host: BackendHost
  private piSessionId: string
  private sessionDir: string
  private modelSpec: string
  /** The route apart as dst asks it back; `modelSpec` is what `pi` takes. */
  private providerId = ''
  private modelId = ''
  status: 'starting' | 'idle' | 'running' | 'requires-action' | 'disposed' = 'starting'
  private seq = 0
  private turnNo = 0
  private stepNo = 0
  private curAttemptId = ''
  private msgHasDeltas = false
  private lastUsage = -1
  private toolSteps = new Map<string, number>()
  private toolOutput = new Map<string, string>()
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null
  private listeners = new Set<Listener>()
  private historyEvents: AgentEvent[] = []
  private earlyEvents: AgentEvent[] = []
  private buf = ''

  constructor(target: OpenTarget, host: BackendHost) {
    this.host = host
    this.cwd = (target as { cwd?: string }).cwd ?? host.cwd ?? process.cwd()
    const isResume = (target as { kind: string }).kind === 'resume'
    const sid = isResume ? (target as { sessionId: string }).sessionId : randomUUID()
    this.sessionId = sid
    this.piSessionId = sid
    this.ref = { backendId: 'pi-cli', sessionId: sid }
    const base = host.dataDir ?? join(this.cwd, '.dsh-pi-cli')
    this.sessionDir = join(base, 'sessions')
    mkdirSync(this.sessionDir, { recursive: true })
    this.modelSpec = piModelSpec()
    this.setRouteFromSpec()
  }

  /** `modelSpec` is the one source; the split is recorded for `current()`. */
  private setRouteFromSpec(): void {
    const slash = this.modelSpec.indexOf('/')
    this.providerId = slash < 0 ? this.modelSpec : this.modelSpec.slice(0, slash)
    this.modelId = slash < 0 ? this.modelSpec : this.modelSpec.slice(slash + 1)
  }

  private setRoute(provider: string, id: string): void {
    this.providerId = provider
    this.modelId = id
    this.modelSpec = modelSpec(provider, id)
  }

  async start(): Promise<void> {
    this.replaySessionFile()
    // `pi` only reports a bad `--model` on the first turn's stderr, which this
    // backend discards; checking it against the catalog here means a wrong
    // default or a stale PI_MODEL fails at open, where it can be named.
    const catalog = await readPiCatalog()
    if (catalog.length > 0 && !catalog.some(row => modelSpec(row.provider, row.id) === this.modelSpec)) {
      const fallback = catalog.find(row => row.provider === 'magpie') ?? catalog[0]
      if (fallback !== undefined) {
        this.host.warn(`pi-cli: model ${this.modelSpec} is not in pi's catalog; using ${modelSpec(fallback.provider, fallback.id)}`)
        this.setRoute(fallback.provider, fallback.id)
      }
    }
    const provider = this.providerId
    this.emitLive(
      [ev({ type: 'session.ready', sessionId: this.sessionId, cwd: this.cwd, model: this.modelSpec, provider })],
      { replay: false },
    )
    this.setStatus('idle')
  }

  // --- translation of pi CLI events ---

  // --- history replay from the pi session file ---

  /**
   * `pi --print` writes the session as JSONL at
   * `<session-dir>/<timestamp>_<sessionId>.jsonl` holding compact `message`
   * entries (not the streaming events). Seed history from it so a resumed
   * session shows its earlier turns.
   */
  private replaySessionFile(): void {
    let file: string | undefined
    try {
      const matches = readdirSync(this.sessionDir).filter((n) => n.endsWith(`_${this.piSessionId}.jsonl`))
      if (matches.length) {
        matches.sort()
        file = join(this.sessionDir, matches[matches.length - 1])
      }
    } catch {
      return
    }
    if (!file) return
    let lines: string[]
    try {
      lines = readFileSync(file, 'utf8').split('\n')
    } catch {
      return
    }
    for (const line of lines) {
      const s = line.trim()
      if (!s) continue
      let o: any
      try {
        o = JSON.parse(s)
      } catch {
        continue
      }
      this.replayEntry(o)
    }
  }

  private replayEntry(o: any): void {
    if (o?.type !== 'message') return
    const m = o.message
    if (!m) return
    const blocks: any[] = Array.isArray(m.content) ? m.content : []
    const texts = (kind: string): string =>
      blocks.filter((b: any) => b?.type === kind && typeof b.text === 'string').map((b: any) => b.text).join('\n')

    if (m.role === 'user') {
      this.turnNo += 1
      this.stepNo = 0
      const text = texts('text')
      this.pushHistory([
        ev({ type: 'turn.start', turn: this.turnNo, origin: 'user', time: Date.now() }),
        ev({ type: 'user.message', id: `h-u-${this.turnNo}`, anchor: '', seq: ++this.seq, turn: this.turnNo, time: Date.now(), source: 'user', text, blocks: [{ type: 'text', text }] }),
      ])
      return
    }

    if (m.role === 'assistant') {
      for (const tc of blocks.filter((b: any) => b?.type === 'toolCall')) {
        this.stepNo += 1
        this.toolSteps.set(tc.id, this.stepNo)
        this.pushHistory([
          ev({
            type: 'tool.call',
            seq: ++this.seq,
            turn: this.turnNo,
            step: this.stepNo,
            callId: tc.id,
            name: tc.name,
            argsJson: JSON.stringify(tc.arguments ?? {}),
            time: Date.now(),
          }),
        ])
      }
      const text = texts('text')
      const thinking = texts('thinking')
      if (!text && !thinking) return
      this.stepNo += 1
      const att = `h-att-${this.turnNo}-${this.stepNo}`
      const steps: AgentEvent[] = [ev({ type: 'assistant.attempt.start', attemptId: att, turn: this.turnNo, step: this.stepNo, model: this.modelSpec })]
      if (thinking) steps.push(ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'reasoning', text: thinking } }))
      if (text) steps.push(ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'text', text } }))
      steps.push(ev({ type: 'assistant.attempt.end', attemptId: att, turn: this.turnNo, step: this.stepNo, outcome: 'committed' }))
      this.pushHistory(steps)
      return
    }

    if (m.role === 'toolResult') {
      const step = this.toolSteps.get(m.toolCallId) ?? this.stepNo
      const out = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('')
      this.pushHistory([
        ev({ type: 'tool.result', seq: ++this.seq, turn: this.turnNo, step, callId: m.toolCallId, isError: !!m.isError, time: Date.now(), content: [], text: out }),
      ])
    }
  }

  private onEvent(e: any): void {
    const t = e?.type
    if (t === 'message_end') {
      this.onMessageEnd(e)
    } else if (t === 'tool_execution_start') {
      this.onToolStart(e)
    } else if (t === 'tool_execution_update') {
      this.onToolUpdate(e)
    } else if (t === 'tool_execution_end') {
      this.onToolEnd(e)
    } else if (t === 'message_update' && e.usage) {
      this.onUsage(e.usage)
    }
    // turn_start / turn_end / agent_* are synthesized locally; ignored here.
  }

  private openIfNeeded(): void {
    if (this.curAttemptId) return
    this.stepNo += 1
    this.curAttemptId = `att${this.turnNo}_${this.stepNo}`
    this.emitLive(
      [ev({ type: 'assistant.attempt.start', attemptId: this.curAttemptId, turn: this.turnNo, step: this.stepNo, model: this.modelSpec })],
      { replay: false },
    )
  }

  private closeAttempt(): void {
    if (!this.curAttemptId) return
    this.emitLive(
      [ev({ type: 'assistant.attempt.end', attemptId: this.curAttemptId, turn: this.turnNo, step: this.stepNo, outcome: 'committed' })],
      { replay: false },
    )
    this.curAttemptId = ''
  }

  private onMessageEnd(e: any): void {
    // pi streams text at message_end as full content blocks (not incremental
    // deltas). If message_update deltas were ever present they win; otherwise
    // extract from the assistant message content here.
    if (this.msgHasDeltas) return
    const msg = e?.message
    if (!msg || msg.role !== 'assistant') return
    const blocks: any[] = Array.isArray(msg.content) ? msg.content : []
    const text = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
    const thinking = blocks.filter((b: any) => b?.type === 'thinking' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
    if (!text && !thinking) return
    this.openIfNeeded()
    const att = this.curAttemptId
    if (thinking) this.emitLive([ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'reasoning', text: thinking } })], { replay: false })
    if (text) this.emitLive([ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'text', text } })], { replay: false })
    this.closeAttempt()
  }

  private onToolStart(e: { toolCallId: string; toolName: string; args?: any }): void {
    this.stepNo += 1
    this.toolSteps.set(e.toolCallId, this.stepNo)
    this.toolOutput.set(e.toolCallId, '')
    this.emitLive(
      [ev({
        type: 'tool.call',
        seq: ++this.seq,
        turn: this.turnNo,
        step: this.stepNo,
        callId: e.toolCallId,
        name: e.toolName,
        argsJson: JSON.stringify(e.args ?? {}),
        time: Date.now(),
      })],
      { replay: false },
    )
    // A tool closes the current reasoning/text attempt so text after the tool opens a new step.
    this.curAttemptId = ''
  }

  private onToolUpdate(e: { toolCallId: string; output?: any }): void {
    const cur = this.toolOutput.get(e.toolCallId) ?? ''
    const o = e.output
    let next = cur
    if (o) {
      if ('set' in o && o.set !== undefined) next = o.set as string
      else if (typeof o.append === 'string') next += o.append
    }
    this.toolOutput.set(e.toolCallId, next)
  }

  private onToolEnd(e: { toolCallId: string; result?: any; isError?: boolean }): void {
    const step = this.toolSteps.get(e.toolCallId) ?? this.stepNo
    const res = e.result
    let out = ''
    if (res) {
      if (typeof res.structuredContent === 'string') out = res.structuredContent
      else if (Array.isArray(res.content)) out = res.content.map((b: any) => b?.text ?? '').join('')
    }
    this.emitLive(
      [ev({
        type: 'tool.result',
        seq: ++this.seq,
        turn: this.turnNo,
        step,
        callId: e.toolCallId,
        isError: !!e.isError,
        time: Date.now(),
        content: [],
        text: out,
      })],
      { replay: false },
    )
  }

  private onUsage(u: any): void {
    const input = (u?.input ?? 0) + (u?.cacheRead ?? 0)
    const output = u?.output ?? 0
    // pi repeats the same usage on every message_update; emit only on change.
    const used = input + output
    if (used === this.lastUsage) return
    this.lastUsage = used
    this.emitLive(
      [ev({ type: 'context.usage', used, max: MODEL_CONTEXT_WINDOW })],
      { replay: false },
    )
  }

  private setStatus(status: 'idle' | 'running'): void {
    this.status = status
    this.emitLive([ev({ type: 'session.status', status })], { replay: false })
  }

  private emitLive(batch: AgentEvent[], meta: AgentEventMeta): void {
    for (const e of batch) this.historyEvents.push(e)
    if (this.listeners.size === 0) {
      this.earlyEvents.push(...batch)
      return
    }
    for (const l of this.listeners) l(batch, meta)
  }

  async history(): Promise<readonly AgentEvent[]> {
    return this.historyEvents
  }

  /** Seed history without re-emitting to live listeners. */
  private pushHistory(batch: AgentEvent[]): void {
    for (const e of batch) this.historyEvents.push(e)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    if (this.earlyEvents.length) {
      const flush = this.earlyEvents
      this.earlyEvents = []
      listener(flush, { replay: false })
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  async submit(input: AgentInput, _placement: SubmitPlacement): Promise<SubmitResult> {
    // One `pi` process per turn; refuse a second run against the same session.
    if (this.proc) return { accepted: false, reason: 'a turn is already running' }
    this.turnNo += 1
    this.toolSteps.clear()
    this.toolOutput.clear()
    this.curAttemptId = ''
    this.msgHasDeltas = false
    this.emitLive([ev({ type: 'turn.start', turn: this.turnNo, origin: 'user', time: Date.now() })], { replay: false })
    const text = input.text
    const cmid = input.clientMessageId
    this.emitLive(
      [ev({ type: 'user.message', id: cmid, anchor: '', seq: ++this.seq, turn: this.turnNo, time: Date.now(), source: 'user', text, blocks: [{ type: 'text', text }] })],
      { replay: false },
    )
    this.setStatus('running')
    await this.runPi(text)
    return { accepted: true }
  }

  private runPi(prompt: string): Promise<void> {
    return new Promise((resolve) => {
      const args = [
        '--mode', 'json',
        '--print',
        '--approve',
        '--thinking', 'low',
        '--session-id', this.piSessionId,
        '--session-dir', this.sessionDir,
        '--model', this.modelSpec,
        // End option parsing so a prompt starting with '-' is not read as a flag.
        '--',
        prompt,
      ]
      let proc: ChildProcessByStdio<null, Readable, Readable>
      try {
        // stdin must be an immediate-EOF stream: pi reads piped stdin when it is
        // not a TTY and would otherwise block forever waiting for input.
        proc = spawn('pi', args, { cwd: this.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        this.emitLive([ev({ type: 'session.status', status: 'error' as never })], { replay: false })
        this.endTurn()
        resolve()
        return
      }
      this.proc = proc
      proc.stdout.on('data', (chunk: Buffer) => this.onChunk(chunk.toString()))
      proc.stderr.on('data', () => {})
      proc.on('error', () => {
        this.endTurn()
        resolve()
      })
      proc.on('close', () => {
        this.proc = null
        this.endTurn()
        resolve()
      })
    })
  }

  private onChunk(s: string): void {
    this.buf += s
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      return
    }
    // Track incremental deltas so onMessageEnd does not double-emit.
    if (o?.type === 'message_update' && Array.isArray(o.changes)) {
      for (const ch of o.changes) {
        if (ch?.type === 'text_delta' || ch?.type === 'thinking_delta') this.msgHasDeltas = true
      }
    }
    this.onEvent(o)
  }

  private endTurn(): void {
    if (this.curAttemptId) this.closeAttempt()
    this.emitLive([ev({ type: 'turn.end', turn: this.turnNo, reason: { kind: 'completed' }, time: Date.now() })], { replay: false })
    this.setStatus('idle')
  }

  async cancel(_cause: CancelCause): Promise<CancelReceipt> {
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    return { stillQueued: [], outcome: 'confirmed' }
  }

  async dispose(): Promise<void> {
    this.status = 'disposed'
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    this.listeners.clear()
  }
}

export function piSessionPrefs(host: BackendHost) {
  const base = host.dataDir ?? join(host.cwd ?? process.cwd(), '.dsh-pi-cli')
  const file = join(base, 'pi', 'sessions.json')
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }
  const write = (obj: Record<string, string>): void => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(obj))
    } catch {
      /* non-fatal */
    }
  }
  return {
    lastSession(): string | undefined {
      return read().last
    },
    setLastSession(sessionId: string): void {
      const o = read()
      o.last = sessionId
      write(o)
    },
    touch(_sessionId: string): void {
      /* nothing to do */
    },
    forget(sessionId: string): void {
      const o = read()
      delete o[sessionId]
      if (o.last === sessionId) delete o.last
      write(o)
    },
  }
}
