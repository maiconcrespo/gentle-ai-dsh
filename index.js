// gentle-ai persona as a global system-prompt section.
//
// A uniquely named section is used instead of overriding the `system-prompt`
// row's `personaPrefix`: overriding that row would replace the whole config the
// base, web-app and headless bundles set, and presets shadow it per session.
import { readFileSync } from 'node:fs'

export const name = 'gentle-ai'
export const inject = ['systemPrompt']

const PERSONA = readFileSync(new URL('./persona.md', import.meta.url), 'utf8')

export function apply(ctx) {
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'gentle-ai:persona',
      order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: PERSONA,
      // The persona is literal text; never treat braces as template variables.
      interpolate: false,
    }),
  )
}
