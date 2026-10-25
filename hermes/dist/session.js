import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { AcpClient } from './acp-client.js';
const ev = (e) => e;
/** Pull text out of a Hermes content field (string, {text}, or array of {content:{text}}). */
function blockText(c) {
    if (c == null)
        return '';
    if (typeof c === 'string')
        return c;
    if (typeof c.text === 'string')
        return c.text;
    if (Array.isArray(c.content))
        return c.content.map(blockText).join('');
    if (Array.isArray(c))
        return c.map(blockText).join('');
    return '';
}
/**
 * A live Hermes session over ACP, projected into dsh-tui's AgentSession.
 * Maps hermes-acp's `session/update` stream (thought / text / tool / usage /
 * commands / title) onto the AgentEvent vocabulary the channel renders.
 */
export class HermesSession {
    target;
    host;
    _ref;
    cwd;
    get ref() { return this._ref; }
    status = 'starting';
    /** `models` is what makes dst offer `/model`: without it the command is
     *  refused as backend-unavailable and the picker never opens. */
    capabilities = {
        native: {},
        models: {
            list: async () => this.availableModels.map(model => ({
                provider: 'hermes',
                id: model.modelId,
                label: model.name ?? model.modelId,
                ...(model.description === undefined ? {} : { description: model.description }),
            })),
            current: () => ({ provider: 'hermes', model: this.model }),
            set: async (ref) => {
                // The picker sends the ACP id whole; a typed `/model provider/id`
                // arrives split, and Hermes spells that same row `provider:id`.
                const wanted = this.availableModels.find(model => model.modelId === ref.model)
                    ?? (ref.provider === undefined || ref.provider === 'hermes'
                        ? undefined
                        : this.availableModels.find(model => model.modelId === `${ref.provider}:${ref.model}`));
                if (wanted === undefined)
                    return { kind: 'refused', reason: `unknown model: ${ref.provider === undefined ? '' : `${ref.provider}/`}${ref.model}` };
                try {
                    await this.client.setModel(this.sessionId, wanted.modelId);
                }
                catch (error) {
                    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) };
                }
                this.model = wanted.modelId;
                this.currentModelId = wanted.modelId;
                this.emit([ev({ type: 'model.changed', model: wanted.modelId, provider: 'hermes', source: 'user' })], { replay: false });
                return { kind: 'switched' };
            },
            display: () => {
                const row = this.availableModels.find(model => model.modelId === this.currentModelId);
                return row?.name === undefined || row.name === this.model ? undefined : row.name;
            },
        },
    };
    client;
    sessionId = '';
    listeners = new Set();
    historyEvents = [];
    // Events emitted before the first subscriber attaches (e.g. session.ready
    // during start()); flushed to the first subscriber so nothing is lost.
    earlyEvents = [];
    // Per-turn stream state.
    seq = 0;
    turnNo = 0;
    stepNo = 0;
    curAttemptId = '';
    attemptSteps = new Map();
    attemptsThisTurn = new Set();
    toolSteps = new Map();
    /** The choice id the session runs (`deepseek:deepseek-flash`), as Hermes
     *  spells it back in `currentModelId`. */
    model = '';
    /** Hermes' `currentModelId`: set on load too, where `model` is not. */
    currentModelId = '';
    /** The catalog the last `session/new` / `session/load` reported. */
    availableModels = [];
    constructor(target, host) {
        this.target = target;
        this.host = host;
        this.cwd = target.kind === 'resume' ? (target.cwd ?? host.cwd) : host.cwd;
        this._ref = { backendId: 'hermes', sessionId: target.kind === 'resume' ? target.sessionId : '' };
        this.client = new AcpClient(undefined, this.cwd);
        this.client.on('update', (u) => this.onUpdate(u));
    }
    async start() {
        await this.client.initialize();
        if (this.target.kind === 'resume') {
            try {
                const r = await this.client.loadSession(this.target.sessionId, this.cwd);
                this.sessionId = r?.sessionId ?? this.target.sessionId;
                this.adoptModels(r);
            }
            catch (error) {
                this.host.debug(`hermes: session/load failed (${error instanceof Error ? error.message : String(error)}); starting a new session`);
                const r = await this.client.newSession(this.cwd);
                this.sessionId = r.sessionId;
                this.adoptModels(r);
            }
        }
        else {
            const r = await this.client.newSession(this.cwd);
            this.sessionId = r.sessionId;
            this.adoptModels(r);
            // A fresh session starts on Hermes' own configured route; only a
            // catalog that names no current model needs the deepseek default.
            const wanted = this.currentModelId !== ''
                ? undefined
                : (this.availableModels.find(m => m.modelId.startsWith('deepseek:')) ?? this.availableModels[0])?.modelId;
            if (wanted !== undefined) {
                await this.client.setModel(this.sessionId, wanted);
                this.model = wanted;
                this.currentModelId = wanted;
            }
            else {
                this.model = this.currentModelId;
            }
        }
        this._ref = { backendId: 'hermes', sessionId: this.sessionId };
        this.status = 'idle';
        this.emit([ev({
                type: 'session.ready',
                sessionId: this.sessionId,
                cwd: this.cwd,
                model: this.model || 'hermes',
                provider: 'hermes',
            })], { replay: false });
    }
    /** Take the model catalog and current model off a session reply. */
    adoptModels(r) {
        this.availableModels = r?.models?.availableModels ?? [];
        this.currentModelId = r?.models?.currentModelId ?? '';
        if (this.currentModelId !== '')
            this.model = this.currentModelId;
        this.host.debug(`hermes: ${this.availableModels.length} models, current ${this.currentModelId || '(none)'}`);
    }
    onUpdate(u) {
        const kind = u?.sessionUpdate;
        if (!kind)
            return;
        const t = Date.now();
        switch (kind) {
            case 'available_commands_update': {
                const commands = ((u.availableCommands) ?? []).map((c) => ({
                    name: c.name,
                    description: c.description,
                    argumentHint: c.input,
                }));
                this.emit([ev({ type: 'commands.changed', commands })], { replay: false });
                return;
            }
            case 'session_info_update': {
                const title = u.title;
                if (title)
                    this.emit([ev({ type: 'session.title', title, source: 'auto' })], { replay: false });
                return;
            }
            case 'usage_update': {
                const used = u.used ?? 0;
                const max = u.size;
                this.emit([ev(max !== undefined
                        ? { type: 'context.usage', used, max }
                        : { type: 'context.usage', used })], { replay: false });
                return;
            }
            case 'agent_thought_chunk':
            case 'agent_message_chunk': {
                const text = blockText(u.content);
                if (!text)
                    return;
                const isText = kind === 'agent_message_chunk';
                if (!this.curAttemptId) {
                    this.stepNo += 1;
                    this.curAttemptId = `att${this.turnNo}_${this.stepNo}`;
                    this.attemptSteps.set(this.curAttemptId, this.stepNo);
                    this.attemptsThisTurn.add(this.curAttemptId);
                    this.emit([ev({
                            type: 'assistant.attempt.start',
                            attemptId: this.curAttemptId,
                            turn: this.turnNo,
                            step: this.stepNo,
                            ...(this.model ? { model: this.model } : {}),
                        })], { replay: false });
                }
                this.emit([ev({
                        type: 'assistant.delta',
                        attemptId: this.curAttemptId,
                        index: 0,
                        time: t,
                        turn: this.turnNo,
                        step: this.stepNo,
                        delta: { kind: isText ? 'text' : 'reasoning', text },
                    })], { replay: false });
                return;
            }
            case 'tool_call': {
                this.stepNo += 1;
                const callId = u.toolCallId;
                this.toolSteps.set(callId, this.stepNo);
                const title = u.title ?? 'tool';
                const name = title.includes(':') ? title.slice(0, title.indexOf(':')).trim() : title;
                this.emit([ev({
                        type: 'tool.call',
                        seq: ++this.seq,
                        anchor: '',
                        turn: this.turnNo,
                        step: this.stepNo,
                        callId,
                        name,
                        argsJson: blockText(u.content),
                        time: t,
                    })], { replay: false });
                // A tool call closes the current reasoning/text attempt so that any
                // text emitted after the tool opens a fresh step and renders below it.
                this.curAttemptId = '';
                return;
            }
            case 'tool_call_update': {
                if (u.content === undefined)
                    return;
                const callId = u.toolCallId;
                const step = this.toolSteps.get(callId) ?? (this.stepNo += 1);
                const text = blockText(u.content);
                const status = u.status;
                const isError = status !== undefined && status !== 'completed' && status !== 'success';
                this.emit([ev({
                        type: 'tool.result',
                        seq: ++this.seq,
                        turn: this.turnNo,
                        step,
                        callId,
                        isError,
                        time: t,
                        content: [{ type: 'text', text }],
                        text,
                    })], { replay: false });
                return;
            }
        }
    }
    emit(batch, meta) {
        for (const e of batch)
            this.historyEvents.push(e);
        if (this.listeners.size === 0) {
            this.earlyEvents.push(...batch);
            return;
        }
        for (const l of this.listeners)
            l(batch, meta);
    }
    async history() {
        return this.historyEvents;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        if (this.earlyEvents.length) {
            const flush = this.earlyEvents;
            this.earlyEvents = [];
            listener(flush, { replay: false });
        }
        return () => { this.listeners.delete(listener); };
    }
    async submit(input, _placement) {
        this.turnNo += 1;
        this.stepNo = 0;
        this.curAttemptId = '';
        this.attemptSteps.clear();
        this.attemptsThisTurn.clear();
        this.toolSteps.clear();
        const t = Date.now();
        this.status = 'running';
        this.emit([
            ev({ type: 'session.status', status: 'running' }),
            ev({ type: 'turn.start', turn: this.turnNo, origin: 'user', userMessageId: input.clientMessageId, time: t }),
            ev({
                type: 'user.message',
                id: input.clientMessageId,
                anchor: '',
                seq: ++this.seq,
                turn: this.turnNo,
                time: t,
                source: 'user',
                text: input.text,
                blocks: [{ type: 'text', text: input.text }],
            }),
        ], { replay: false });
        await this.client.prompt(this.sessionId, input.text);
        for (const aid of this.attemptsThisTurn) {
            this.emit([ev({
                    type: 'assistant.attempt.end',
                    attemptId: aid,
                    outcome: 'committed',
                    turn: this.turnNo,
                    step: this.attemptSteps.get(aid) ?? this.stepNo,
                })], { replay: false });
        }
        this.emit([ev({ type: 'turn.end', turn: this.turnNo, reason: { kind: 'completed' }, time: Date.now() })], { replay: false });
        this.status = 'idle';
        this.emit([ev({ type: 'session.status', status: 'idle' })], { replay: false });
        return { accepted: true };
    }
    async cancel(_cause) {
        await this.client.cancel(this.sessionId);
        return { stillQueued: [], outcome: 'confirmed' };
    }
    async dispose() {
        this.status = 'disposed';
        this.client.dispose();
    }
}
/** File-backed BackendSessionPrefs under the host's data directory. */
export function hermesSessionPrefs(host) {
    const file = host.dataDir ? join(host.dataDir, 'sessions.json') : join(host.cwd, '.hermes-dsh-prefs.json');
    const read = () => {
        try {
            return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
        }
        catch {
            return {};
        }
    };
    const write = (data) => {
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify(data, null, 2));
        }
        catch { /* best effort */ }
    };
    return {
        lastSession: () => read().lastSession,
        setLastSession: (sessionId) => write({ ...read(), lastSession: sessionId }),
        touch: (sessionId) => write({ ...read(), lastSession: sessionId }),
        forget: (sessionId) => { const d = read(); if (d.lastSession === sessionId)
            delete d.lastSession; write(d); },
    };
}
