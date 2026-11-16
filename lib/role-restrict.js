// Enforced tool allowlist for the gentle-ai subagent role presets (issue #10).
//
// A dsh agent preset's own plugins are added to the tools a child inherits
// from the host; they never remove any. The only enforcement is
// `ctx.tools.restrict({ allow })` called by a plugin mounted inside the preset,
// which hides every inherited global tool outside the allowlist from that
// preset's agents ("unknown tool"). Tools a preset registers itself are exempt
// from its own restriction, so the role presets mount nothing but this plugin.
//
// The allowlists come from the shared role table in lib/roles.js; this plugin
// only enforces them. The worker role stays read-only until the edit-surface
// guard (#16) ships, and the verify role gets the host platform's shell
// (`pwsh` on Windows, `bash` on Linux and macOS), not limited by path.
//
// Any missing or unknown role, or a verify role on a platform without a known
// shell, throws before restricting anything, so the preset fails to mount and
// dsh refuses to start the child instead of running it with the inherited,
// unrestricted tools.
import { ROLE_NAMES, isRole, roleTools } from './roles.js'

export const name = 'gentle-ai-role-restrict'
export const inject = ['tools']

/** Restrict `ctx` to the allowlist of `role` on `platform`. */
export function restrictRole(ctx, role, platform = process.platform) {
  if (!isRole(role)) {
    throw new Error(`gentle-ai role-restrict: unknown role ${JSON.stringify(role) ?? 'undefined'}; expected one of ${ROLE_NAMES.join(', ')}`)
  }
  // Resolve before restricting: an unsupported platform throws here. dsh also
  // rejects names that are not registered global tools, so a shell the host
  // does not register fails the preset closed too.
  const allow = roleTools(role, platform)
  ctx.tools.restrict({ allow })
}

export function apply(ctx, config = {}) {
  restrictRole(ctx, config?.role, process.platform)
}
