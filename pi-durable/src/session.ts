import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  createModels,
  createProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  AssistantEntry,
  Harness,
  createRegistry,
  watchEvents,
  type AgentEvent as PiEvent,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
  CodingTools,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
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
import { readPiCatalog, readPiProviders } from './catalog-models.js'

const CTX = BACKGROUND_CONTEXT
const MODEL_CONTEXT_WINDOW = 1_000_000

// magpie is the local gateway (http://127.0.0.1:3425). Every provider pi's own
// models.json declares is installed, so every route the picker lists streams;
// PI_PROVIDER / PI_MODEL only choose the one a new session starts on.
if (!process.env.PI_API_KEY) process.env.PI_API_KEY = 'magpie'

function piConfig() {
  return {
    provider: process.env.PI_PROVIDER ?? 'magpie',
    modelId: process.env.PI_MODEL ?? 'auto/deepseek-v4.1-flash',
    baseUrl: process.env.PI_BASE_URL ?? 'http://127.0.0.1:3425/v1',
  }
}

type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void
type SubmitResult = { readonly accepted: boolean; readonly reason?: string }

function ev(e: Record<string, unknown>): AgentEvent {
  return e as unknown as AgentEvent
}

function buildModels(route: { provider: string; modelId: string }, warn: (message: string) => void) {
  const cfg = piConfig()
  const blocks = readPiProviders()
  const catalog = readPiCatalog()
  const models = createModels()
  // One provider per block pi's models.json declares: a route the picker lists
  // must have a provider behind it, or the switch would name a model nothing
  // can stream.
  for (const [id, block] of blocks) {
    const rows = (block.models ?? []).filter(model => typeof model.id === 'string' && model.id !== '')
    if (rows.length === 0) continue
    const baseUrl = block.baseUrl ?? cfg.baseUrl
    models.setProvider(createProvider({
      id,
      name: 'Pi Model Gateway',
      baseUrl,
      auth: { apiKey: envApiKeyAuth('pi', ['PI_API_KEY']) } as never,
      // The user's own `pi` route, provider names aside: whatever works there
      // works here, so no capability is invented and none removed.
      models: (rows as readonly { id: string; name?: string }[]).map(model => ({
        id: model.id,
        name: model.name ?? model.id,
        api: 'openai-completions',
        provider: id,
        baseUrl,
        reasoning: true,
        input: ['text'],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
        contextWindow: MODEL_CONTEXT_WINDOW,
        maxTokens: 200_000,
      })),
      api: openAICompletionsApi(),
    }))
  }
  // A route the catalog does not name would fail on the first request; say so
  // now, while the session can still fall back to a row that exists.
  if (models.getModel(cfg.provider, route.modelId) === undefined) {
    const fallback = catalog[0]
    if (fallback === undefined) {
      throw new Error(`pi-durable: no model in ${join(homedir(), '.pi', 'agent', 'models.json')} can be streamed`)
    }
    warn(`pi-durable: model ${cfg.provider}/${route.modelId} is not in pi's catalog; using ${fallback.provider}/${fallback.id}`)
    route.provider = fallback.provider
    route.modelId = fallback.id
  }
  return models
}

export class PiSession implements AgentSession {
  readonly backendId = 'pi'
  readonly ref: { backendId: string; sessionId: string }
  readonly cwd: string
  /** `models` is what makes dst offer `/model`; without it the command is
   *  refused as backend-unavailable and no picker opens. */
  readonly capabilities: SessionCapabilities = {
    native: {},
    models: {
      // The catalog is re-read per listing, so a route added to pi's own
      // models.json shows up without restarting the session.
      list: async () => readPiCatalog().map(model => ({
        provider: model.provider,
        id: model.id,
        label: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
      current: () => ({ provider: this.providerId, model: this.modelId }),
      set: async ref => {
        if (this.root === null) return { kind: 'refused', reason: 'the session is not open yet' }
        const rows = readPiCatalog()
        const row = ref.provider === undefined || ref.provider === ''
          ? rows.find(model => model.provider === this.providerId && model.id === ref.model)
            ?? rows.find(model => model.id === ref.model)
          : rows.find(model => model.provider === ref.provider && model.id === ref.model)
        if (row === undefined) return { kind: 'refused', reason: `unknown model: ${ref.provider ?? ''}/${ref.model}` }
        try {
          // The harness rebuilds the provider from its own registry, so the
          // switch rides the conversation's agent document, not a new process.
          await this.root.configure({ model: { provider: row.provider, modelId: row.id } }, CTX)
        } catch (error) {
          return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
        }
        this.providerId = row.provider
        this.modelId = row.id
        this.emitLive(
          [ev({ type: 'model.changed', model: row.id, provider: row.provider, source: 'user' })],
          { replay: false },
        )
        return { kind: 'switched' }
      },
      display: () => {
        const row = readPiCatalog().find(model => model.provider === this.providerId && model.id === this.modelId)
        return row?.name === undefined || row.name === this.modelId ? undefined : row.name
      },
    },
  }
  status: 'starting' | 'idle' | 'running' | 'requires-action' | 'disposed' = 'starting'

  private host: BackendHost
  private sessionId: string
  private storagePath: string
  private harness: Harness | null = null
  private root: any = null
  private listeners = new Set<Listener>()
  private historyEvents: AgentEvent[] = []
  private earlyEvents: AgentEvent[] = []
  private seq = 0
  private turnNo = 0
  private stepNo = 0
  private curAttemptId = ''
  private msgHasDeltas = false
  private lastBatchSig = ''
  private toolSteps = new Map<string, number>()
  private toolOutput = new Map<string, string>()
  private _resume: boolean
  private modelId = ''
  private providerId = ''
  constructor(target: OpenTarget, host: BackendHost) {
    this.host = host
    this.cwd = (target as { cwd?: string }).cwd ?? host.cwd ?? process.cwd()
    const isResume = (target as { kind: string }).kind === 'resume'
    this._resume = isResume
    if (isResume) {
      this.sessionId = (target as { sessionId: string }).sessionId
    } else {
      this.sessionId = randomUUID()
    }
    const base = host.dataDir ?? join(this.cwd, '.dsh-pi-sessions')
    mkdirSync(base, { recursive: true })
    this.storagePath = join(base, 'pi', `${this.sessionId}.sqlite`)
    if (isResume && !existsSync(this.storagePath)) {
      throw new Error(`No Pi session found for ${this.sessionId}`)
    }
    this.ref = { backendId: 'pi', sessionId: this.sessionId }
  }

  async start(): Promise<void> {
    const cfg = piConfig()
    const route = { provider: cfg.provider, modelId: cfg.modelId }
    const storage = await openNodeSqliteStorage(this.storagePath)
    const registry = createRegistry()
    registry.install(CodingTools)
    const harness = await Harness.open(
      storage,
      {
        models: buildModels(route, message => this.host.warn(message)),
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? this.cwd }),
      },
      CTX,
    )
    harness.resume()
    this.harness = harness
    // `buildModels` may have moved the route onto a row the catalog names.
    this.modelId = route.modelId
    this.providerId = route.provider

    if (this._resume) {
      this.root = await harness.root(CTX)
    } else {
      this.root = await harness.root(CTX, {
        agent: {
          model: { provider: route.provider, modelId: route.modelId },
          thinkingLevel: 'low',
          cwd: this.cwd,
          tools: [createReadTool(), createEditTool(), createWriteTool(), createBashTool()],
        },
      })
    }

    const stream = await watchEvents(harness, this.root.id, CTX)
    // Snapshot is available synchronously; seed history before open resolves.
    this.onSnapshot(stream.snapshot)
    stream.start(async (events) => {
      for (const e of events) this.onEvents(events)
    })

    this.status = 'idle'
    this.emitLive(
      [ev({ type: 'session.ready', sessionId: this.sessionId, cwd: this.cwd, model: this.modelId, provider: this.providerId })],
      { replay: false },
    )
    this.setStatus('idle')
  }

  // --- translation of pi-durable events ---

  private onEvents(events: readonly PiEvent[]): void {
    // pi-durable re-delivers an identical batch several times; skip repeats.
    const sig = this.batchSignature(events)
    if (sig === this.lastBatchSig) return
    this.lastBatchSig = sig
    for (const e of events) {
      const t = (e as { type: string }).type
      if (t === 'snapshot') {
        // handled synchronously in start()
      } else if (t === 'message_start') {
        this.msgHasDeltas = false
      } else if (t === 'message_update') {
        const upd = e as unknown as { changes: any[] }
        for (const ch of upd.changes) this.onChange(ch)
      } else if (t === 'tool_execution_start') {
        this.onToolStart(e as unknown as { toolCallId: string; toolName: string; args?: any })
      } else if (t === 'tool_execution_update') {
        this.onToolUpdate(e as unknown as { toolCallId: string; output?: any })
      } else if (t === 'tool_execution_end') {
        this.onToolEnd(e as unknown as { toolCallId: string; entry?: unknown })
      } else if (t === 'message_end') {
        this.onMessageEnd(e)
      } else if (t === 'run_end') {
        this.emitLive([ev({ type: 'turn.end', turn: this.turnNo, reason: { kind: 'completed' }, time: Date.now() })], { replay: false })
        this.setStatus('idle')
      } else if (t === 'usage_changed') {
        this.emitUsageState((e as unknown as { usage: any }).usage)
      }
    }
  }

  /**
   * Identity of one delivered batch. pi-durable hands the same batch to the
   * listener more than once, so consecutive identical batches are repeats.
   */
  private batchSignature(events: readonly PiEvent[]): string {
    return events
      .map((e: any) => {
        const id = e?.entry?.id ?? e?.toolCallId ?? e?.record?.id ?? e?.inputs?.join?.(',') ?? ''
        return `${e?.type}#${id}`
      })
      .join('|')
  }

  private openIfNeeded(): void {
    if (this.curAttemptId) return
    this.stepNo += 1
    this.curAttemptId = `att${this.turnNo}_${this.stepNo}`
    this.emitLive(
      [ev({ type: 'assistant.attempt.start', attemptId: this.curAttemptId, turn: this.turnNo, step: this.stepNo, model: this.modelId })],
      { replay: false },
    )
  }

  private onChange(ch: any): void {
    if (ch.type === 'thinking_start' || ch.type === 'text_start') {
      this.openIfNeeded()
    } else if (ch.type === 'thinking_delta') {
      this.openIfNeeded()
      this.msgHasDeltas = true
      this.emitLive(
        [ev({ type: 'assistant.delta', attemptId: this.curAttemptId, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'reasoning', text: ch.delta } })],
        { replay: false },
      )
    } else if (ch.type === 'text_delta') {
      this.openIfNeeded()
      this.msgHasDeltas = true
      this.emitLive(
        [ev({ type: 'assistant.delta', attemptId: this.curAttemptId, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'text', text: ch.delta } })],
        { replay: false },
      )
    }
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
    let next = cur
    const o = e.output
    if (o) {
      if ('set' in o && o.set !== undefined) {
        next = o.set as string
      } else {
        if (typeof o.trimStart === 'number') next = next.slice(o.trimStart)
        if (typeof o.append === 'string') next += o.append
      }
    }
    this.toolOutput.set(e.toolCallId, next)
  }

  private onToolEnd(e: { toolCallId: string; entry?: any }): void {
    const step = this.toolSteps.get(e.toolCallId) ?? this.stepNo
    // pi-durable carries the tool result as an entry whose model[0] is the
    // toolResult message; tool_execution_update is not guaranteed to fire.
    const msg = e.entry?.model?.[0]
    const blocks: any[] = Array.isArray(msg?.content) ? msg.content : []
    const fromEntry = blocks
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
    const out = fromEntry || this.toolOutput.get(e.toolCallId) || ''
    const isError = msg?.role === 'toolResult' ? !!msg.isError : !e.entry
    this.emitLive(
      [ev({
        type: 'tool.result',
        seq: ++this.seq,
        turn: this.turnNo,
        step,
        callId: e.toolCallId,
        isError,
        time: Date.now(),
        content: [],
        text: out,
      })],
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
    // pi-durable delivers the full message entry at message_end (not incremental
    // message_update deltas). Extract text/reasoning from the assistant entry. If
    // message_update deltas already streamed, they took care of emission.
    if (this.msgHasDeltas) return
    const msg = (e?.entry?.model ?? []).find((m: any) => m?.role === 'assistant')
    if (!msg) return
    const blocks: any[] = Array.isArray(msg.content) ? msg.content : []
    const text = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
    const thinking = blocks.filter((b: any) => b?.type === 'thinking' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
    if (!text && !thinking) return // toolCall-only or empty; tool_execution handles calls
    this.openIfNeeded()
    const att = this.curAttemptId
    if (thinking) this.emitLive([ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'reasoning', text: thinking } })], { replay: false })
    if (text) this.emitLive([ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'text', text } })], { replay: false })
    this.closeAttempt()
  }

  private onSnapshot(snap: any): void {
    let hTurn = this.turnNo
    let hStep = 0
    const entries: any[] = snap?.entries ?? []
    for (const entry of entries) {
      const rec = entry?.record ?? entry
      const model = rec?.model
      if (!Array.isArray(model)) continue
      // A stored user message keeps its content as a plain string, while
      // assistant/toolResult entries hold content blocks.
      const msg = model[0]
      if (!msg) continue
      const role = msg.role
      const content = msg.content
      const blocks: any[] = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
      const texts = (kind: string): string =>
        blocks.filter((b: any) => b?.type === kind && typeof b.text === 'string').map((b: any) => b.text).join('\n')

      if (role === 'user') {
        hTurn += 1
        hStep = 0
        const text = texts('text')
        this.pushHistory([
          ev({ type: 'turn.start', turn: hTurn, origin: 'user', time: Date.now() }),
          ev({ type: 'user.message', id: `h-u-${hTurn}`, anchor: '', seq: ++this.seq, turn: hTurn, time: Date.now(), source: 'user', text, blocks: [{ type: 'text', text }] }),
        ])
        continue
      }

      if (role === 'assistant') {
        for (const tc of blocks.filter((b: any) => b?.type === 'toolCall')) {
          hStep += 1
          this.pushHistory([
            ev({
              type: 'tool.call',
              seq: ++this.seq,
              turn: hTurn,
              step: hStep,
              callId: tc.id,
              name: tc.name,
              argsJson: JSON.stringify(tc.arguments ?? {}),
              time: Date.now(),
            }),
          ])
          this.toolSteps.set(tc.id, hStep)
        }
        const text = texts('text')
        const thinking = texts('thinking')
        if (!text && !thinking) continue
        hStep += 1
        const att = `h-att-${hTurn}-${hStep}`
        const steps: AgentEvent[] = [ev({ type: 'assistant.attempt.start', attemptId: att, turn: hTurn, step: hStep, model: this.modelId })]
        if (thinking) steps.push(ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: hTurn, step: hStep, delta: { kind: 'reasoning', text: thinking } }))
        if (text) steps.push(ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: hTurn, step: hStep, delta: { kind: 'text', text } }))
        steps.push(ev({ type: 'assistant.attempt.end', attemptId: att, turn: hTurn, step: hStep, outcome: 'committed' }))
        this.pushHistory(steps)
        continue
      }

      if (role === 'toolResult') {
        const step = this.toolSteps.get(msg.toolCallId) ?? hStep
        const out = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('')
        this.pushHistory([
          ev({ type: 'tool.result', seq: ++this.seq, turn: hTurn, step, callId: msg.toolCallId, isError: !!msg.isError, time: Date.now(), content: [], text: out }),
        ])
      }
    }
    if (hTurn > this.turnNo) this.turnNo = hTurn
    if (hStep > this.stepNo) this.stepNo = hStep
  }

  private emitUsageState(state: any): void {
    let input = 0
    let output = 0
    const models = state?.models ?? {}
    for (const u of Object.values(models) as any[]) {
      input += (u?.input ?? 0) + (u?.cacheRead ?? 0)
      output += u?.output ?? 0
    }
    this.emitLive(
      [ev({ type: 'context.usage', used: input + output, max: MODEL_CONTEXT_WINDOW })],
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

  private pushHistory(batch: AgentEvent[]): void {
    for (const e of batch) this.historyEvents.push(e)
  }

  async history(): Promise<readonly AgentEvent[]> {
    return this.historyEvents
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
    this.turnNo += 1
    this.toolSteps.clear()
    this.toolOutput.clear()
    this.curAttemptId = ''
    this.emitLive([ev({ type: 'turn.start', turn: this.turnNo, origin: 'user', time: Date.now() })], { replay: false })
    const text = input.text
    const cmid = input.clientMessageId
    this.emitLive(
      [ev({ type: 'user.message', id: cmid, anchor: '', seq: ++this.seq, turn: this.turnNo, time: Date.now(), source: 'user', text, blocks: [{ type: 'text', text }] })],
      { replay: false },
    )
    this.setStatus('running')
    try {
      const submission = await this.root.submit({ type: 'input', content: text, requestId: cmid }, CTX)
      const settled = await submission.wait(CTX)
      if (settled?.status === 'done' && settled?.type === 'input') {
        await this.root.commit((tx: any) => tx.entry(AssistantEntry, settled.answer), CTX)
      }
      if (this.curAttemptId) this.closeAttempt()
      this.setStatus('idle')
    } catch (err) {
      this.setStatus('idle')
      throw err
    }
    return { accepted: true }
  }

  async cancel(_cause: CancelCause): Promise<CancelReceipt> {
    if (this.root) {
      await this.root.abort(CTX).catch(() => {})
      this.setStatus('idle')
    }
    return { stillQueued: [], outcome: 'confirmed' }
  }

  async dispose(): Promise<void> {
    this.status = 'disposed'
    if (this.harness) {
      this.harness.close(CTX).catch(() => {})
      this.harness = null
    }
    this.listeners.clear()
  }
}

export function piSessionPrefs(host: BackendHost) {
  const base = host.dataDir ?? join(host.cwd ?? process.cwd(), '.dsh-pi-sessions')
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
