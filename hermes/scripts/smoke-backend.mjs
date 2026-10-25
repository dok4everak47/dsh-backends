import { backend, manifest } from '../dist/register.js'

const fakeHost = {
  cwd: process.cwd(),
  dataDir: '/tmp/hermes-smoke-host',
  locale: () => 'en',
  debug: () => {},
  warn: () => {},
}

let ok = 0
const check = (name, cond) => { if (cond) { ok++; console.log('PASS', name) } else console.log('FAIL', name) }

check('backend.id === hermes', backend.id === 'hermes')
check('manifest.id === hermes', manifest.id === 'hermes')
check('backend.open is fn', typeof backend.open === 'function')
check('backend.launch present', backend.launch !== undefined)
check('backend.catalog present', backend.catalog !== undefined)

const det = await backend.detect(fakeHost)
console.log('detect =>', JSON.stringify(det))
check('detect.installed', det.installed === true)

const prefs = backend.launch.sessionPrefs(fakeHost)
check('prefs.lastSession fn', typeof prefs.lastSession === 'function')
check('prefs.setLastSession fn', typeof prefs.setLastSession === 'function')
check('prefs.touch fn', typeof prefs.touch === 'function')
prefs.setLastSession('sess-123')
check('prefs.lastSession returns set', prefs.lastSession() === 'sess-123')
prefs.forget('sess-123')
check('prefs.forget clears', prefs.lastSession() === undefined)

const cmd = backend.launch.resumeCommand('abc')
console.log('resumeCommand =>', cmd)
check('resumeCommand format', cmd === 'dsh --profile dsh-tui --resume hermes:abc')

console.log(`\n${ok} checks passed`)
