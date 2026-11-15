import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from '../lib/engram.js'
import { installFakeEngram } from './fake-engram.js'
import { sections, apply } from '../index.js'

test('finds only executable files on PATH', { skip: process.platform === 'win32' && 'POSIX permission bits do not apply on Windows' }, (t) => {
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

test('on Windows, finds the command through PATHEXT and ignores a bare name', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  writeFileSync(join(dir, 'engram'), '')
  assert.equal(findOnPath('engram', env, 'win32'), null)
  writeFileSync(join(dir, 'engram.exe'), '')
  assert.equal(findOnPath('engram', env, 'win32'), join(dir, 'engram.exe'))
  // Without PATHEXT, the Windows default extensions still apply.
  assert.equal(findOnPath('engram', { PATH: dir }, 'win32'), join(dir, 'engram.exe'))
  // A name that already has an executable extension is looked up as given.
  assert.equal(findOnPath('engram.exe', env, 'win32'), join(dir, 'engram.exe'))
})

test('installed engram adds a session-project section (issue #4)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  installFakeEngram(dir)
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
