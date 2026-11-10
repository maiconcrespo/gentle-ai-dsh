// Spike-only debug probe. Loaded with `--patch spike/probe/probe.patch.yml`
// to observe, without any model call, what the gentle-ai-dsh bundle
// contributes at runtime: the persona prompt section, the skill catalog and
// the Engram MCP tools. Writes one JSON report to $GENTLE_PROBE_OUT
// (dsh routes console output through its logger, so stdout is not reliable).
import { writeFileSync } from 'node:fs'

const OUT = process.env.GENTLE_PROBE_OUT ?? 'gentle-probe.json'

export const name = 'gentle-ai-probe'
export const inject = ['systemPrompt', 'skills', 'tools']

export function apply(ctx) {
  // Give MCP servers time to start and register their tools.
  const timer = setTimeout(() => probe(ctx).catch((error) => {
    writeFileSync(OUT, JSON.stringify({ error: error?.stack ?? String(error) }, null, 2))
  }), 8000)
  ctx.effect(() => () => clearTimeout(timer))
}

async function probe(ctx) {
  const assembly = await ctx.systemPrompt.assemble()
  const persona = assembly.sections.find((s) => s.name === 'gentle-ai:persona')
  const skills = await ctx.skills.list()
  const tools = toolNames(ctx.tools)
  writeFileSync(OUT, JSON.stringify({
    sections: assembly.sections.map((s) => s.name),
    persona: persona ? { chars: persona.text.length, firstLine: persona.text.split('\n')[0] } : null,
    skills: skills.map((s) => ({ name: s.name, provider: s.provider, source: s.source })),
    engramTools: tools.filter((n) => n.startsWith('mcp__engram__')),
    toolCount: tools.length,
  }, null, 2))
}

// Global (unscoped) tool definitions; session-scoped tools are not listed.
function toolNames(tools) {
  return tools.definitions().map((t) => t.name)
}
