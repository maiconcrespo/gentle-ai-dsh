// Shared gentle-ai subagent role table (issues #10 and #17).
//
// This module is the single source of the role policy: each role's name, dsh
// preset id, display title, preset description, role prompt and allowed
// tools. It has no dsh dependency, so the headless and acp adapter
// (cordis.patch.yml with lib/role-restrict.js) and future web or desktop
// adapters (#17) read the same table instead of restating it. The preset
// rows in cordis.patch.yml only name a role; tests check that their ids,
// titles and descriptions match this table.
//
// - explore: read-only search and read.
// - verify: read-only tools plus the platform shell for checks. The shell is
//   not limited by path or command, by design: the role trusts the exact
//   commands the parent names.
// - worker: read-only and fail-closed until the edit-surface guard (#16)
//   ships. It must not get `edit`, `write`, `apply_patch`, a shell or
//   `working_directory` before then.

const freeze = (entries) => Object.freeze(Object.assign(Object.create(null), entries))

const READ_ONLY = Object.freeze(['glob', 'grep', 'read'])

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
    description: 'Worker subagent role, read-only: edit surfaces pending the guard (#16).',
    prompt: 'You are a gentle-ai worker subagent. You are read-only until the edit-surface guard (#16) ships: you cannot edit files or run commands. Inspect the requested surfaces and return the exact changes for the parent to apply.',
    tools: READ_ONLY,
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
