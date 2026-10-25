import { backend, manifest } from '../dist/register.js'

const host = {
  cwd: '/tmp',
  dataDir: '/tmp/pi-cli-e2e',
  locale: () => 'en',
  debug: () => {},
  warn: () => {},
  appVersion: 'e2e',
}

const session = await backend.open({ kind: 'create', cwd: '/tmp' }, host)
const events = []
session.subscribe((batch) => {
  for (const e of batch) events.push(e)
})

console.log('submitting...')
const res = await session.submit({
  text: "Use the Read tool to read /tmp/pi-cli-e2e-input.txt, then reply with exactly its first word.",
  clientMessageId: 'e2e-1',
}, 'turn')
console.log('submit result:', JSON.stringify(res))

const start = Date.now()
while (Date.now() - start < 60000) {
  if (events.some((e) => e.type === 'turn.end')) break
  await new Promise((r) => setTimeout(r, 250))
}

const types = events.map((e) => e.type)
const toolCalls = events.filter((e) => e.type === 'tool.call').map((e) => e.name)
const textDeltas = events.filter((e) => e.type === 'assistant.delta' && e.delta.kind === 'text').map((e) => e.delta.text).join('')
const reasoningDeltas = events.filter((e) => e.type === 'assistant.delta' && e.delta.kind === 'reasoning').length

console.log('event types:', JSON.stringify([...new Set(types)]))
console.log('tool calls:', JSON.stringify(toolCalls))
console.log('reasoning deltas:', reasoningDeltas)
console.log('text produced:', JSON.stringify(textDeltas.slice(0, 300)))

const ok = types.includes('session.ready') && types.includes('user.message') && types.includes('tool.call') && types.includes('tool.result') && types.includes('turn.end')
console.log('E2E', ok ? 'PASS' : 'FAIL')
await session.dispose()
process.exit(ok ? 0 : 1)
