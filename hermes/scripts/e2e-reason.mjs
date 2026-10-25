import { backend } from '../dist/register.js'

const fakeHost = { cwd: process.cwd(), dataDir: '/tmp/hermes-e2e-host', locale: () => 'en', debug: () => {}, warn: () => {} }
const log = []
const det = (e) => {
  const d = { type: e.type }
  if (e.turn !== undefined) d.turn = e.turn
  if (e.step !== undefined) d.step = e.step
  if (e.attemptId !== undefined) d.attemptId = e.attemptId
  if (e.callId !== undefined) d.callId = e.callId
  if (e.name !== undefined) d.name = e.name
  if (e.delta !== undefined) d.k = e.delta.kind, d.t = e.delta.text.slice(0, 24).replace(/\n/g, '\\n')
  return d
}
const session = await backend.open({ kind: 'create', cwd: process.cwd() }, fakeHost)
session.subscribe((b) => { for (const e of b) log.push(det(e)) })
const res = await session.submit({ text: "Think step by step. Which single command prints the current working directory? Then use the terminal tool to run that command and tell me the result.", clientMessageId: 'c1' }, undefined)
console.log('submit =>', JSON.stringify(res))
await new Promise(r => setTimeout(r, 800))
session.dispose()

console.log('\n=== stream (type/step/kind) ===')
for (const d of log) console.log(JSON.stringify(d))
const tool = log.find(e => e.type === 'tool.call')
const text = log.find(e => e.type === 'assistant.delta' && e.k === 'text')
const thought = log.find(e => e.type === 'assistant.delta' && e.k === 'reasoning')
console.log('\nthought step:', thought?.step, '| tool step:', tool?.step, '| text step:', text?.step)
console.log('ordering text-below-tool:', tool && text ? text.step > tool.step : 'n/a')
