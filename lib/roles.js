// Shared gentle-ai subagent role table (issues #10 and #17).
//
// This module is the single source of the role policy: each role's name, dsh
// preset id, display title, preset description, role prompt, allowed tools
// and, for a role that edits, its allowed roots. It has no dsh dependency, so the headless and acp adapter
// (lib/role-presets.js registering presets that mount lib/role-restrict.js) and
// future web or desktop adapters (#17) read the same table instead of
// restating it. The preset definitions are built from this table at start;
// tests check that their ids, titles and descriptions match it.
//
// - explore: read-only search and read.
// - verify: read-only tools plus the platform shell for checks. The shell is
//   not limited by path or command, by design: the role trusts the exact
//   commands the parent names.
// - worker: the read-only tools plus `edit` and `write`, which its preset
//   only grants together with the edit-surface guard (#16) limited to
//   `allowedRoots`, resolved against the session's original project. It gets
//   no `apply_patch`, shell or `working_directory`: a path guard cannot see
//   the paths those write to, and a shell or a `.git` hook would run code.

const freeze = (entries) => Object.freeze(Object.assign(Object.create(null), entries))

const READ_ONLY = Object.freeze(['glob', 'grep', 'read'])

// The edit-surface guard (lib/edit-guard.js, #16) reads these two lists: it
// lets the read tools through unchanged, checks the path of every edit tool and
// denies any other name, so a tool added to a role later fails closed there
// instead of bypassing the guard. Both tools take one `file_path` argument;
// `apply_patch` carries its paths inside free text and is deliberately absent.
export const READ_TOOLS = READ_ONLY
export const EDIT_TOOLS = Object.freeze(['edit', 'write'])

export const DEFAULT_ROLE = 'explore'

export const ROLES = freeze({
  explore: Object.freeze({
    name: 'explore',
    preset: 'gentle-ai-explore',
    title: 'gentle-ai explore',
    description: 'Read-only subagent role: glob, grep and read.',
    prompt: 'You are a gentle-ai explore subagent. Search and read the workspace to answer the delegated question, and report findings with exact file paths. You cannot edit files or run commands.',
    tools: READ_ONLY,
    shell: false,
  }),
  verify: Object.freeze({
    name: 'verify',
    preset: 'gentle-ai-verify',
    title: 'gentle-ai verify',
    description: 'Verification subagent role: glob, grep, read and the platform shell (pwsh on Windows, bash on Linux and macOS) for checks.',
    prompt: 'You are a gentle-ai verify subagent. Run only the exact checks named in your task and report each command with its observed result. Your shell is not limited by path or command, so never run anything else and never edit files.',
    tools: READ_ONLY,
    shell: true,
  }),
  worker: Object.freeze({
    name: 'worker',
    preset: 'gentle-ai-worker',
    title: 'gentle-ai worker',
    description: 'Worker subagent role: glob, grep, read, and write and edit inside the project only (edit-surface guard, #16); no shell or apply_patch.',
    prompt: 'You are a gentle-ai worker subagent. You can search and read, and create or change files with write and edit, but only inside the project directory and never inside a .git directory: the edit-surface guard (#16) denies any other path and says why. You have no shell and no apply_patch, so you cannot run commands, tests or builds; change only the surfaces your task names and report each file you changed.',
    tools: Object.freeze([...READ_ONLY, ...EDIT_TOOLS]),
    allowedRoots: Object.freeze(['.']),
    shell: false,
  }),
})

export const ROLE_NAMES = Object.freeze(Object.keys(ROLES).sort())

// The shell tool dsh registers per host platform. Any other platform has no
// known shell, so a role that needs one fails closed there.
const SHELLS = freeze({ win32: 'pwsh', linux: 'bash', darwin: 'bash' })

export function shellTool(platform = process.platform) {
  if (typeof platform !== 'string' || !Object.hasOwn(SHELLS, platform)) {
    throw new Error(`gentle-ai roles: no verify shell for platform ${JSON.stringify(platform) ?? 'undefined'}; expected win32 (pwsh), linux or darwin (bash)`)
  }
  return SHELLS[platform]
}

export function isRole(role) {
  return typeof role === 'string' && Object.hasOwn(ROLES, role)
}

/** A fresh copy of the exact tool allowlist of `role` on `platform`. */
export function roleTools(role, platform = process.platform) {
  if (!isRole(role)) {
    throw new Error(`gentle-ai roles: unknown role ${JSON.stringify(role) ?? 'undefined'}; expected one of ${ROLE_NAMES.join(', ')}`)
  }
  const entry = ROLES[role]
  return entry.shell ? [...entry.tools, shellTool(platform)] : [...entry.tools]
}
