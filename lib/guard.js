// Hard guard for Engram project attribution (issue #6).
//
// dsh runs one Engram process for every session, so a write without an
// explicit, session-backed project lands in the dsh launch directory's
// project. dsh cannot rewrite tool arguments, but a `tools/pre-execute`
// listener can deny a call; the deny reason tells the model the exact fix.
import { resolve } from 'node:path'

const PREFIX = 'mcp__engram__'
const SESSION_START = `${PREFIX}mem_session_start`
// Write tools and the argument that names the target project.
const WRITES = {
  [`${PREFIX}mem_save`]: 'project',
  [`${PREFIX}mem_update`]: 'expected_project',
  [`${PREFIX}mem_session_summary`]: 'project',
  [`${PREFIX}mem_save_prompt`]: 'project',
}

export { SESSION_START }

/** Per-session map of working directory -> project backed by mem_session_start. */
export function createSessionProjects() {
  const byDirectory = new Map()
  return {
    record(directory, project) {
      if (directory && project) byDirectory.set(resolve(directory), project)
    },
    get(directory) {
      return directory ? byDirectory.get(resolve(directory)) : undefined
    },
  }
}

/** Project name from a successful mem_session_start result, if any. */
export function parseSessionStart(result) {
  if (!result || result.isError) return undefined
  for (const block of result.content ?? []) {
    if (block?.type !== 'text') continue
    try {
      const project = JSON.parse(block.text)?.project
      if (typeof project === 'string' && project) return project
    } catch {
      // Not JSON: keep looking.
    }
  }
  return undefined
}

/**
 * Decide whether an Engram write may run.
 * @param toolName - dsh tool name, e.g. mcp__engram__mem_save.
 * @param args - parsed tool arguments.
 * @param cwd - the calling session's current working directory.
 * @param project - project recorded by mem_session_start for that cwd.
 */
export function decideEngramWrite({ toolName, args, cwd, project }) {
  const field = WRITES[toolName]
  if (!field) return { kind: 'allow' }
  const passed = typeof args?.[field] === 'string' ? args[field].trim() : ''
  const start = `call ${SESSION_START} with directory="${cwd}" and a new unique id`
  if (!project) {
    return { kind: 'deny', reason: `Engram write blocked: no Engram session for this workspace yet. First ${start}, then retry passing ${field}="<the project it returns>".` }
  }
  if (passed !== project) {
    const got = passed ? `${field}="${passed}"` : `no ${field}`
    return { kind: 'deny', reason: `Engram write blocked: ${got} was passed, but this workspace's Engram project is "${project}". Retry passing ${field}="${project}". If the workspace changed, ${start} first.` }
  }
  return { kind: 'allow' }
}
