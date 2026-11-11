// gentle-ai persona as a global system-prompt section.
//
// A uniquely named section is used instead of overriding the `system-prompt`
// row's `personaPrefix`: overriding that row would replace the whole config the
// base, web-app and headless bundles set, and presets shadow it per session.
import { readFileSync } from 'node:fs'
import { findOnPath } from './lib/engram.js'

export const name = 'gentle-ai'
export const inject = ['systemPrompt']

const PERSONA = readFileSync(new URL('./persona.md', import.meta.url), 'utf8')
const MISSING = 'Persistent memory (Engram) is not available in this session. The user can install it with brew install gentleman-programming/tap/engram (see https://github.com/Gentleman-Programming/engram), then restart dsh.'

export function sections(env = process.env) {
  const result = [{ name: 'gentle-ai:persona', text: PERSONA, interpolate: false }]
  if (!findOnPath('engram', env)) result.push({ name: 'gentle-ai:engram-missing', text: MISSING, interpolate: false })
  return result
}

export function apply(ctx, config = {}) {
  const descriptors = sections(config.env)
  if (descriptors.length > 1) {
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
}
