import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from '../lib/engram.js'
import { sections, apply } from '../index.js'

test('finds only executable files on PATH', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'engram')
  const env = { PATH: dir }
  assert.equal(findOnPath('engram', env), null)
  writeFileSync(file, '')
  chmodSync(file, 0o644)
  assert.equal(findOnPath('engram', env), null)
  chmodSync(file, 0o755)
  assert.equal(findOnPath('engram', env), file)
  assert.deepEqual(sections(env).map((s) => s.name), ['gentle-ai:persona'])
})

test('missing engram adds an install section and logs a warning', () => {
  const missing = sections({ PATH: '' })
  assert.deepEqual(missing.map((s) => s.name), ['gentle-ai:persona', 'gentle-ai:engram-missing'])
  assert.match(missing[1].text, /brew install gentleman-programming\/tap\/engram/)
  assert.equal(missing[1].interpolate, false)
  const registered = []
  const warnings = []
  const ctx = { effect: (fn) => fn(), systemPrompt: { getSectionOrder: () => 42, section: (s) => registered.push(s) }, logger: () => ({ warn: (s) => warnings.push(s) }) }
  apply(ctx, { env: { PATH: '' } })
  assert.equal(registered.length, 2)
  assert.ok(registered.every((s) => s.order === 42))
  assert.match(warnings[0], /brew install gentleman-programming\/tap\/engram/)
})
