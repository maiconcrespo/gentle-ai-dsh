// Composition and pin guard: what this bundle adds to a dsh profile, and the
// exact release it is tested against (issues #10 and #25).
//
// The patch is a composition layer: it inserts rows under their own ids and
// overrides a base row by id. Nothing here boots dsh, so this runs on every CI
// leg without a pinned install; the replay (test/c2-replay.test.js) is what
// exercises a real boot when one is available. When the patch changes, this
// test fails until test/fixtures/bundle-rows.json says so, which is the point:
// a row that disappears or changes shape is a composition change, not a detail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DSH_PIN, DSH_RANGE } from './dsh-pin.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const PATCH = read('../cordis.patch.yml')
const EXPECTED = JSON.parse(read('./fixtures/bundle-rows.json'))

// Minimal reader for the two shapes this patch uses: `- id:` entries at column
// 0 override a base row, and `- id:` entries indented inside an `insert:` block
// add one. Names live on the following `name:` line of the same entry.
function parsePatch(text) {
  const insert = []
  const override = []
  let inInsert = false
  let current = null
  for (const line of text.split(/\r?\n/)) {
    if (/^- insert:\s*$/.test(line)) {
      inInsert = true
      current = null
      continue
    }
    const overrideId = line.match(/^- id:\s*(\S+)\s*$/)
    if (overrideId) {
      inInsert = false
      current = { id: overrideId[1], name: null }
      override.push(current)
      continue
    }
    const insertedId = line.match(/^ {4}- id:\s*(\S+)\s*$/)
    if (insertedId && inInsert) {
      current = { id: insertedId[1], name: null }
      insert.push(current)
      continue
    }
    const name = line.match(/^ {2,6}name:\s*(.+?)\s*$/)
    if (name && current) current.name = name[1].replace(/^['"]|['"]$/g, '')
  }
  return { insert, override }
}

test('the patch inserts and overrides exactly the rows the guard expects', () => {
  assert.deepEqual(parsePatch(PATCH), { insert: EXPECTED.insert, override: EXPECTED.override })
})

test('every composed row carries an id and a name, and no id is used twice', () => {
  const { insert, override } = parsePatch(PATCH)
  const ids = [...insert, ...override].map((row) => row.id)
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'no row id repeats across inserts and overrides')
  for (const row of [...insert, ...override]) {
    assert.match(row.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `row id ${row.id} is a plain slug`)
    assert.ok(row.name, `row ${row.id} names its plugin`)
  }
  // An override replaces a base row; overriding a row this same layer inserts
  // would mean the bundle patches itself and the base row keeps its config.
  for (const row of override) assert.ok(!insert.some((added) => added.id === row.id), `${row.id} is not both inserted and overridden`)
})

test('the guarded profiles are the ones the bundle claims to support', () => {
  assert.deepEqual(EXPECTED.profiles, ['headless', 'acp'])
  // `dsh web` mounts its own presets and disables the host tool-subagent row;
  // the bundle is not composed for it, so overriding that row there is inert.
  assert.ok(!EXPECTED.profiles.includes('web'))
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
})

test('the replay takes its pin from the shared constant instead of a literal', () => {
  const source = read('./c2-replay.test.js')
  assert.match(source, /from '\.\/dsh-pin\.mjs'/)
  assert.doesNotMatch(source, /const PIN = ['"]/, 'the replay holds no pin literal of its own')
  assert.match(source, /const PIN = DSH_PIN/)
})
