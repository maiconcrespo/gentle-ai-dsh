import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionProjects, decideEngramWrite, parseSessionStart } from '../lib/guard.js'
import { apply } from '../index.js'

const CWD = '/work/ws-1'
const started = (project, directory = CWD) => ({
  isError: false,
  content: [{ type: 'text', text: JSON.stringify({ project, project_path: directory, result: `Session "s" started for project "${project}"` }) }],
})

test('non-engram tools and engram reads are allowed', () => {
  const projects = createSessionProjects()
  assert.deepEqual(decideEngramWrite({ toolName: 'bash', args: {}, cwd: CWD, project: projects.get(CWD) }), { kind: 'allow' })
  assert.deepEqual(decideEngramWrite({ toolName: 'mcp__engram__mem_search', args: { query: 'x' }, cwd: CWD, project: undefined }), { kind: 'allow' })
})

test('write without project is denied with the exact fix', () => {
  const decision = decideEngramWrite({ toolName: 'mcp__engram__mem_save', args: { title: 't', content: 'c' }, cwd: CWD, project: undefined })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /mcp__engram__mem_session_start/)
  assert.match(decision.reason, /directory="\/work\/ws-1"/)
})

test('write with project but no recorded session for the cwd is denied', () => {
  const decision = decideEngramWrite({ toolName: 'mcp__engram__mem_save', args: { project: 'ws-1' }, cwd: CWD, project: undefined })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /mem_session_start/)
})

test('recorded session with matching project is allowed; mismatch names the expected project', () => {
  const projects = createSessionProjects()
  projects.record(CWD, parseSessionStart(started('ws-1')))
  assert.deepEqual(decideEngramWrite({ toolName: 'mcp__engram__mem_save', args: { project: 'ws-1' }, cwd: CWD, project: projects.get(CWD) }), { kind: 'allow' })
  const mismatch = decideEngramWrite({ toolName: 'mcp__engram__mem_session_summary', args: { project: 'deepseek-harness' }, cwd: CWD, project: projects.get(CWD) })
  assert.equal(mismatch.kind, 'deny')
  assert.match(mismatch.reason, /project="ws-1"/)
})

test('mem_update checks expected_project', () => {
  const projects = createSessionProjects()
  projects.record(CWD, 'ws-1')
  assert.deepEqual(decideEngramWrite({ toolName: 'mcp__engram__mem_update', args: { id: 1, expected_project: 'ws-1' }, cwd: CWD, project: projects.get(CWD) }), { kind: 'allow' })
  assert.equal(decideEngramWrite({ toolName: 'mcp__engram__mem_update', args: { id: 1, project: 'ws-1' }, cwd: CWD, project: projects.get(CWD) }).kind, 'deny')
})

test('a cwd change requires a new session start', () => {
  const projects = createSessionProjects()
  projects.record(CWD, 'ws-1')
  const other = '/work/ws-2'
  assert.equal(decideEngramWrite({ toolName: 'mcp__engram__mem_save_prompt', args: { project: 'ws-1' }, cwd: other, project: projects.get(other) }).kind, 'deny')
})

test('error results and unparsable results are not recorded', () => {
  assert.equal(parseSessionStart({ isError: true, content: [{ type: 'text', text: '{"project":"x"}' }] }), undefined)
  assert.equal(parseSessionStart({ isError: false, content: [{ type: 'text', text: 'not json' }] }), undefined)
  assert.equal(parseSessionStart(started('ws-1')), 'ws-1')
})

function fakeCtx(env) {
  const handlers = {}
  const sections = []
  const session = { id: 'session-1' }
  const ctx = {
    effect: (fn) => fn(),
    on: (event, handler) => { handlers[event] = handler },
    logger: () => ({ warn: () => {} }),
    systemPrompt: { getSectionOrder: () => 0, section: (s) => sections.push(s) },
    workingDirectory: { get: (s) => (s === session ? CWD : undefined) },
  }
  apply(ctx, { env })
  return { handlers, agent: { session } }
}

test('hooks are registered only when engram is on PATH', (t) => {
  assert.deepEqual(Object.keys(fakeCtx({ PATH: '' }).handlers), [])
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'engram'), '')
  chmodSync(join(dir, 'engram'), 0o755)
  assert.deepEqual(Object.keys(fakeCtx({ PATH: dir }).handlers).sort(), ['tools/pre-execute', 'tools/result'])
})

test('pre-execute denies without next(), allows through next() after a recorded session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'engram'), '')
  chmodSync(join(dir, 'engram'), 0o755)
  const { handlers, agent } = fakeCtx({ PATH: dir })
  let nextCalls = 0
  const next = async () => { nextCalls++; return { kind: 'allow' } }
  const save = { name: 'mcp__engram__mem_save', arguments: { project: 'ws-1' }, agent }

  const denied = await handlers['tools/pre-execute'](save, next)
  assert.equal(denied.kind, 'deny')
  assert.equal(nextCalls, 0)

  handlers['tools/result']({ name: 'mcp__engram__mem_session_start', arguments: { directory: CWD }, agent }, started('ws-1'))
  assert.deepEqual(await handlers['tools/pre-execute'](save, next), { kind: 'allow' })
  assert.equal(nextCalls, 1)

  assert.deepEqual(await handlers['tools/pre-execute']({ name: 'bash', arguments: {}, agent }, next), { kind: 'allow' })
  assert.equal(nextCalls, 2)
})
