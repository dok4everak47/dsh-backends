import { backend } from '../dist/register.js'

const fakeHost = {
  cwd: process.cwd(),
  dataDir: '/tmp/hermes-e2e-host',
  locale: () => 'en',
  debug: () => {},
  warn: () => {},
}

const log = []
const detail = (e) => {
  const d = { type: e.type }
  if (e.turn !== undefined) d.turn = e.turn
  if (e.step !== undefined) d.step = e.step
  if (e.attemptId !== undefined) d.attemptId = e.attemptId
  if (e.callId !== undefined) d.callId = e.callId
  if (e.name !== undefined) d.name = e.name
  if (e.text !== undefined) d.text = e.text.slice(0, 60).replace(/\n/g, '\\n')
  if (e.delta?.text !== undefined) d.delta = e.delta.kind + ':' + e.delta.text.slice(0, 50).replace(/\n/g, '\\n')
  if (e.title !== undefined) d.title = e.title
  return d
}

const session = await backend.open({ kind: 'create', cwd: process.cwd() }, fakeHost)
session.subscribe((batch) => { for (const e of batch) log.push(detail(e)) })

const res = await session.submit(
  { text: "Use the terminal tool to run exactly: echo hermes-tool-test-ok . Then tell me what it printed.", clientMessageId: 'c1' },
  undefined,
)
console.log('submit =>', JSON.stringify(res))

await new Promise(r => setTimeout(r, 800))
session.dispose()
await new Promise(r => setTimeout(r, 300))

console.log('\n=== ordered event stream ===')
for (const d of log) console.log(JSON.stringify(d))

// ordering check: find first text delta step vs tool step
const toolCall = log.find(e => e.type === 'tool.call')
const textDelta = log.find(e => e.type === 'assistant.delta' && e.delta?.startsWith('text'))
if (toolCall && textDelta) {
  console.log('\nTOOL step =', toolCall.step, '| TEXT delta step =', textDelta.step)
  console.log('text-above-tool (step order):', textDelta.step <= toolCall.step)
}
const lingering = (() => { try { return require('node:child_process').execSync('pgrep -f hermes-acp || true').toString().trim() } catch { return '' } })()
console.log('\nlingering hermes-acp procs after dispose:', lingering || 'none')
