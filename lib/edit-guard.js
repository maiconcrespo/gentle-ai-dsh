// Edit-surface guard for the gentle-ai worker role (issue #16).
//
// A dsh preset can only hide tools (lib/role-restrict.js); it cannot limit
// where a visible `write` or `edit` lands. This plugin, mounted inside the
// preset that grants those tools, registers a synchronous `ctx.tools.guard`
// that denies any edit outside the configured roots.
//
// Two bypasses measured in #16 shape the resolution. A guard that resolves
// against a fixed directory misses a cwd change (`subagent` accepts `cwd`, the
// `working_directory` tool moves it), so the requested path is resolved
// against the calling agent's current directory at call time. A lexical check
// misses a junction or symlink inside a root that points outside, so the
// target is resolved through the realpath of its deepest existing ancestor;
// new files have no realpath yet and must still be creatable.
//
// The roots themselves are anchored to the session's original project
// directory (its immutable header), never to the current directory: roots
// that followed the cwd would follow it out of the project too.
//
// A `.git` directory is never writable, whatever the roots: a hook written
// there runs code without any shell, which would undo withholding one.
//
// The guard sees the tree before the tool runs, so a link that another
// process creates in between is not caught; the worker deliberately has no
// shell or `apply_patch` with which to create one itself.
//
// A path guard cannot see paths a shell command or `apply_patch` text writes
// to, so those tools are never offered with it, and any tool name this guard
// does not know is denied: adding one later fails closed. A guard that throws
// crashes the call instead of denying it, so every failure becomes a one-line
// denial naming the tool, the requested path, the cwd and the allowed roots.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { EDIT_TOOLS, READ_TOOLS } from './roles.js'

export const name = 'gentle-ai-edit-guard'
// Only the tools service is injected. The working-directory service is looked
// up at call time: injecting it would leave the plugin pending, and the edit
// tools unguarded, on a host that never activates it, while a missing service
// at call time is simply a denial.
export const inject = ['tools']

const PREFIX = 'gentle-ai edit-guard'
const PASS = new Set(READ_TOOLS)
const CHECK = new Set(EDIT_TOOLS)
const MAX_SHOWN = 300

/**
 * Validate a mount's `allowedRoots`: a non-empty list of non-empty paths,
 * relative on every platform and without a `..` segment, so a root can only
 * name something inside the project. Throws, which fails the preset closed.
 */
export function validateRoots(roots) {
  const fail = (detail) => {
    throw new Error(`${PREFIX}: config.allowedRoots ${detail}; expected a non-empty list of relative paths inside the project, such as ["src", "test"]`)
  }
  if (!Array.isArray(roots) || roots.length === 0) fail('must be a non-empty array')
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim().length === 0) fail(`has an empty or non-string entry ${show(root)}`)
    if (root.includes('\0')) fail(`has an entry with a NUL character ${show(root)}`)
    // Checked under both path flavours: a Windows host must reject "/etc" and
    // a POSIX host "C:\\x", and a drive-relative "C:x" is not relative either.
    if (posix.isAbsolute(root) || win32.isAbsolute(root) || /^[a-zA-Z]:/.test(root)) fail(`has an absolute entry ${show(root)}`)
    if (root.split(/[\\/]/).includes('..')) fail(`has an entry with a ".." segment ${show(root)}`)
    // A leading tilde names a directory the host would expand to the user home,
    // which is not the root this config meant; refuse it at mount.
    if (root === '~' || /^~[\\/]/.test(root)) fail(`has an entry starting with "~" ${show(root)}`)
    // A root inside `.git` would make every target relative to it look clean.
    if (hasGitSegment(root, 'win32')) fail(`has an entry inside a .git directory ${show(root)}`)
  }
  return Object.freeze([...roots])
}

/**
 * The real target of `requested` resolved against the absolute `cwd`: the
 * realpath of its deepest existing ancestor joined with the segments that do
 * not exist yet. Throws when the path is unusable or a component exists but
 * cannot be resolved, such as a link whose target is missing (a write through
 * it would land wherever that target is later created).
 */
export function resolveTarget(requested, cwd) {
  if (typeof requested !== 'string' || requested.length === 0) throw new Error('the path must be a non-empty string')
  if (requested.includes('\0')) throw new Error('the path contains a NUL character')
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('the working directory is not an absolute path')
  // `C:name` is drive-relative on Windows: not absolute, and the host resolves
  // it against the process directory on that drive instead of the cwd, which
  // would put the write somewhere this guard never looked at.
  if (/^[a-zA-Z]:/.test(requested) && !win32.isAbsolute(requested)) {
    throw new Error('a drive-relative path like "C:name" is resolved by the host against another directory; use a path inside the project')
  }
  // The host expands a leading `~` to the user's home before resolving, which
  // is outside every root this guard is given; the guard cannot follow that
  // expansion, so it refuses the spelling outright.
  // Both separators are checked explicitly: a character class here lost the
  // backslash once already, and `~\file` is the spelling Windows uses.
  if (requested === '~' || requested.startsWith('~/') || requested.startsWith('~\\')) {

    throw new Error('a path starting with "~" is expanded by the host to the user home directory, outside the project')
  }
  // The host resolves the spelling it is given, and on POSIX it keeps a `..`
  // after a link physical: `link/../x` means x after link's target, not x
  // lexically beside the link. Joining without collapsing preserves that, and
  // the walk below realpaths each real parent, so both meanings agree.
  const absolute = isAbsolute(requested) ? requested : `${cwd}${sep}${requested}`
  const missing = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    }
    if (exists(current)) throw new Error(`${show(current)} exists but its real path cannot be resolved (a link whose target is missing)`)
    const parent = dirname(current)
    if (parent === current) throw new Error(`no part of ${show(absolute)} exists`)
    missing.unshift(basename(current))
    current = parent
  }
}

/**
 * Whether the relative path `rel` has a `.git` segment. Windows and macOS
 * name files case-insensitively by default, so `.GIT` is the same directory
 * there; Windows also drops trailing dots and spaces from a name and accepts a
 * `::$INDEX_ALLOCATION` stream suffix on a directory, so `.git.` and
 * `.git::$INDEX_ALLOCATION` name it too. Folding more than the host does only
 * denies more.
 */
export function hasGitSegment(rel, platform = process.platform) {
  const folded = platform === 'win32' || platform === 'darwin'
  return String(rel).split(/[\\/]/).some((segment) => {
    let name = segment
    if (platform === 'win32') name = name.split(':')[0].replace(/[. ]+$/, '')
    return (folded ? name.toLowerCase() : name) === '.git'
  })
}

/** Whether `target` is one of `roots` or inside one; all paths already real. */
export function insideRoots(target, roots) {
  return roots.some((root) => {
    const rel = relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
}

/** The real git directory a `.git` entry names, whether a directory, a link or a worktree file. */
function gitTarget(dot, base) {
  try {
    const real = realpathSync.native(dot)
    const info = statSync(real)
    if (info.isDirectory()) return real
    if (info.isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(real, 'utf8'))
      if (match !== null) return realpathSync.native(resolve(base, match[1].trim()))
    }
  } catch {
    // No git directory here, or one that cannot be resolved: nothing to deny.
  }
  return undefined
}

/**
 * Whether `directory` is itself a git directory, judged by its own contents: a
 * `HEAD` file plus `objects` and `refs`. This is how a shared git directory is
 * found without scanning the whole project — a nested repository's `.git` may
 * point anywhere, but the directory it points at always looks like this.
 */
function looksLikeGitDirectory(directory) {
  try {
    return statSync(join(directory, 'HEAD')).isFile()
      && statSync(join(directory, 'objects')).isDirectory()
      && statSync(join(directory, 'refs')).isDirectory()
  } catch {
    return false
  }
}

/**
 * The git directory that holds `target`, walking up to `stopAt`. Every level is
 * checked because a repository can be nested inside another one, and its `.git`
 * can be a link to an ordinary name: a write through that name would run a hook
 * in a repository whose `.git` the project root check never looked at.
 */
function enclosingGitDirectory(target, stopAt) {
  let directory = dirname(target)
  for (;;) {
    const found = gitTarget(join(directory, '.git'), directory)
    if (found !== undefined && insideRoots(target, [found])) return found
    if (directory === stopAt || dirname(directory) === directory) return undefined
    directory = dirname(directory)
  }
}

/**
 * Link count of an existing regular file, or 0 for anything else. A directory
 * reports one link per subdirectory on POSIX, so counting it here would deny
 * every directory target with a misleading reason; the git rules own those.
 */
function fileLinkCount(path) {
  try {
    const info = statSync(path)
    return info.isFile() ? info.nlink : 0
  } catch {
    return 0
  }
}

function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

// One line, bounded, and never throws: it builds the denial itself.
function show(value) {
  let text
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : value === undefined ? '(none)' : JSON.stringify(value)
  } catch {
    text = undefined
  }
  if (typeof text !== 'string') {
    try { text = String(value) } catch { text = '(unprintable)' }
  }
  text = text.replace(/\s+/g, ' ')
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text
}

function denial(tool, reason, { path, cwd, roots }) {
  const listed = Array.isArray(roots) && roots.length > 0 ? roots.map(show).join(', ') : '(none)'
  const why = String(reason ?? 'denied').replace(/\s+/g, ' ').replace(/\.$/, '')
  return `${PREFIX} denied ${show(tool)}: ${why}. Requested path: ${show(path)}; cwd: ${show(cwd)}; allowed roots: ${listed}.`
}

function argumentsOf(exec) {
  const args = exec?.arguments
  if (typeof args === 'string') {
    try { return JSON.parse(args) } catch { return undefined }
  }
  return args
}

function workingDirectoryService(ctx) {
  if (typeof ctx?.get === 'function') return ctx.get('workingDirectory', false)
  return ctx?.workingDirectory
}

/**
 * The guard callback for `roots` (validated, relative to the project). It
 * returns undefined to leave a call alone, or a one-line denial reason.
 */
export function createGuard(ctx, roots) {
  return (exec) => {
    const facts = { path: undefined, cwd: undefined, roots: [...roots] }
    let tool
    try {
      tool = exec?.name
      if (typeof tool === 'string' && PASS.has(tool)) return undefined
      const args = argumentsOf(exec)
      facts.path = args?.file_path
      const service = workingDirectoryService(ctx)
      const session = exec?.agent?.session
      if (typeof service?.get === 'function' && session !== undefined) facts.cwd = service.get(session)
      const project = session?.header?.cwd ?? service?.defaultDirectory
      if (typeof project === 'string' && isAbsolute(project)) facts.roots = roots.map((root) => resolve(project, root))
      if (typeof tool !== 'string' || !CHECK.has(tool)) {
        return denial(tool, `this worker can only call ${[...PASS, ...CHECK].map((t) => `"${t}"`).join(', ')}; any other tool is refused, including shells and apply_patch, whose paths this guard cannot check`, facts)
      }
      if (facts.cwd === undefined) {
        return denial(tool, 'the working-directory service or the calling session is unavailable, so the path cannot be resolved', facts)
      }
      if (typeof project !== 'string' || !isAbsolute(project)) {
        return denial(tool, 'the session has no absolute project directory to anchor the allowed roots', facts)
      }
      if (typeof facts.path !== 'string' || facts.path.length === 0) {
        return denial(tool, 'file_path must be a non-empty string', facts)
      }
      const projectReal = realpathSync.native(project)
      const allowed = []
      for (const root of roots) {
        const real = resolveTarget(root, project)
        if (!insideRoots(real, [projectReal])) {
          return denial(tool, `the allowed root ${show(root)} resolves to ${show(real)}, outside the project ${show(projectReal)}`, facts)
        }
        allowed.push(real)
      }
      const target = resolveTarget(facts.path, facts.cwd)
      const matching = allowed.filter((root) => insideRoots(target, [root]))
      if (matching.length === 0) {
        return denial(tool, `the path resolves to ${show(target)}, outside the allowed roots; use a path inside one of them`, facts)
      }
      // The git directory is denied by its real path as well: a `.git` that is
      // a link, or a worktree's `.git` file, hides it from the spelling checks,
      // at any depth — a nested repository has its own hooks.
      // A project that is itself inside a git directory has no safe target.
      if (hasGitSegment(projectReal)) {
        return denial(tool, 'the project directory is inside a git directory, so no edit is allowed', facts)
      }
      const gitDir = enclosingGitDirectory(target, projectReal)
      if (gitDir !== undefined) {
        return denial(tool, `the path resolves to ${show(target)}, inside the git directory ${show(gitDir)}, which this guard never allows (a hook there runs code without a shell)`, facts)
      }
      // An ancestor that is itself a git directory is the shared case: a nested
      // repository's `.git` can point anywhere in the project, and the target's
      // own ancestors then say nothing. Its contents do.
      for (let directory = dirname(target); ; directory = dirname(directory)) {
        if (looksLikeGitDirectory(directory)) {
          return denial(tool, `the path resolves to ${show(target)}, inside the git directory ${show(directory)}, which this guard never allows (a hook there runs code without a shell)`, facts)
        }
        if (directory === projectReal || dirname(directory) === directory) break
      }
      // A hard link inside the project can name an inode whose other links
      // live outside it, and realpath keeps the in-project name, so a
      // multiply-linked file is not writable through this guard.
      const links = fileLinkCount(target)
      if (links > 1) {
        return denial(tool, `the path resolves to ${show(target)}, which has ${links} hard links; another link may live outside the project, so it is not writable`, facts)
      }
      // Both spellings are checked: the realpath loses the name when `.git` is
      // itself a link inside the project, and the raw spelling loses the
      // truth when a link resolves into a `.git` directory.
      if (hasGitSegment(facts.path) || matching.some((root) => hasGitSegment(relative(root, target)))) {
        return denial(tool, `the path resolves to ${show(target)}, inside the git directory, which this guard never allows (a hook there runs code without a shell)`, facts)
      }
      return undefined
    } catch (error) {
      let message
      try { message = error?.message ?? String(error) } catch { message = 'unknown error' }
      return denial(tool, `the path could not be checked (${message})`, facts)
    }
  }
}

/** Mount the guard for this preset's `config.allowedRoots`. */
export function apply(ctx, config = {}) {
  const roots = validateRoots(config?.allowedRoots)
  // The disposer is bound to this plugin's scope by dsh, so unmounting the
  // preset removes the guard with it.
  return ctx.tools.guard(createGuard(ctx, roots))
}
