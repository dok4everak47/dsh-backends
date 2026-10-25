import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
/**
 * Minimal ACP (Agent Client Protocol) stdio client: newline-delimited
 * JSON-RPC 2.0, the exact framing Hermes' `hermes-acp` speaks. It is the
 * only piece that touches the wire; everything else maps ACP into dsh-tui's
 * `AgentEvent` vocabulary.
 */
export class AcpClient extends EventEmitter {
    child;
    rl;
    nextId = 1;
    pending = new Map();
    stderrLines = [];
    constructor(bin = homedir() + '/.local/bin/hermes-acp', cwd = process.cwd()) {
        super();
        this.child = spawn(bin, [], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
        this.child.stderr?.on('data', (d) => {
            this.stderrLines.push(d.toString());
            this.emit('stderr', d.toString());
        });
        this.rl = createInterface({ input: this.child.stdout });
        this.rl.on('line', (line) => this.onLine(line));
        this.child.on('exit', (code) => this.emit('exit', code));
    }
    onLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return;
        }
        // Server -> client response.
        if (msg.id !== undefined && !msg.method) {
            const p = this.pending.get(msg.id);
            if (p) {
                this.pending.delete(msg.id);
                // Hermes explains refusals in `error.message` (a busy session, a model
                // no provider serves); keep those words rather than the JSON envelope.
                if (msg.error)
                    p.reject(new Error(typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error)));
                else
                    p.resolve(msg.result);
            }
            return;
        }
        // Notification: a streamed session update.
        if (msg.method === 'session/update') {
            this.emit('update', (msg.params?.update ?? msg.params));
            return;
        }
        // Server -> client request (permissions, fs, terminal...).
        if (msg.id !== undefined && msg.method)
            this.handleRequest(msg);
    }
    handleRequest(msg) {
        if (msg.method === 'session/request_permission') {
            const options = msg.params?.options ?? [];
            const pick = options.find((o) => String(o.kind ?? '').startsWith('allow')) ?? options[0];
            this.emit('permission', {
                requestId: String(msg.id),
                toolName: msg.params?.toolCall?.title ?? '',
                callId: msg.params?.toolCall?.toolCallId,
            });
            this.respond(msg.id, pick
                ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
                : { outcome: { outcome: 'cancelled' } });
            return;
        }
        // Generic acknowledgement for any other request we do not act on.
        this.respond(msg.id, {});
    }
    respond(id, result) {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    }
    request(method, params, timeoutMs = 180000) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(method + ' timed out'));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(t); resolve(v); },
                reject: (e) => { clearTimeout(t); reject(e); },
            });
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    initialize(clientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }) {
        return this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities,
            clientInfo: { name: 'dsh-hermes', version: '0.0.1' },
        }, 30000);
    }
    newSession(cwd) {
        return this.request('session/new', { cwd, mcpServers: [] }, 90000);
    }
    loadSession(sessionId, cwd) {
        return this.request('session/load', { sessionId, cwd, mcpServers: [] }, 90000);
    }
    /** Rejects with Hermes' own words: a refusal must reach the picker, not vanish. */
    setModel(sessionId, modelId) {
        return this.request('session/set_model', { sessionId, modelId }, 60000);
    }
    prompt(sessionId, text) {
        return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 300000);
    }
    cancel(sessionId) {
        return this.request('session/cancel', { sessionId }, 30000).catch(() => undefined);
    }
    dispose() {
        try {
            this.child.stdin?.end();
            this.child.kill();
        }
        catch { /* ignore */ }
    }
}
