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
})

test('installed engram adds a session-project section (issue #4)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'engram'), '')
  chmodSync(join(dir, 'engram'), 0o755)
  const present = sections({ PATH: dir })
  assert.deepEqual(present.map((s) => s.name), ['gentle-ai:persona', 'gentle-ai:orchestrator', 'gentle-ai:engram-project'])
  const project = present[2]
  assert.equal(project.interpolate, false)
  // Engram only accepts an explicit `project` backed by known context; a
  // session started with `directory` backs a never-seen workspace (issue #4).
  assert.match(project.text, /mem_session_start/)
  assert.match(project.text, /`directory`/)
  assert.match(project.text, /current working directory/)
  for (const tool of ['mem_save', 'mem_search', 'mem_context', 'mem_session_summary']) {
    assert.match(project.text, new RegExp(tool))
  }
  assert.match(project.text, /`project`/)
  assert.ok(!project.text.includes('{{'))
  const registered = []
  const warnings = []
  const ctx = { effect: (fn) => fn(), on: () => {}, systemPrompt: { getSectionOrder: () => 7, section: (s) => registered.push(s) }, logger: () => ({ warn: (s) => warnings.push(s) }) }
  apply(ctx, { env: { PATH: dir } })
  assert.deepEqual(registered.map((s) => s.name), ['gentle-ai:persona', 'gentle-ai:orchestrator', 'gentle-ai:engram-project'])
  assert.deepEqual(warnings, [])
})

test('missing engram adds an install section and logs a warning', () => {
  const missing = sections({ PATH: '' })
  // Without Engram there is no memory to scope: no session-project section.
  assert.deepEqual(missing.map((s) => s.name), ['gentle-ai:persona', 'gentle-ai:orchestrator', 'gentle-ai:engram-missing'])
  assert.match(missing[2].text, /brew install gentleman-programming\/tap\/engram/)
  assert.equal(missing[2].interpolate, false)
  const registered = []
  const warnings = []
  const ctx = { effect: (fn) => fn(), systemPrompt: { getSectionOrder: () => 42, section: (s) => registered.push(s) }, logger: () => ({ warn: (s) => warnings.push(s) }) }
  apply(ctx, { env: { PATH: '' } })
  assert.equal(registered.length, 3)
  assert.ok(registered.every((s) => s.order === 42))
  assert.match(warnings[0], /brew install gentleman-programming\/tap\/engram/)
})
