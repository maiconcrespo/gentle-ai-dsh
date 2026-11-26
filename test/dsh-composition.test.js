// Composition and pin guard: what this bundle adds to a dsh profile, and the
// exact release it is tested against (issue #25, follow-up to #10).
//
// The patch is a composition layer: it inserts rows under their own ids and
// overrides a base row by id, in file order. test/bundle.test.js already checks
// that the expected row ids appear somewhere; this guard checks the composition
// itself — order, names, and that no id is used twice — so a row that moves,
// loses its name or is added twice fails here instead of passing unnoticed.
//
// Nothing here boots dsh: this runs on every CI leg without a pinned install.
// The replay (test/c2-replay.test.js) is what exercises a real boot when one is
// available. The parser is deliberately strict: a patch shape it cannot read
// fails the test rather than being silently skipped, because a guard that
// ignores what it does not understand is worse than no guard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DSH_PIN, DSH_RANGE } from './dsh-pin.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const PATCH = read('../cordis.patch.yml')
const EXPECTED = JSON.parse(read('./fixtures/bundle-rows.json'))

const unquote = (value) => value.replace(/^['"]|['"]$/g, '')

// Reads the two shapes this patch uses, in file order: `- id:` entries at
// column 0 override a base row, and `- id:` entries indented inside an
// `insert:` block add one. Names live on the `name:` line of the same entry.
// Anything else at those levels throws: the guard must not half-read the file.
export function parsePatch(text) {
  const entries = []
  let inInsert = false
  let current = null
  text.split(/\r?\n/).forEach((line, index) => {
    const at = `cordis.patch.yml:${index + 1}`
    if (line.trim() === '' || /^\s*#/.test(line)) return
    if (/^- insert:\s*$/.test(line)) {
      inInsert = true
      current = null
      return
    }
    const override = line.match(/^- id:\s*(\S+)\s*$/)
    if (override) {
      inInsert = false
      current = { kind: 'override', id: override[1], name: null }
      entries.push(current)
      return
    }
    if (/^- /.test(line)) throw new Error(`${at}: unsupported top-level entry ${JSON.stringify(line)}`)
    if (/^ /.test(line) && inInsert) {
      const inserted = line.match(/^ {4}- id:\s*(\S+)\s*$/)
      if (inserted) {
        current = { kind: 'insert', id: inserted[1], name: null }
        entries.push(current)
        return
      }
      const name = line.match(/^ {2,6}name:\s*(.+?)\s*$/)
      if (name && current) {
        current.name = unquote(name[1])
        return
      }
      if (/^ {4}- /.test(line)) throw new Error(`${at}: unsupported insert entry ${JSON.stringify(line)}`)
      return
    }
    if (/^ /.test(line) && current && !inInsert) {
      const name = line.match(/^ {2}name:\s*(.+?)\s*$/)
      if (name) current.name = unquote(name[1])
      return
    }
    throw new Error(`${at}: unsupported patch shape ${JSON.stringify(line)}`)
  })
  return entries
}

test('the patch composes exactly the rows the guard records, in file order', () => {
  assert.deepEqual(parsePatch(PATCH), EXPECTED.entries)
})

test('no composed id repeats, every row names its plugin, and none is both inserted and overridden', () => {
  const entries = parsePatch(PATCH)
  const ids = entries.map((row) => row.id)
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'no row id repeats')
  for (const row of entries) {
    assert.match(row.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `row id ${row.id} is a plain slug`)
    assert.ok(row.name, `row ${row.id} names its plugin`)
  }
  // An override replaces a base row; overriding a row this layer inserts would
  // mean the bundle patches itself and the base row keeps its config.
  for (const row of entries.filter((entry) => entry.kind === 'override')) {
    assert.ok(!entries.some((entry) => entry.kind === 'insert' && entry.id === row.id), `${row.id} is not both inserted and overridden`)
  }
  assert.deepEqual(entries.filter((entry) => entry.kind === 'override').map((row) => row.id), ['tool-subagent'], 'the bundle overrides one base row')
})

test('the parser refuses a shape it cannot read instead of skipping it', () => {
  // A guard that silently ignores what it does not understand would let an
  // unreadable row into the composition and still report a matching fixture.
  assert.throws(() => parsePatch(PATCH.replace('    - id: gentle-ai\n', '    - { id: gentle-ai, name: x }\n')), /unsupported insert entry/)
  assert.throws(() => parsePatch(`${PATCH}\n- rules:\n    - id: extra\n      name: x\n`), /unsupported top-level entry/)
  assert.doesNotThrow(() => parsePatch(PATCH))
})

test('the tested dsh pin is one value across the package, the docs and the replay', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.engines.dsh, DSH_RANGE)
  // The advertised range must start at the release that was actually tested.
  const floor = DSH_RANGE.match(/^>=([^ ]+) </)
  assert.ok(floor, 'the range declares an inclusive floor')
  assert.equal(floor[1], DSH_PIN, 'the range floor is the tested pin')

  assert.ok(read('../README.md').includes(`@deepseek-ai/dsh@${DSH_PIN}`), 'README names the tested release')
  assert.ok(read('./evidence/c2-replay.md').includes(`| Pins | \`@deepseek-ai/dsh\` and \`@deepseek-ai/dsh-llm-replay\` \`${DSH_PIN}\``), 'the replay evidence names the tested release')
  assert.ok(read('../docs/spike-findings.md').includes(`dsh \`${DSH_PIN}\``), 'the spike findings name the tested release')
  assert.match(read('./c2-replay.test.js'), /from '\.\/dsh-pin\.mjs'/, 'the replay imports the shared pin instead of holding its own')
})
