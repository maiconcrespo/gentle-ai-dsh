import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../lib/role-restrict.js'
import * as roles from '../lib/roles.js'
import { dshRuntimeAdaptation } from '../lib/dsh-runtime.js'

const { apply, restrictRole } = plugin
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const PATCH = read('../cordis.patch.yml')
const ROLES = ['explore', 'verify', 'worker']
const READ_ONLY = ['glob', 'grep', 'read']
const SHELLS = { win32: 'pwsh', linux: 'bash', darwin: 'bash' }
const HOST_SHELL = SHELLS[process.platform]

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

// ---------- Shared role table (lib/roles.js) ----------

test('the shared role table names each role with its preset, prompt and tools', () => {
  assert.deepEqual(roles.ROLE_NAMES, ROLES)
  assert.equal(roles.DEFAULT_ROLE, 'explore')
  assert.deepEqual(Object.keys(roles.ROLES).sort(), ROLES)
  assert.equal(Object.getPrototypeOf(roles.ROLES), null)
  assert.ok(Object.isFrozen(roles.ROLES) && Object.isFrozen(roles.ROLE_NAMES))
  for (const role of ROLES) {
    const entry = roles.ROLES[role]
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.tools), `${role} entry is frozen`)
    assert.equal(entry.name, role)
    assert.equal(entry.preset, `gentle-ai-${role}`)
    assert.equal(entry.title, `gentle-ai ${role}`)
    for (const field of ['description', 'prompt']) assert.ok(typeof entry[field] === 'string' && entry[field].trim().length > 0, `${role} ${field}`)
    assert.deepEqual(entry.tools, READ_ONLY)
    assert.equal(entry.shell, role === 'verify')
  }
  assert.match(roles.ROLES.worker.prompt, /#16/)
  assert.match(roles.ROLES.verify.prompt, /not limited by path/)
})

test('the verify shell is pwsh on win32 and bash on linux and darwin', () => {
  for (const [platform, shell] of Object.entries(SHELLS)) assert.equal(roles.shellTool(platform), shell, platform)
  assert.equal(roles.shellTool(), HOST_SHELL)
})

test('an unsupported platform has no verify shell', () => {
  for (const platform of ['freebsd', 'aix', 'WIN32', '', '__proto__', 'toString', null, 42]) {
    assert.throws(() => roles.shellTool(platform), /gentle-ai roles: no verify shell for platform .*; expected win32 \(pwsh\), linux or darwin \(bash\)/, String(platform))
  }
})

test('roleTools resolves each role allowlist per platform', () => {
  for (const platform of Object.keys(SHELLS)) {
    assert.deepEqual(roles.roleTools('explore', platform), READ_ONLY, `explore ${platform}`)
    assert.deepEqual(roles.roleTools('worker', platform), READ_ONLY, `worker ${platform}`)
    assert.deepEqual(roles.roleTools('verify', platform), [...READ_ONLY, SHELLS[platform]], `verify ${platform}`)
  }
  // Read-only roles need no shell, so they resolve on any platform.
  assert.deepEqual(roles.roleTools('explore', 'freebsd'), READ_ONLY)
  assert.throws(() => roles.roleTools('verify', 'freebsd'), /no verify shell/)
  for (const role of [undefined, 'other', '__proto__', 'toString', 'EXPLORE', ['explore']]) {
    assert.throws(() => roles.roleTools(role, 'win32'), /gentle-ai roles: unknown role .*; expected one of explore, verify, worker/)
  }
  const first = roles.roleTools('explore', 'linux')
  first.push('write')
  assert.deepEqual(roles.roleTools('explore', 'linux'), READ_ONLY, 'each call returns a fresh copy')
})

test('the worker stays read-only and no role gets write or delegation tools on any platform', () => {
  for (const platform of Object.keys(SHELLS)) {
    for (const role of ROLES) {
      const tools = roles.roleTools(role, platform)
      for (const name of ['edit', 'write', 'apply_patch', 'working_directory', 'subagent', 'subagent_fork', 'skill']) assert.ok(!tools.includes(name), `${role} ${platform} lacks ${name}`)
    }
    assert.ok(!roles.roleTools('worker', platform).includes(SHELLS[platform]), `worker ${platform} has no shell`)
  }
})

// ---------- Enforcement (lib/role-restrict.js) ----------

for (const [role, allow] of Object.entries({
  explore: READ_ONLY,
  worker: READ_ONLY,
  verify: [...READ_ONLY, HOST_SHELL],
})) {
  test(`${role} installs its exact restriction`, () => {
    const calls = []
    apply({ tools: { restrict: (policy) => calls.push(policy) } }, { role })
    assert.deepEqual(calls, [{ allow }])
  })
}

test('restrictRole installs the platform allowlist for each role', () => {
  for (const platform of Object.keys(SHELLS)) {
    for (const role of ROLES) {
      const calls = []
      restrictRole({ tools: { restrict: (policy) => calls.push(policy) } }, role, platform)
      assert.deepEqual(calls, [{ allow: roles.roleTools(role, platform) }], `${role} ${platform}`)
    }
  }
})

test('verify fails closed on a platform without a known shell', () => {
  let called = false
  assert.throws(() => restrictRole({ tools: { restrict: () => { called = true } } }, 'verify', 'freebsd'), /no verify shell for platform "freebsd"/)
  assert.equal(called, false)
})

test('role-restrict takes its policy from the shared table only', () => {
  const source = read('../lib/role-restrict.js')
  assert.match(source, /from '\.\/roles\.js'/)
  assert.doesNotMatch(source, /'(glob|grep|read|pwsh|bash)'/)
  assert.equal(plugin.ROLE_TOOLS, undefined)
})

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

test('the package exports the shared role table for other adapters', async () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.exports['./roles'], './lib/roles.js')
  const exported = await import('gentle-ai-dsh/roles')
  assert.equal(exported.ROLES, roles.ROLES)
})

test('the spawn delegation tool defaults to explore and offers only the role presets', () => {
  const row = block(PATCH, 'tool-subagent')
  for (const line of [
    "  name: '@deepseek-ai/dsh-tool-subagent'",
    '    provider: spawn',
    '    toolName: subagent',
    `    agentPreset: ${roles.ROLES[roles.DEFAULT_ROLE].preset}`,
    `    allowedAgentPresets: [${ROLES.map((role) => roles.ROLES[role].preset).join(', ')}]`,
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
  assert.match(block(PATCH, 'gentle-ai-preset-worker'), /edit surfaces pending the guard \(#16\)/)
})

test('preset rows match the shared role table and carry no allowlist of their own', () => {
  const presetRows = PATCH.split(/\r?\n/).filter((line) => /^\s*- id: gentle-ai-preset-/.test(line)).map((line) => line.trim().slice('- id: '.length))
  assert.deepEqual(presetRows, ROLES.map((role) => `gentle-ai-preset-${role}`))
  for (const role of ROLES) {
    const entry = roles.ROLES[role]
    const row = block(PATCH, `gentle-ai-preset-${role}`)
    assert.match(row, new RegExp(`^ {8}id: ${entry.preset}$`, 'm'))
    assert.match(row, new RegExp(`^ {8}name: ${entry.title}$`, 'm'))
    assert.ok(row.split('\n').includes(`        description: '${entry.description}'`), `${role} description matches the table`)
    assert.doesNotMatch(row, /\b(allow|tools|pwsh|bash|shell)\s*:/, `${role} preset carries no tool policy`)
  }
})

test('runtime guidance describes every role and the platform shell', () => {
  for (const role of ROLES) assert.ok(dshRuntimeAdaptation.includes(`\`${roles.ROLES[role].preset}\``), role)
  for (const part of ['`pwsh` on Windows', '`bash` on Linux and macOS', 'not limited by path', 'read-only until the edit-surface guard (#16) ships']) assert.ok(dshRuntimeAdaptation.includes(part), part)
})

test('PR-facing files name #16 and cite no removed evidence or out-of-repo tools', () => {
  for (const file of ['../README.md', '../cordis.patch.yml', '../orchestrator.md', '../lib/roles.js', '../lib/role-restrict.js', '../lib/dsh-runtime.js', '../test/c2-replay.test.js', '../test/c2-replay/lib.mjs', '../test/evidence/c2-replay.md']) {
    const text = read(file)
    assert.doesNotMatch(text, /\bC3\b/, `${file} names C3`)
    assert.doesNotMatch(text, /c2-role-presets\.md|evidence-corrected|session-dump\.mjs/, `${file} cites removed or out-of-repo files`)
  }
})

test('the replay test takes its role expectations from the shared table', () => {
  const source = read('./c2-replay.test.js')
  assert.match(source, /from '\.\.\/lib\/roles\.js'/)
  assert.doesNotMatch(source, /explore: \['glob'/)
})

test('the preset registry row matches the web bundle default', () => {
  const row = block(PATCH, 'agent-preset-registry')
  assert.match(row, /name: '@deepseek-ai\/dsh-agent-preset-registry'/)
  assert.match(row, /^ {8}default: standard$/m)
})
