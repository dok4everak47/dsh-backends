import { backend } from '../dist/register.js'

const fakeHost = {
  cwd: process.cwd(),
  dataDir: '/tmp/hermes-e2e-host',
  locale: () => 'en',
  debug: () => {},
  warn: () => {},
}

const captured = []
const session = await backend.open({ kind: 'create', cwd: process.cwd() }, fakeHost)
console.log('opened session ref =', JSON.stringify(session.ref), 'status =', session.status)
session.subscribe((batch) => {
  for (const e of batch) captured.push(e.type)
})

const res = await session.submit({ text: 'Reply with exactly one word: HI', clientMessageId: 'c1' }, undefined)
console.log('submit result =', JSON.stringify(res))

// Wait a tick for tail events.
await new Promise(r => setTimeout(r, 500))
session.dispose()

const tally = {}
for (const t of captured) tally[t] = (tally[t] ?? 0) + 1
console.log('\nCaptured event types (count):')
for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`)
const want = ['session.ready', 'turn.start', 'user.message', 'assistant.attempt.start', 'assistant.delta', 'assistant.attempt.end', 'turn.end']
const missing = want.filter(w => !(w in tally))
console.log('\nMissing core events:', missing.length ? missing.join(', ') : 'none')
console.log('session.ready delivered (buffering works):', 'session.ready' in tally)
console.log('total events:', captured.length)
