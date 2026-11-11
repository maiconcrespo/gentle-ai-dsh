// gentle-ai persona as a global system-prompt section.
//
// A uniquely named section is used instead of overriding the `system-prompt`
// row's `personaPrefix`: overriding that row would replace the whole config the
// base, web-app and headless bundles set, and presets shadow it per session.
import { readFileSync } from 'node:fs'
import { findOnPath } from './lib/engram.js'
import { SESSION_START, createSessionProjects, decideEngramWrite, sessionStartProject } from './lib/guard.js'

export const name = 'gentle-ai'
export const inject = ['systemPrompt', 'workingDirectory']

const PERSONA = readFileSync(new URL('./persona.md', import.meta.url), 'utf8')
const MISSING = 'Persistent memory (Engram) is not available in this session. The user can install it with brew install gentleman-programming/tap/engram (see https://github.com/Gentleman-Programming/engram), then restart dsh.'

// dsh starts one Engram process for every session, with the directory dsh was
// launched from as its cwd, so Engram's default project is the launch
// directory, not the session workspace. dsh cannot rewrite tool arguments or
// scope an MCP server per session, so the agent is told to pass the session's
// project explicitly (issue #4).
const PROJECT = [
  'Engram memory project: the Engram server is shared by every dsh session and its default project is the directory dsh was launched from, not your workspace. Never rely on that default.',
  'Before your first Engram call in a session, call mem_session_start with a new unique `id` (for example dsh- followed by the current timestamp) and `directory` set to the current working directory from your context. Remember the returned project name. Starting the session is what lets Engram accept that project, even for a workspace it has never seen; mem_current_project alone does not.',
  'Then pass that name as `project` on every Engram call that accepts it, including mem_save, mem_update (as `expected_project`), mem_search, mem_context, mem_session_summary and mem_save_prompt. Never omit `project` to make an error go away: that silently falls back to the wrong project.',
  'If the current working directory changes, call mem_session_start again for the new directory.',
].join('\n')

export function sections(env = process.env) {
  const result = [{ name: 'gentle-ai:persona', text: PERSONA, interpolate: false }]
  if (findOnPath('engram', env)) result.push({ name: 'gentle-ai:engram-project', text: PROJECT, interpolate: false })
  else result.push({ name: 'gentle-ai:engram-missing', text: MISSING, interpolate: false })
  return result
}

export function apply(ctx, config = {}) {
  const descriptors = sections(config.env)
  if (descriptors.some((d) => d.name === 'gentle-ai:engram-missing')) {
    const logger = ctx.logger?.('gentle-ai')
    if (typeof logger?.warn === 'function') logger.warn(MISSING)
    else console.warn(MISSING)
  }
  for (const descriptor of descriptors) {
    ctx.effect(() => ctx.systemPrompt.section({
      ...descriptor,
      order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    }))
  }
  if (descriptors.some((d) => d.name === 'gentle-ai:engram-project')) guardEngramWrites(ctx)
}

// Hard guard behind the prompt instruction (issue #6): deny Engram writes that
// do not pass the project backed by mem_session_start for the session's cwd.
function guardEngramWrites(ctx) {
  const bySession = new WeakMap()
  const projectsOf = (agent) => {
    const key = agent?.session ?? agent
    if (!key) return undefined
    if (!bySession.has(key)) bySession.set(key, createSessionProjects())
    return bySession.get(key)
  }
  const cwdOf = (agent) => (agent?.session ? ctx.workingDirectory?.get(agent.session) : undefined)

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== SESSION_START) return
    // Never infer the directory from the session cwd: an omitted directory
    // makes Engram use its launch directory (review finding R3).
    const directory = exec.arguments?.directory ?? exec.arguments?.cwd
    projectsOf(exec.agent)?.record(directory, sessionStartProject(result, directory))
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const cwd = cwdOf(exec.agent)
    const decision = decideEngramWrite({
      toolName: exec.name,
      args: exec.arguments,
      cwd,
      project: projectsOf(exec.agent)?.get(cwd),
    })
    return decision.kind === 'deny' ? decision : next()
  })
}
