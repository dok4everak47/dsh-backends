import { backend, manifest } from '../dist/register.js'

const host = {
  cwd: '/tmp',
  dataDir: '/tmp/pi-cli-smoke',
  locale: () => 'en',
  debug: () => {},
  warn: () => {},
  appVersion: 'smoke',
}

console.log('manifest:', JSON.stringify(manifest))
const detection = await backend.detect(host)
console.log('detect:', JSON.stringify(detection))
if (!detection.installed) {
  console.log('SMOKE FAIL: pi CLI not installed')
  process.exit(1)
}

const session = await backend.open({ kind: 'create', cwd: '/tmp' }, host)
const events = []
session.subscribe((batch) => {
  for (const e of batch) events.push(e)
})
await new Promise((r) => setTimeout(r, 300))
const types = events.map((e) => e.type)
console.log('history len at open:', events.length)
console.log('event types seen:', JSON.stringify([...new Set(types)]))
const ok = types.includes('session.ready') && types.includes('session.status')
console.log('session.ready seen:', types.includes('session.ready'), '| session.status seen:', types.includes('session.status'))
console.log('SMOKE', ok ? 'PASS' : 'FAIL')
await session.dispose()
process.exit(ok ? 0 : 1)
