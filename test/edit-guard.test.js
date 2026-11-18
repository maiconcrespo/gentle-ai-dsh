import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import * as guard from '../lib/edit-guard.js'
import { EDIT_TOOLS, READ_TOOLS } from '../lib/roles.js'

const { apply, hasGitSegment, insideRoots, resolveTarget, validateRoots } = guard

// Real directories only: the guard's job is the filesystem's answer, so
// nothing below fakes it. dsh itself is replaced by the smallest host that
// offers `tools.guard` and the working-directory service.
const SCRATCH = mkdtempSync(join(tmpdir(), 'gentle-ai-edit-guard-'))
after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const ROOT = realpathSync.native(SCRATCH)
const PROJECT = join(ROOT, 'project')
const ALLOWED = join(PROJECT, 'allowed')
const FORBIDDEN = join(PROJECT, 'forbidden')
const OUTSIDE = join(ROOT, 'outside')
mkdirSync(ALLOWED, { recursive: true })
mkdirSync(join(FORBIDDEN, 'allowed'), { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
mkdirSync(join(PROJECT, '.git', 'hooks'), { recursive: true })
writeFileSync(join(ALLOWED, 'existing.txt'), 'x')
writeFileSync(join(OUTSIDE, 'secret.txt'), 'x')

// A junction on Windows (no privilege needed), a directory symlink elsewhere.
// Hosts that cannot create one skip the cases that need it.
function link(target, path) {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}
const JUNCTION = link(OUTSIDE, join(ALLOWED, 'link'))
const DANGLING = JUNCTION && link(join(ROOT, 'missing'), join(ALLOWED, 'dangling'))
const NO_JUNCTION = 'this host cannot create a directory junction or symlink'

// The host a worker preset's plugin sees: one guard registry and the
// working-directory service, whose `get` answers the calling session's
// current directory and whose header keeps the original project.
function host({ roots = ['allowed'], project = PROJECT, cwd = PROJECT, service: withService = true } = {}) {
  const session = { header: { cwd: project } }
  const state = { cwd }
  const service = {
    defaultDirectory: project,
    get: (asked) => {
      assert.equal(asked, session, 'the cwd is read for the calling session')
      return state.cwd
    },
  }
  const guards = []
  const ctx = {
    tools: { guard: (callback) => { guards.push(callback); return () => {} } },
    get: (name) => (name === 'workingDirectory' && withService ? service : undefined),
  }
  apply(ctx, { allowedRoots: roots })
  assert.equal(guards.length, 1, 'one guard per mount')
  const call = (name, args) => guards[0]({ agent: { session }, name, arguments: args })
  return { call, state, service }
}

function assertDenied(reason, { tool, path, cwd, roots = [ALLOWED] }) {
  assert.equal(typeof reason, 'string', 'the call is denied with a reason')
  assert.ok(!/[\r\n]/.test(reason), 'the denial is one line')
  assert.ok(reason.startsWith(`gentle-ai edit-guard denied ${tool === undefined ? '(none)' : JSON.stringify(tool)}: `), reason)
  assert.ok(reason.includes(`Requested path: ${path === undefined ? '(none)' : JSON.stringify(path)};`), `names the requested path: ${reason}`)
  assert.ok(reason.includes(`cwd: ${cwd === undefined ? '(none)' : JSON.stringify(cwd)};`), `names the cwd: ${reason}`)
  assert.ok(reason.endsWith(`allowed roots: ${roots.map((root) => JSON.stringify(root)).join(', ')}.`), `names the roots: ${reason}`)
}

// ---------- Allowed edits ----------

test('a new file inside an allowed root is allowed, including new directories', () => {
  const { call } = host()
  for (const path of ['allowed/new.txt', 'allowed/a/b/c/new.txt', join(ALLOWED, 'abs.txt'), `allowed${sep}x${sep}..${sep}y.txt`, './allowed/./z.txt']) {
    assert.equal(call('write', { file_path: path }), undefined, path)
  }
})

test('an existing file inside an allowed root can be edited and rewritten', () => {
  const { call } = host()
  assert.equal(call('edit', { file_path: 'allowed/existing.txt', old_string: 'x', new_string: 'y' }), undefined)
  assert.equal(call('write', { file_path: join(ALLOWED, 'existing.txt'), content: 'y' }), undefined)
})

test('arguments still serialized as JSON text are read the same way', () => {
  const { call } = host()
  assert.equal(call('write', JSON.stringify({ file_path: 'allowed/json.txt' })), undefined)
  assertDenied(call('write', JSON.stringify({ file_path: 'forbidden/json.txt' })), { tool: 'write', path: 'forbidden/json.txt', cwd: PROJECT })
})

test('the read-only tools pass untouched, whatever path they name', () => {
  const { call } = host()
  for (const tool of READ_TOOLS) {
    for (const args of [{ file_path: join(OUTSIDE, 'secret.txt') }, { path: '..', pattern: '*' }, undefined, 'not json']) assert.equal(call(tool, args), undefined, `${tool} ${JSON.stringify(args)}`)
  }
})

// ---------- Denied edits ----------

test('an absolute path outside the allowed roots is denied', () => {
  const { call } = host()
  for (const tool of EDIT_TOOLS) {
    const path = join(OUTSIDE, 'secret.txt')
    const reason = call(tool, { file_path: path })
    assertDenied(reason, { tool, path, cwd: PROJECT })
    assert.ok(reason.includes(`resolves to ${JSON.stringify(path)}, outside the allowed roots`), reason)
  }
  assertDenied(call('write', { file_path: join(FORBIDDEN, 'x.txt') }), { tool: 'write', path: join(FORBIDDEN, 'x.txt'), cwd: PROJECT })
  assertDenied(call('write', { file_path: PROJECT }), { tool: 'write', path: PROJECT, cwd: PROJECT })
})

test('a .. escape out of the allowed root is denied', () => {
  const { call } = host()
  for (const path of ['allowed/../forbidden/x.txt', '../outside/secret.txt', `allowed${sep}..${sep}..${sep}outside${sep}new.txt`, 'allowed/..']) {
    assertDenied(call('write', { file_path: path }), { tool: 'write', path, cwd: PROJECT })
  }
})

test('a sibling whose name only starts like the root is outside it', () => {
  mkdirSync(join(PROJECT, 'allowed-other'), { recursive: true })
  const { call } = host()
  assertDenied(call('write', { file_path: 'allowed-other/x.txt' }), { tool: 'write', path: 'allowed-other/x.txt', cwd: PROJECT })
})

test('a junction inside the allowed root that points outside is denied', (t) => {
  if (!JUNCTION) return t.skip(NO_JUNCTION)
  const { call } = host()
  const created = call('write', { file_path: 'allowed/link/new.txt' })
  assertDenied(created, { tool: 'write', path: 'allowed/link/new.txt', cwd: PROJECT })
  assert.ok(created.includes(`resolves to ${JSON.stringify(join(OUTSIDE, 'new.txt'))}`), created)
  assertDenied(call('edit', { file_path: 'allowed/link/secret.txt' }), { tool: 'edit', path: 'allowed/link/secret.txt', cwd: PROJECT })
  assertDenied(call('write', { file_path: 'allowed/link' }), { tool: 'write', path: 'allowed/link', cwd: PROJECT })
})

test('a link whose target does not exist yet is denied', (t) => {
  if (!DANGLING) return t.skip(NO_JUNCTION)
  const { call } = host()
  const reason = call('write', { file_path: 'allowed/dangling/new.txt' })
  assertDenied(reason, { tool: 'write', path: 'allowed/dangling/new.txt', cwd: PROJECT })
  assert.match(reason, /a link whose target is missing/)
})

test('an allowed root that is itself a link out of the project is denied', (t) => {
  if (!JUNCTION) return t.skip(NO_JUNCTION)
  const { call } = host({ roots: ['allowed/link'] })
  const reason = call('write', { file_path: 'allowed/link/new.txt' })
  assertDenied(reason, { tool: 'write', path: 'allowed/link/new.txt', cwd: PROJECT, roots: [join(ALLOWED, 'link')] })
  assert.ok(reason.includes(`resolves to ${JSON.stringify(OUTSIDE)}, outside the project`), reason)
})

test('a cwd change makes the same relative path resolve outside, and it is denied', () => {
  const { call, state } = host()
  assert.equal(call('write', { file_path: 'allowed/x.txt' }), undefined, 'allowed from the project directory')
  // `subagent` cwd and `working_directory` move only the current directory;
  // the roots stay anchored to the original project.
  state.cwd = FORBIDDEN
  const reason = call('write', { file_path: 'allowed/x.txt' })
  assertDenied(reason, { tool: 'write', path: 'allowed/x.txt', cwd: FORBIDDEN })
  assert.ok(reason.includes(`resolves to ${JSON.stringify(join(FORBIDDEN, 'allowed', 'x.txt'))}`), reason)
  state.cwd = ALLOWED
  assert.equal(call('write', { file_path: 'x.txt' }), undefined, 'a cwd inside the root keeps relative paths inside it')
})

test('a tool the guard does not know is denied, so a later tool fails closed', () => {
  const { call } = host()
  for (const tool of ['apply_patch', 'pwsh', 'bash', 'working_directory', 'subagent', 'subagent_fork', 'skill', 'WRITE', 'Edit', '', '__proto__', 'toString']) {
    const reason = call(tool, { file_path: 'allowed/x.txt', input: '*** Begin Patch' })
    assertDenied(reason, { tool, path: 'allowed/x.txt', cwd: PROJECT })
    assert.match(reason, /any other tool is refused, including shells and apply_patch/)
  }
  for (const tool of [undefined, null, 42]) assertDenied(call(tool, {}), { tool, path: undefined, cwd: PROJECT })
})

test('the denial names the tool, the requested path, the cwd and every allowed root on one line', () => {
  const { call } = host({ roots: ['allowed', 'docs/notes'] })
  const reason = call('write', { file_path: '../outside/x.txt' })
  assert.equal(
    reason,
    `gentle-ai edit-guard denied "write": the path resolves to ${JSON.stringify(join(OUTSIDE, 'x.txt'))}, outside the allowed roots; use a path inside one of them. Requested path: "../outside/x.txt"; cwd: ${JSON.stringify(PROJECT)}; allowed roots: ${JSON.stringify(ALLOWED)}, ${JSON.stringify(join(PROJECT, 'docs', 'notes'))}.`,
  )
})

test('a .git directory is never writable, while names that only look like it are', () => {
  const { call } = host({ roots: ['.'] })
  for (const path of ['.git/hooks/pre-commit', '.git/config', join(PROJECT, '.git', 'hooks', 'post-checkout'), 'allowed/../.git/hooks/pre-push', 'vendor/lib/.git/hooks/pre-commit', '.git']) {
    for (const tool of EDIT_TOOLS) {
      const reason = call(tool, { file_path: path })
      assertDenied(reason, { tool, path, cwd: PROJECT, roots: [PROJECT] })
      assert.match(reason, /inside the git directory,? .*which this guard never allows/)
    }
  }
  for (const path of ['src/.gitkeep', 'docs/git-notes.md', '.gitignore', '.github/workflows/ci.yml', 'allowed/x.git/y']) assert.equal(call('write', { file_path: path }), undefined, path)
})

test('the .git rule applies relative to every matching root, not only the project', () => {
  const { call } = host()
  assertDenied(call('write', { file_path: 'allowed/.git/hooks/pre-commit' }), { tool: 'write', path: 'allowed/.git/hooks/pre-commit', cwd: PROJECT })
})

test('a .git spelling Windows treats as the same directory is denied there', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only name normalization; covered by the hasGitSegment test elsewhere')
  const { call } = host({ roots: ['.'] })
  for (const path of ['.GIT/hooks/pre-commit', '.git./hooks/pre-commit', '.git /hooks/pre-commit', '.git::$INDEX_ALLOCATION/hooks/pre-commit']) {
    assertDenied(call('write', { file_path: path }), { tool: 'write', path, cwd: PROJECT, roots: [PROJECT] })
  }
})

test('hasGitSegment folds names the way each host resolves them', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const rel of ['.git', join('.git', 'hooks', 'pre-commit'), 'a/.git/b', 'a\\.git\\b']) assert.equal(hasGitSegment(rel, platform), true, `${platform} ${rel}`)
    for (const rel of ['', 'src/.gitkeep', 'docs/git-notes.md', '.gitignore', '.github/x', 'x.git', 'git']) assert.equal(hasGitSegment(rel, platform), false, `${platform} ${rel}`)
  }
  for (const rel of ['.GIT/hooks', '.Git']) {
    assert.equal(hasGitSegment(rel, 'win32'), true, rel)
    assert.equal(hasGitSegment(rel, 'darwin'), true, rel)
    assert.equal(hasGitSegment(rel, 'linux'), false, rel)
  }
  for (const rel of ['.git./hooks', '.git /hooks', '.git.. ./hooks', '.git::$INDEX_ALLOCATION/hooks', '.GIT:stream']) {
    assert.equal(hasGitSegment(rel, 'win32'), true, rel)
    assert.equal(hasGitSegment(rel, 'linux'), false, rel)
  }
})

// ---------- Malformed calls never throw ----------

test('a malformed call is denied, never thrown', () => {
  const { call } = host()
  for (const [args, path] of [[undefined, undefined], [null, undefined], ['not json', undefined], [{}, undefined], [{ file_path: '' }, ''], [{ file_path: 42 }, 42], [{ file_path: ['allowed/x'] }, ['allowed/x']], [{ file_path: 'allowed/a\0b' }, 'allowed/a\0b']]) {
    let reason
    assert.doesNotThrow(() => { reason = call('write', args) }, JSON.stringify(args))
    assertDenied(reason, { tool: 'write', path, cwd: PROJECT })
  }
  const [only] = (() => {
    const guards = []
    apply({ tools: { guard: (callback) => guards.push(callback) }, get: () => undefined }, { allowedRoots: ['allowed'] })
    return guards
  })()
  for (const exec of [undefined, null, {}, { name: 'write' }, { name: 'write', arguments: { file_path: 'allowed/x' }, agent: {} }]) {
    let reason
    assert.doesNotThrow(() => { reason = only(exec) })
    assert.equal(typeof reason, 'string')
  }
})

test('without the working-directory service or a session cwd the edit is denied', () => {
  const missing = host({ service: false })
  assertDenied(missing.call('write', { file_path: 'allowed/x.txt' }), { tool: 'write', path: 'allowed/x.txt', cwd: undefined })

  const failing = host()
  failing.service.get = () => { throw new Error('no session state') }
  const reason = failing.call('edit', { file_path: 'allowed/x.txt' })
  assert.match(reason, /^gentle-ai edit-guard denied "edit": the path could not be checked \(no session state\)\./)

  const relative = host()
  relative.state.cwd = 'project'
  assertDenied(relative.call('write', { file_path: 'allowed/x.txt' }), { tool: 'write', path: 'allowed/x.txt', cwd: 'project' })
})

test('a project directory that no longer exists denies instead of throwing', () => {
  const gone = join(ROOT, 'gone')
  const { call } = host({ project: gone, cwd: gone })
  assertDenied(call('write', { file_path: 'allowed/x.txt' }), { tool: 'write', path: 'allowed/x.txt', cwd: gone, roots: [join(gone, 'allowed')] })
})

// ---------- Config validation ----------

test('allowedRoots must be a non-empty list of relative paths without ..', () => {
  for (const config of [undefined, {}, { allowedRoots: [] }, { allowedRoots: 'allowed' }, { allowedRoots: [''] }, { allowedRoots: ['  '] }, { allowedRoots: [42] },
    { allowedRoots: ['/etc'] }, { allowedRoots: ['C:\\Windows'] }, { allowedRoots: ['C:temp'] }, { allowedRoots: ['\\\\server\\share'] }, { allowedRoots: ['\\temp'] },
    { allowedRoots: ['..'] }, { allowedRoots: ['allowed/../..'] }, { allowedRoots: ['a\\..\\b'] }, { allowedRoots: ['ok', '../up'] }, { allowedRoots: ['a\0b'] }, { allowedRoots: ['.git'] }, { allowedRoots: ['.git/hooks'] }, { allowedRoots: ['sub/.GIT'] }, { allowedRoots: ['.git.'] }, { allowedRoots: ['~'] }, { allowedRoots: ['~/src'] }]) {
    const guards = []
    assert.throws(() => apply({ tools: { guard: (callback) => guards.push(callback) } }, config), /^Error: gentle-ai edit-guard: config\.allowedRoots /, JSON.stringify(config))
    assert.equal(guards.length, 0, 'an invalid mount registers no guard')
  }
  assert.deepEqual(validateRoots(['src', 'test/fixtures', '.', 'a..b', '.github', '.gitkeep']), ['src', 'test/fixtures', '.', 'a..b', '.github', '.gitkeep'])
  assert.ok(Object.isFrozen(validateRoots(['src'])))
})

// ---------- Resolution helpers ----------

test('resolveTarget joins the missing segments to the real deepest existing ancestor', () => {
  assert.equal(resolveTarget('allowed/existing.txt', PROJECT), join(ALLOWED, 'existing.txt'))
  assert.equal(resolveTarget('allowed/a/b.txt', PROJECT), join(ALLOWED, 'a', 'b.txt'))
  assert.equal(resolveTarget(join(ALLOWED, 'n.txt'), FORBIDDEN), join(ALLOWED, 'n.txt'))
  assert.equal(resolveTarget('allowed/existing.txt/below', PROJECT), join(ALLOWED, 'existing.txt', 'below'))
  if (JUNCTION) assert.equal(resolveTarget('allowed/link/secret.txt', PROJECT), join(OUTSIDE, 'secret.txt'))
  for (const [path, cwd] of [['', PROJECT], [undefined, PROJECT], ['a\0b', PROJECT], ['x', 'relative'], ['x', undefined]]) assert.throws(() => resolveTarget(path, cwd), JSON.stringify([path, cwd]))
})

test('insideRoots accepts a root and its descendants only', () => {
  assert.equal(insideRoots(ALLOWED, [ALLOWED]), true)
  assert.equal(insideRoots(join(ALLOWED, 'a', 'b'), [ALLOWED]), true)
  assert.equal(insideRoots(join(ALLOWED, '..foo'), [ALLOWED]), true)
  assert.equal(insideRoots(join(PROJECT, 'allowed-other'), [ALLOWED]), false)
  assert.equal(insideRoots(PROJECT, [ALLOWED]), false)
  assert.equal(insideRoots(join(OUTSIDE, 'x'), [FORBIDDEN, ALLOWED]), false)
  assert.equal(insideRoots(join(OUTSIDE, 'x'), [FORBIDDEN, OUTSIDE]), true)
  assert.equal(insideRoots(join(OUTSIDE, 'x'), []), false)
})

// ---------- Plugin shape ----------

test('edit-guard is a dsh plugin that injects only the tools service', () => {
  assert.equal(guard.name, 'gentle-ai-edit-guard')
  assert.deepEqual(guard.inject, ['tools'])
})

test('edit-guard takes its tool lists from the shared role table only', () => {
  const source = readFileSync(new URL('../lib/edit-guard.js', import.meta.url), 'utf8')
  assert.match(source, /from '\.\/roles\.js'/)
  assert.doesNotMatch(source, /'(glob|grep|read|write|edit|pwsh|bash)'/)
  assert.deepEqual(EDIT_TOOLS, ['edit', 'write'])
  for (const tool of ['apply_patch', 'pwsh', 'bash', 'working_directory']) assert.ok(!EDIT_TOOLS.includes(tool) && !READ_TOOLS.includes(tool), tool)
})

test('a path starting with ~ is denied instead of followed into the home directory', () => {
  // The host expands a leading ~ to the user home before it resolves anything,
  // so the guard cannot place it inside a root and must refuse the spelling.
  const { call } = host()
  // Only a leading tilde is expanded by the host; a `~` further in is an ordinary name.
  for (const requested of ['~/escape.txt', '~', '~' + String.fromCharCode(92) + 'escape.txt']) {
    const reason = call('write', { file_path: requested })
    assertDenied(reason, { tool: 'write', path: requested, cwd: PROJECT })
    assert.match(reason, /user home directory/, reason)
  }
})

test('.. after a link is resolved physically, so a link cannot carry the path outside', (t) => {
  if (!JUNCTION) return t.skip(NO_JUNCTION)
  const { call } = host()
  // allowed/link points at OUTSIDE, so on POSIX link/.. is its physical parent,
  // not the directory that holds the link: a lexical check would call this a
  // miss and let the write out. Windows normalises `..` lexically before the
  // filesystem sees it, so there the same spelling lands inside the root and
  // matches what the host does.
  const requested = 'allowed/link/../escape.txt'
  if (process.platform === 'win32') assert.equal(call('write', { file_path: requested }), undefined)
  else assertDenied(call('write', { file_path: requested }), { tool: 'write', path: requested, cwd: PROJECT })
  // Without a link, the same spelling stays inside and is still allowed.
  assert.equal(call('write', { file_path: 'allowed/../allowed/ok.txt' }), undefined)
})

test('a .git directory that is itself a link is denied by the spelling', (t) => {
  // Resolving first would lose the name: the realpath of a linked .git has no
  // .git segment, while git still follows it and runs the hook it finds.
  const linked = join(ROOT, 'linked-project')
  mkdirSync(join(linked, 'git-target', 'hooks'), { recursive: true })
  if (!link(join(linked, 'git-target'), join(linked, '.git'))) return t.skip(NO_JUNCTION)
  const { call } = host({ roots: ['.'], project: linked, cwd: linked })
  const requested = '.git/hooks/pre-commit'
  const reason = call('write', { file_path: requested })
  assertDenied(reason, { tool: 'write', path: requested, cwd: linked, roots: [linked] })
  assert.match(reason, /git directory/, reason)
})

test('the git directory is denied by its real path, so its target name is no way in', (t) => {
  // A `.git` that is a link hides the name: the hooks live under the target's
  // ordinary name, and neither spelling says `.git` there.
  const linked = join(ROOT, 'real-git-project')
  mkdirSync(join(linked, 'git-target', 'hooks'), { recursive: true })
  if (!link(join(linked, 'git-target'), join(linked, '.git'))) return t.skip(NO_JUNCTION)
  const { call } = host({ roots: ['.'], project: linked, cwd: linked })
  const requested = 'git-target/hooks/pre-commit'
  const reason = call('write', { file_path: requested })
  assertDenied(reason, { tool: 'write', path: requested, cwd: linked, roots: [linked] })
  assert.match(reason, /inside the git directory/, reason)
  // An ordinary project file stays writable: the rule is the git directory,
  // not the target's parent.
  assert.equal(call('write', { file_path: 'notes.txt' }), undefined)
})

test('a worktree .git file points at a git directory that is denied too', (t) => {
  const worktree = join(ROOT, 'worktree')
  // Inside the project on purpose: the git-dir rule, not the roots check, has
  // to be what denies this write.
  const gitdir = join(worktree, '.gitdir')
  mkdirSync(join(gitdir, 'hooks'), { recursive: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: .gitdir\n')
  const { call } = host({ roots: ['.'], project: worktree, cwd: worktree })
  const requested = join(gitdir, 'hooks', 'pre-commit')
  const reason = call('write', { file_path: requested })
  assertDenied(reason, { tool: 'write', path: requested, cwd: worktree, roots: [worktree] })
  assert.match(reason, /inside the git directory/, reason)
})

test('a file with more than one hard link is not writable through the guard', (t) => {
  // realpath keeps the in-project name, so a hard link to a file outside would
  // otherwise pass every check while the write lands on the outside inode.
  const outside = join(OUTSIDE, 'hard-target.txt')
  writeFileSync(outside, 'outside\n')
  const inside = join(ALLOWED, 'hard.txt')
  try {
    linkSync(outside, inside)
  } catch {
    return t.skip('this host cannot create a hard link')
  }
  const { call } = host()
  for (const tool of EDIT_TOOLS) {
    const reason = call(tool, { file_path: 'allowed/hard.txt' })
    assertDenied(reason, { tool, path: 'allowed/hard.txt', cwd: PROJECT })
    assert.match(reason, /hard links/, reason)
  }
  // A fresh file has no link to follow and stays writable.
  assert.equal(call('write', { file_path: 'allowed/fresh.txt' }), undefined)
  // The outside file is untouched: the guard denied before the tool ran.
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n')
})

test('a nested repository gets its git directory denied too', (t) => {
  // The root check would never look at project/nested/.git: a nested repo has
  // its own hooks, and its .git can be a link to an ordinary name as well.
  const project = join(ROOT, 'nested-project')
  mkdirSync(join(project, 'nested', 'git-target', 'hooks'), { recursive: true })
  mkdirSync(join(project, 'nested', 'src'), { recursive: true })
  if (!link(join(project, 'nested', 'git-target'), join(project, 'nested', '.git'))) return t.skip(NO_JUNCTION)
  const { call } = host({ roots: ['.'], project, cwd: project })
  const requested = 'nested/git-target/hooks/pre-commit'
  const reason = call('write', { file_path: requested })
  assertDenied(reason, { tool: 'write', path: requested, cwd: project, roots: [project] })
  assert.match(reason, /inside the git directory/, reason)
  // Ordinary files in the nested repository stay writable.
  assert.equal(call('write', { file_path: 'nested/src/ok.txt' }), undefined)
})

test('a drive-relative spelling is refused instead of resolved on another drive', () => {
  // `D:file` is not absolute, so a naive join would put it under the project
  // while the host resolves it against the process directory on drive D.
  const { call } = host()
  for (const requested of ['D:outside.txt', 'C:name', 'C:']) {
    const reason = call('write', { file_path: requested })
    assertDenied(reason, { tool: 'write', path: requested, cwd: PROJECT })
    assert.match(reason, /drive-relative/, reason)
  }
  assert.equal(call('write', { file_path: 'allowed/ok.txt' }), undefined)
})

test('a git directory shared by a nested repository is denied by its real path', (t) => {
  // nested/.git points at project/shared-git: a write through that ordinary
  // name never walks over nested/.git, so the scan has to find it.
  const project = join(ROOT, 'shared-project')
  // A git directory is recognised by its own contents, so the fixture has them.
  mkdirSync(join(project, 'shared-git', 'hooks'), { recursive: true })
  mkdirSync(join(project, 'shared-git', 'objects'), { recursive: true })
  mkdirSync(join(project, 'shared-git', 'refs'), { recursive: true })
  writeFileSync(join(project, 'shared-git', 'HEAD'), 'ref: refs/heads/main')
  mkdirSync(join(project, 'nested', 'src'), { recursive: true })
  if (!link(join(project, 'shared-git'), join(project, 'nested', '.git'))) return t.skip(NO_JUNCTION)
  const { call } = host({ roots: ['.'], project, cwd: project })
  const requested = 'shared-git/hooks/pre-commit'
  const reason = call('write', { file_path: requested })
  assertDenied(reason, { tool: 'write', path: requested, cwd: project, roots: [project] })
  assert.match(reason, /inside the git directory/, reason)
  assert.equal(call('write', { file_path: 'nested/src/ok.txt' }), undefined)
})

test('a project that is itself inside a git directory allows no edit at all', () => {
  const project = join(PROJECT, '.git', 'hooks')
  const { call } = host({ roots: ['.'], project, cwd: project })
  const reason = call('write', { file_path: 'pre-commit' })
  assertDenied(reason, { tool: 'write', path: 'pre-commit', cwd: project, roots: [project] })
  assert.match(reason, /inside a git directory/, reason)
})
