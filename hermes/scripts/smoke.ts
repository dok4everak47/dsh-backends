import { HermesCatalog } from '../src/db-catalog.ts'

const cat = new HermesCatalog()
const rows = cat.list(5)
console.log(`list() -> ${rows.length} rows`)
for (const r of rows) {
  console.log(`  ${r.id} | ${r.title} | ${r.cwd} | model=${r.model}`)
}
if (rows.length) {
  const prev = cat.preview(rows[0].id, 4)
  console.log(`preview(${rows[0].id}) -> ${prev.length} entries`)
  for (const p of prev) console.log(`  [${p.role}] ${String(p.text).slice(0, 60)}`)
}
