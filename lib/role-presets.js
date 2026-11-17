// Registers the gentle-ai role presets from the shared role table (issues #10,
// #17 and #20).
//
// A composition patch can only insert rows or override an existing row by id;
// it has no per-profile condition. Preset rows written there would therefore
// exist in web and desktop too, where the host registers no global `glob`,
// `grep` or `read`: the preset could not mount, so dsh would offer a role that
// always fails instead of simply not offering it. This plugin registers the
// same presets at start and offers only the roles whose whole allowlist is a
// global tool of this host; everywhere else it skips them with one log line.
//
// Registration is not the enforcement. Each preset mounts
// `gentle-ai-dsh/role-restrict`, which restricts the child to the allowlist in
// lib/roles.js, and a role that edits also mounts `gentle-ai-dsh/edit-guard`
// with its `allowedRoots` from the same table. Neither registers a tool, so
// nothing is exempt from the restriction. A skipped role is never started at
// all, so no child ever runs with the inherited, unrestricted tools.
import { EDIT_TOOLS, ROLE_NAMES, ROLES, isRole, roleTools } from './roles.js'

export const name = 'gentle-ai-role-presets'
// The plugin itself requires nothing, so it is loaded at every boot; the
// registration runs in `ctx.inject` once the tools and agent-presets services
// are active. A plugin-level `inject` would keep the whole registration
// pending on a host that never activates one of them.

const RESTRICT = Object.freeze({ id: 'role-restrict', name: 'gentle-ai-dsh/role-restrict' })
const EDIT_GUARD = Object.freeze({ id: 'edit-guard', name: 'gentle-ai-dsh/edit-guard' })

function log(ctx, message) {
  const logger = ctx?.logger?.('gentle-ai')
  if (typeof logger?.warn === 'function') logger.warn(message)
  else console.warn(message)
}

/**
 * The global tool names this host registers, or undefined when it exposes no
 * tools view. A scoped context is not used: the presets are registered for the
 * whole host, so the global view is the one that decides.
 */
export function globalTools(ctx) {
  const tools = typeof ctx?.get === 'function' ? ctx.get('tools', false) : ctx?.tools
  const view = typeof tools?.view === 'function' ? tools.view(undefined) : undefined
  return view?.restrictableNames instanceof Set ? view.restrictableNames : undefined
}

/** The `agentPresets.register` definition of `role`, built from the role table. */
export function definition(role) {
  if (!isRole(role)) throw new Error(`gentle-ai role-presets: unknown role ${JSON.stringify(role) ?? 'undefined'}; expected one of ${ROLE_NAMES.join(', ')}`)
  const entry = ROLES[role]
  const plugins = [{ ...RESTRICT, config: { role } }]
  // An edit tool without roots would be an unguarded write: refuse the
  // definition rather than register it.
  if (entry.tools.some((tool) => EDIT_TOOLS.includes(tool))) {
    if (!Array.isArray(entry.allowedRoots) || entry.allowedRoots.length === 0) {
      throw new Error(`gentle-ai role-presets: role ${role} has edit tools but no allowedRoots; refusing an unguarded preset`)
    }
    plugins.push({ ...EDIT_GUARD, config: { allowedRoots: [...entry.allowedRoots] } })
  }
  return {
    id: entry.preset,
    name: entry.title,
    description: entry.description,
    plugins,
  }
}

/**
 * The tool every role needs, and therefore the one that decides whether this
 * host can mount the roles at all. The shell is deliberately not part of the
 * gate: it is a platform property, and a host without it fails that one preset
 * closed at mount instead of hiding every role.
 */
export const COMMON_TOOLS = Object.freeze(['glob', 'grep', 'read'])

/**
 * The presets this host can mount, and why the rest are skipped. `known` is
 * the global tool set; undefined means the host exposed no tool view at all,
 * which skips every role rather than assuming the set is complete.
 */
export function planPresets(known, platform = process.platform) {
  const missing = known === undefined ? [...COMMON_TOOLS] : COMMON_TOOLS.filter((tool) => !known.has(tool))
  if (missing.length > 0) {
    const reason = `no global tool ${missing.map((tool) => `"${tool}"`).join(', ')}`
    return { register: [], skipped: ROLE_NAMES.map((role) => ({ role, missing: [...missing], reason })) }
  }
  const register = []
  const skipped = []
  for (const role of ROLE_NAMES) {
    if (!ROLES[role].shell) {
      register.push(role)
      continue
    }
    try {
      roleTools(role, platform)
      register.push(role)
    } catch (error) {
      skipped.push({ role, missing: [], reason: error.message })
    }
  }
  return { register, skipped }
}

function register(ctx, config) {
  const platform = config?.platform ?? process.platform
  const { register: mountable, skipped } = planPresets(globalTools(ctx), platform)
  if (skipped.length > 0) {
    const detail = skipped.map(({ role, reason }) => `${role}: ${reason}`).join('; ')
    log(ctx, `gentle-ai skipped ${skipped.length} of ${ROLE_NAMES.length} subagent role presets on this host (${detail}); the host may register the role tools per agent instead, see #17`)
  }
  for (const role of mountable) {
    const registration = ctx.agentPresets.register(definition(role))
    registration.catch((error) => log(ctx, `gentle-ai could not register the ${role} preset: ${error?.message ?? error}`))
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        let dispose
        registration.then((fn) => { dispose = fn }, () => {})
        return () => { if (typeof dispose === 'function') dispose() }
      })
    }
  }
  return mountable
}

/** Wait for the services the registration needs, then register the presets. */
export function apply(ctx, config = {}) {
  if (typeof ctx?.inject !== 'function') return []
  return ctx.inject(['tools', 'agentPresets'], (scoped) => register(scoped, config))
}
