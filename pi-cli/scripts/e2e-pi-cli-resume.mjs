import { backend } from '../dist/register.js'

const host = {
  cwd: '/tmp',
  dataDir: '/tmp/pi-cli-resume',
  locale: () => 'en',
  debug: () => {},
  warn: () => {},
  appVersion: 'e2e-resume',
}

// Turn 1: create a session and run one prompt that uses a tool.
const first = await backend.open({ kind: 'create', cwd: '/tmp' }, host)
const sid = first.sessionId
const live = []
first.subscribe((batch) => { for (const e of batch) live.push(e) })
await first.submit({
  text: 'Use the Read tool to read /tmp/pi-cli-resume-input.txt, then reply with exactly its first word.',
  clientMessageId: 'r-1',
}, 'turn')
const t0 = Date.now()
while (Date.now() - t0 < 60000) {
  if (live.some((e) => e.type === 'turn.end')) break
  await new Promise((r) => setTimeout(r, 250))
}
console.log('turn 1 text:', JSON.stringify(live.filter((e) => e.type === 'assistant.delta' && e.delta.kind === 'text').map((e) => e.delta.text).join('')))
await first.dispose()
console.log('session id:', sid)

// Turn 2: reopen the same session and check that history() replays turn 1.
const second = await backend.open({ kind: 'resume', sessionId: sid, cwd: '/tmp' }, host)
const hist = await second.history()
const types = hist.map((e) => e.type)
const counts = {}
for (const t of types) counts[t] = (counts[t] ?? 0) + 1
console.log('replayed history types:', JSON.stringify(counts))
console.log('replayed user text:', JSON.stringify(hist.filter((e) => e.type === 'user.message').map((e) => e.text)))
console.log('replayed tool calls:', JSON.stringify(hist.filter((e) => e.type === 'tool.call').map((e) => e.name)))
console.log('replayed assistant text:', JSON.stringify(hist.filter((e) => e.type === 'assistant.delta' && e.delta.kind === 'text').map((e) => e.delta.text).join('')))

const ok = types.includes('user.message') && types.includes('tool.call') && types.includes('tool.result') && types.includes('assistant.delta')
console.log('RESUME', ok ? 'PASS' : 'FAIL')

// Turn 3: continue inside the resumed session; the new turn must not collide.
const live2 = []
second.subscribe((batch) => { for (const e of batch) live2.push(e) })
await second.submit({ text: 'Reply with exactly: continued', clientMessageId: 'r-2' }, 'turn')
const t1 = Date.now()
while (Date.now() - t1 < 60000) {
  if (live2.some((e) => e.type === 'turn.end')) break
  await new Promise((r) => setTimeout(r, 250))
}
const turnNos = live2.filter((e) => e.type === 'turn.start').map((e) => e.turn)
const contText = live2.filter((e) => e.type === 'assistant.delta' && e.delta.kind === 'text').map((e) => e.delta.text).join('')
console.log('continuation turn numbers:', JSON.stringify(turnNos))
console.log('continuation text:', JSON.stringify(contText))
const contOk = turnNos.length === 1 && turnNos[0] === 2 && contText.length > 0
console.log('CONTINUE', contOk ? 'PASS' : 'FAIL')
await second.dispose()
process.exit(ok && contOk ? 0 : 1)
