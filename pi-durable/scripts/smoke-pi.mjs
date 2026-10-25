const host = {
  cwd: '/tmp',
  dataDir: '/tmp/pi-smoke',
  locale: () => 'en',
  debug: () => {},
  warn: () => {},
  appVersion: 'smoke',
}

const { backend, manifest } = await import('../dist/register.js')
console.log('manifest:', JSON.stringify(manifest))

const detection = await backend.detect(host)
console.log('detect:', JSON.stringify(detection))

const seen = []
const session = await backend.open({ kind: 'create', cwd: '/tmp' }, host)
const unsub = session.subscribe((batch) => {
  for (const e of batch) seen.push(e.type)
})
console.log('session cwd:', session.cwd, 'ref:', JSON.stringify(session.ref))
console.log('history len at open:', (await session.history()).length)

await new Promise((r) => setTimeout(r, 1500))
unsub()
console.log('event types seen:', JSON.stringify([...new Set(seen)]))
const hasReady = seen.includes('session.ready')
const hasStatus = seen.includes('session.status')
console.log('session.ready seen:', hasReady, '| session.status seen:', hasStatus)
await session.dispose()
console.log('SMOKE', hasReady && hasStatus ? 'PASS' : 'FAIL')
process.exit(hasReady && hasStatus ? 0 : 1)
