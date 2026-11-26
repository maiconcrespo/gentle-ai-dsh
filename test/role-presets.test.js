import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../lib/role-restrict.js'
import * as presets from '../lib/role-presets.js'
import * as roles from '../lib/roles.js'
import { dshRuntimeAdaptation } from '../lib/dsh-runtime.js'

const { apply, restrictRole } = plugin
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const PATCH = read('../cordis.patch.yml')
const ROLES = ['explore', 'verify', 'worker']
const READ_ONLY = ['glob', 'grep', 'read']
const WORKER = [...READ_ONLY, 'edit', 'write']
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

// A host that registers the role tools globally and offers a preset registry.
function hostContext({ known = new Set([...WORKER, HOST_SHELL].filter(Boolean)), withView = true, platform, disposer } = {}) {
  const registered = []
  const warnings = []
  const ctx = {
    tools: withView ? { view: () => ({ restrictableNames: known }) } : {},
    agentPresets: { register: (definition) => { registered.push(definition); return Promise.resolve(disposer ?? (async () => {})) } },
    effect: (callback) => { ctx.taken.push(callback) },
    logger: () => ({ warn: (message) => warnings.push(message) }),
    inject: (deps, callback) => { ctx.injected.push(deps); return callback(ctx) },
    injected: [],
    taken: [],
  }
  return { ctx, registered, warnings, config: platform ? { platform } : {} }
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
    assert.deepEqual(entry.tools, role === 'worker' ? WORKER : READ_ONLY)
    assert.equal(entry.shell, role === 'verify')
    assert.deepEqual(entry.allowedRoots, role === 'worker' ? ['.'] : undefined)
  }
  assert.ok(Object.isFrozen(roles.ROLES.worker.allowedRoots))
  for (const part of [/#16/, /write and edit/, /inside the project directory/, /\.git/, /no shell and no apply_patch/]) assert.match(roles.ROLES.worker.prompt, part)
  for (const part of [/write and edit inside the project only/, /no shell or apply_patch/]) assert.match(roles.ROLES.worker.description, part)
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
    assert.deepEqual(roles.roleTools('worker', platform), WORKER, `worker ${platform}`)
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

test('only the worker edits, and no role gets apply_patch, a cwd change or delegation tools on any platform', () => {
  assert.deepEqual([...roles.EDIT_TOOLS], ['edit', 'write'])
  assert.equal(roles.READ_TOOLS, roles.ROLES.explore.tools)
  for (const platform of Object.keys(SHELLS)) {
    for (const role of ROLES) {
      const tools = roles.roleTools(role, platform)
      for (const name of ['apply_patch', 'working_directory', 'subagent', 'subagent_fork', 'skill']) assert.ok(!tools.includes(name), `${role} ${platform} lacks ${name}`)
      if (role !== 'worker') for (const name of ['edit', 'write']) assert.ok(!tools.includes(name), `${role} ${platform} lacks ${name}`)
    }
    assert.ok(!roles.roleTools('worker', platform).includes(SHELLS[platform]), `worker ${platform} has no shell`)
  }
})

// ---------- Enforcement (lib/role-restrict.js) ----------

for (const [role, allow] of Object.entries({
  explore: READ_ONLY,
  worker: WORKER,
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

test('the package exports the edit guard under the name the worker preset uses', async () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.exports['./edit-guard'], './lib/edit-guard.js')
  const exported = await import('gentle-ai-dsh/edit-guard')
  const local = await import('../lib/edit-guard.js')
  assert.equal(exported.apply, local.apply)
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

test('every mountable role registers a preset with the restriction, and the worker adds the edit guard', () => {
  const { ctx, registered } = hostContext()
  const offered = presets.apply(ctx, {})
  assert.deepEqual(offered, ROLES)
  assert.deepEqual(registered.map((definition) => definition.id), ROLES.map((role) => roles.ROLES[role].preset))
  for (const definition of registered) {
    const role = ROLES.find((name) => roles.ROLES[name].preset === definition.id)
    const entry = roles.ROLES[role]
    assert.equal(definition.name, entry.title)
    assert.equal(definition.description, entry.description)
    // Tools a preset registers itself are exempt from its restriction, so the
    // only plugins allowed are the two that register none.
    const expected = [{ id: 'role-restrict', name: 'gentle-ai-dsh/role-restrict', config: { role } }]
    if (role === 'worker') expected.push({ id: 'edit-guard', name: 'gentle-ai-dsh/edit-guard', config: { allowedRoots: ['.'] } })
    assert.deepEqual(definition.plugins, expected)
    assert.doesNotMatch(JSON.stringify(definition), /\b(allow|tools|pwsh|bash|shell)"/, `${role} preset carries no tool policy`)
  }
  // The roots come from the table, as a copy the registry cannot freeze or share.
  const worker = registered.find((definition) => definition.id === 'gentle-ai-worker')
  assert.notEqual(worker.plugins[1].config.allowedRoots, roles.ROLES.worker.allowedRoots)
})

test('the edit guard mounts with the roots from the table and denies outside them', async () => {
  const { apply: applyGuard } = await import('../lib/edit-guard.js')
  const config = presets.definition('worker').plugins.find((plugin) => plugin.id === 'edit-guard').config
  const guards = []
  applyGuard({ tools: { guard: (callback) => guards.push(callback) }, get: () => undefined }, config)
  assert.equal(guards.length, 1)
  // No working-directory service in this fake host: an edit is denied, never allowed by default.
  assert.match(guards[0]({ name: 'write', arguments: { file_path: 'x' }, agent: { session: {} } }), /^gentle-ai edit-guard denied "write"/)
  assert.equal(guards[0]({ name: 'read', arguments: { file_path: 'x' } }), undefined)
})

test('a role with edit tools and no roots cannot be defined', () => {
  // The frozen table must never hold such an entry, so the refusal is
  // exercised with a synthetic one instead of only grepping for its message.
  const bare = { preset: 'gentle-ai-bare', title: 'bare', description: 'bare', tools: ['read', ...roles.EDIT_TOOLS] }
  assert.throws(() => presets.definition('bare', { bare }), /has edit tools but no allowedRoots; refusing an unguarded preset/)
  assert.throws(() => presets.definition('bare', { bare: { ...bare, allowedRoots: [] } }), /no allowedRoots/)
  const guardedTable = { bare: { ...bare, allowedRoots: ['.'] } }
  const plugins = presets.definition('bare', guardedTable).plugins
  assert.deepEqual(plugins.map((plugin) => plugin.id), ['role-restrict', 'edit-guard'])
  assert.deepEqual(plugins[1].config, { allowedRoots: ['.'] })
  // Every real role still resolves, and only the editing one mounts the guard.
  for (const role of ROLES) {
    const plugins = presets.definition(role).plugins
    const edits = roles.ROLES[role].tools.some((tool) => roles.EDIT_TOOLS.includes(tool))
    assert.equal(plugins.some((plugin) => plugin.id === 'edit-guard'), edits, role)
  }
})

test('a host without the role tools mounts no preset and logs one line', () => {
  const { ctx, registered, warnings } = hostContext({ known: new Set() })
  assert.deepEqual(presets.apply(ctx, {}), [])
  assert.deepEqual(registered, [])
  assert.equal(warnings.length, 1)
  for (const part of ['explore', 'verify', 'worker', '"glob"', '#17']) assert.ok(warnings[0].includes(part), part)
})

test('a host without the shared read tools skips every role, keeping the shell out of the gate', () => {
  // The read tools are in every role's allowlist, so their absence skips them
  // all. The shell is a platform property: a host without it fails the verify
  // preset closed at mount, not the gate, so no shell is in these sets.
  const partial = hostContext({ known: new Set(['glob', 'grep', 'edit', 'write']) })
  assert.deepEqual(presets.apply(partial.ctx, {}), [])
  assert.equal(partial.warnings.length, 1)
  assert.match(partial.warnings[0], /"read"/)

  const full = hostContext({ known: new Set(WORKER) })
  assert.deepEqual(presets.apply(full.ctx, {}), ROLES)
  assert.deepEqual(full.warnings, [])
})

test('a host with the read tools but without write offers explore and verify but not the worker', () => {
  // Offering the worker here would register a preset whose allowlist names a
  // tool the host lacks, so the child would fail to mount.
  const { ctx, registered, warnings } = hostContext({ known: new Set([...READ_ONLY, 'edit', HOST_SHELL].filter(Boolean)) })
  assert.deepEqual(presets.apply(ctx, {}), ['explore', 'verify'])
  assert.deepEqual(registered.map((definition) => definition.id), ['gentle-ai-explore', 'gentle-ai-verify'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^gentle-ai skipped 1 of 3 subagent role presets on this host \(worker: no global tool "write"\); the host may register the role tools per agent instead, see #17$/)
  assert.doesNotMatch(warnings[0], /"edit"|explore:|verify:/)
})

test('a host with every role tool offers all three roles and logs nothing', () => {
  const { ctx, registered, warnings } = hostContext({ known: new Set([...WORKER, HOST_SHELL].filter(Boolean)) })
  assert.deepEqual(presets.apply(ctx, {}), ROLES)
  assert.deepEqual(registered.map((definition) => definition.id), ROLES.map((role) => roles.ROLES[role].preset))
  assert.deepEqual(warnings, [])
})

test('a platform without a known verify shell keeps the other roles', () => {
  const { ctx, registered, warnings, config } = hostContext({ platform: 'freebsd' })
  assert.deepEqual(presets.apply(ctx, config), ['explore', 'worker'])
  assert.deepEqual(registered.map((definition) => definition.id), ['gentle-ai-explore', 'gentle-ai-worker'])
  assert.match(warnings[0], /verify: gentle-ai roles: no verify shell for platform "freebsd"/)
})
test('the registration waits for the tools and registry services', () => {
  // A plugin-level inject would keep the whole registration pending on a host
  // that never activates one of them; core registers nothing until both exist.
  const { ctx, registered } = hostContext()
  assert.deepEqual(presets.apply(ctx, {}), ROLES)
  assert.deepEqual(ctx.injected, [['tools', 'agentPresets']])
  assert.equal(registered.length, ROLES.length)
})

test('a context without inject registers nothing instead of throwing', () => {
  assert.deepEqual(presets.apply({}, {}), [])
})

test('a host with no tools view mounts nothing rather than assuming it is complete', () => {
  const { ctx, registered, warnings } = hostContext({ withView: false })
  assert.deepEqual(presets.apply(ctx, {}), [])
  assert.deepEqual(registered, [])
  assert.equal(warnings.length, 1)
})

test('each registration is disposed with the plugin', async () => {
  let disposed = 0
  const { ctx } = hostContext({ disposer: async () => { disposed += 1 } })
  presets.apply(ctx, {})
  assert.equal(ctx.taken.length, ROLES.length)
  for (const effect of ctx.taken) {
    const dispose = effect()
    assert.equal(typeof dispose, 'function')
    await Promise.resolve()
    await Promise.resolve()
    dispose()
  }
  assert.equal(disposed, ROLES.length)
})

test('the patch declares no preset row and the bundle entry registers them', () => {
  const rows = PATCH.split(/\r?\n/).filter((line) => /^\s*- id: gentle-ai-preset/.test(line))
  assert.deepEqual(rows, [], 'no declarative preset or registration row remains')
  assert.doesNotMatch(PATCH, /@deepseek-ai\/dsh-agent-preset'/, 'no declarative preset rows remain')
  // A row can only name a package, and the loader resolves that package root,
  // so the registration is called from index.js instead of a subpath row.
  assert.match(read('../index.js'), /from '\.\/lib\/role-presets\.js'/)
  assert.match(read('../index.js'), /applyRolePresets\(ctx, config\)/)
})
test('the registration plugin is exported and requires no service at load', async () => {
  assert.equal(presets.name, 'gentle-ai-role-presets')
  assert.equal(presets.inject, undefined, 'no plugin-level inject keeps the plugin loaded')
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.exports['./role-presets'], './lib/role-presets.js')
  const exported = await import('gentle-ai-dsh/role-presets')
  assert.equal(exported.apply, presets.apply)
})

test('runtime guidance describes every role and the platform shell', () => {
  for (const role of ROLES) assert.ok(dshRuntimeAdaptation.includes(`\`${roles.ROLES[role].preset}\``), role)
  for (const part of ['`pwsh` on Windows', '`bash` on Linux and macOS', 'not limited by path', '`gentle-ai-worker` also gets `write` and `edit` inside the project, never `.git`', "the guard (#16) limits it to the project, not to them"]) assert.ok(dshRuntimeAdaptation.includes(part), part)
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
