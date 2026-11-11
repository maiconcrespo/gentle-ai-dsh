// Enforced tool allowlist for the gentle-ai subagent role presets (issue #10).
//
// A dsh agent preset's own plugins are added to the tools a child inherits
// from the host; they never remove any. The only enforcement is
// `ctx.tools.restrict({ allow })` called by a plugin mounted inside the preset,
// which hides every inherited global tool outside the allowlist from that
// preset's agents ("unknown tool"). Tools a preset registers itself are exempt
// from its own restriction, so the role presets mount nothing but this plugin.
//
// The worker role stays read-only: edit surfaces are pending the guard
// contribution (C3). It must not get `edit`, `write`, `apply_patch`, a shell
// or `working_directory` until that guard exists.
//
// Any missing or unknown role throws before restricting anything, so the
// preset fails to mount and dsh refuses to start the child instead of running
// it with the inherited, unrestricted tools.

export const name = 'gentle-ai-role-restrict'
export const inject = ['tools']

const READ_ONLY = Object.freeze(['glob', 'grep', 'read'])

export const ROLE_TOOLS = Object.freeze(Object.assign(Object.create(null), {
  explore: READ_ONLY,
  verify: Object.freeze([...READ_ONLY, 'pwsh']),
  worker: READ_ONLY,
}))

const ROLES = Object.keys(ROLE_TOOLS).sort()

export function apply(ctx, config = {}) {
  const role = config?.role
  if (typeof role !== 'string' || !Object.hasOwn(ROLE_TOOLS, role)) {
    throw new Error(`gentle-ai role-restrict: unknown role ${JSON.stringify(role) ?? 'undefined'}; expected one of ${ROLES.join(', ')}`)
  }
  // dsh rejects names that are not registered global tools, so a missing tool
  // (for example `pwsh` on a non-Windows host) also fails the preset closed.
  ctx.tools.restrict({ allow: [...ROLE_TOOLS[role]] })
}
