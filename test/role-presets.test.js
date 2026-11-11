import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../lib/role-restrict.js'

const { apply } = plugin
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const PATCH = read('../cordis.patch.yml')
const ROLES = ['explore', 'verify', 'worker']

// Text of one YAML sequence item: from its `- id: <id>` line to the next item
// at the same indentation or a shallower line.
function block(text, id) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^\\s*- id: ${id}$`).test(line))
  assert.ok(start >= 0, `row ${id} exists`)
  const indent = lines[start].indexOf('-')
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    const depth = line.search(/\S/)
    if (depth >= 0 && !line.trimStart().startsWith('#') && depth <= indent) break
    end++
  }
  return lines.slice(start, end).filter((line) => !line.trimStart().startsWith('#')).join('\n')
}

for (const [role, allow] of Object.entries({
  explore: ['glob', 'grep', 'read'],
  worker: ['glob', 'grep', 'read'],
  verify: ['glob', 'grep', 'read', 'pwsh'],
})) {
  test(`${role} installs its exact restriction`, () => {
    const calls = []
    apply({ tools: { restrict: (policy) => calls.push(policy) } }, { role })
    assert.deepEqual(calls, [{ allow }])
  })
}

test('missing or unknown role fails closed', () => {
  for (const config of [{}, { role: 'other' }, { role: '__proto__' }]) {
    let called = false
    assert.throws(() => apply({ tools: { restrict: () => { called = true } } }, config))
    assert.equal(called, false)
  }
})

test('unknown roles name the accepted roles and no config fails closed', () => {
  for (const config of [undefined, { role: 'toString' }, { role: 'EXPLORE' }, { role: ['explore'] }]) {
    let called = false
    assert.throws(
      () => apply({ tools: { restrict: () => { called = true } } }, config),
      /gentle-ai role-restrict: unknown role .*; expected one of explore, verify, worker/,
    )
    assert.equal(called, false)
  }
})

test('a context without the tools service fails closed', () => {
  assert.throws(() => apply({}, { role: 'explore' }))
})

test('each role receives its own allowlist copy', () => {
  const seen = []
  const ctx = { tools: { restrict: (policy) => seen.push(policy) } }
  apply(ctx, { role: 'explore' })
  seen[0].allow.push('write')
  apply(ctx, { role: 'explore' })
  assert.deepEqual(seen[1], { allow: ['glob', 'grep', 'read'] })
})

test('role-restrict is a dsh plugin that injects the tools service', () => {
  assert.equal(plugin.name, 'gentle-ai-role-restrict')
  assert.deepEqual(plugin.inject, ['tools'])
})

test('the package exports the plugin under the name the presets use', async () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.exports['./role-restrict'], './lib/role-restrict.js')
  assert.equal(pkg.exports['.'], './index.js')
  // Package self-reference: proves the exports map in Node, not dsh's installed resolution.
  const exported = await import('gentle-ai-dsh/role-restrict')
  assert.equal(exported.apply, apply)
})

test('the spawn delegation tool defaults to explore and offers only the role presets', () => {
  const row = block(PATCH, 'tool-subagent')
  for (const line of [
    "  name: '@deepseek-ai/dsh-tool-subagent'",
    '    provider: spawn',
    '    toolName: subagent',
    '    agentPreset: gentle-ai-explore',
    '    allowedAgentPresets: [gentle-ai-explore, gentle-ai-verify, gentle-ai-worker]',
  ]) assert.ok(row.split('\n').includes(line), line)
  assert.doesNotMatch(row, /modelSelection|agentOptions|disabled|persona|toolFilter/)
})

test('each role preset mounts only its restriction plugin', () => {
  for (const role of ROLES) {
    const row = block(PATCH, `gentle-ai-preset-${role}`)
    assert.match(row, /name: '@deepseek-ai\/dsh-agent-preset'/)
    assert.match(row, new RegExp(`\\n {8}id: gentle-ai-${role}\\n`))
    assert.match(row, /name: gentle-ai-dsh\/role-restrict\n/)
    assert.match(row, new RegExp(`^ {14}role: ${role}$`, 'm'))
    // Plugins a preset mounts itself are exempt from its restriction: allow no other plugin.
    assert.equal(row.split('\n').slice(1).filter((line) => /^\s+- id: /.test(line)).length, 1, `${role} mounts exactly one plugin`)
    assert.equal(row.match(/name: /g).length, 3, `${role} has preset, display and plugin names only`)
  }
  assert.match(block(PATCH, 'gentle-ai-preset-worker'), /edit surfaces pending the guard contribution \(C3\)/)
})

test('the preset registry row matches the web bundle default', () => {
  const row = block(PATCH, 'agent-preset-registry')
  assert.match(row, /name: '@deepseek-ai\/dsh-agent-preset-registry'/)
  assert.match(row, /^ {8}default: standard$/m)
})
