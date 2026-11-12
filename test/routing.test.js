import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderRouting, defaultBudgets } from '../lib/routing.js'
import { composeOrchestratorPrompt, assertNoReviewLeaks } from '../lib/orchestrator.js'
import { dshRuntimeAdaptation } from '../lib/dsh-runtime.js'

test('generic routing contains canonical protocol, budgets, and no review leaks', () => {
  const text = renderRouting(defaultBudgets)
  for (const sentence of ['### ODD protocol (MANDATORY, in this order, on every request)', 'at most 3 calls, approximately 10k tokens', 'approximately 150k parent-context tokens', 'Verification covers a work-unit commit']) assert.ok(text.includes(sentence), sentence)
  assert.doesNotMatch(text, /\{\{|### Receipt-driven development is user-owned/)
  assert.doesNotThrow(() => assertNoReviewLeaks(text))
  assert.throws(() => assertNoReviewLeaks('native review'), /review content/)
})

test('routing interpolates all budget fields', () => {
  const text = renderRouting({ maxEvidenceBatches: 2, maxEvidenceCalls: 7, approxEvidenceTokens: 12000, approxSequentialLookupLimit: 8, approxHandoffTokens: 4000, maxParentSpotChecks: 9, approxParentContextTokens: 160000 })
  for (const fragment of ['at most 7 calls, approximately 12k tokens', 'one parallel batch (2 maximum)', 'approximately 8 sequential lookups', 'approximately 4k tokens', 'spot check (9 maximum)', 'approximately 160k parent-context tokens']) assert.ok(text.includes(fragment), fragment)
})

test('shipped prompt composes orchestrator, routing and dsh adaptation in order', () => {
  const text = readFileSync(new URL('../orchestrator.md', import.meta.url), 'utf8')
  const routing = text.indexOf('\n## Implementation Routing\n')
  const adaptation = text.indexOf('\n## dsh runtime adaptation\n')
  assert.ok(routing > 0 && adaptation > routing)
  assert.equal(text.split('## Implementation Routing').length - 1, 8)
  assert.equal(text.slice(routing + 1, adaptation + 1), renderRouting(defaultBudgets).trim() + '\n\n')
  assert.ok(text.endsWith(dshRuntimeAdaptation.trim() + '\n'))
  assert.equal(text, composeOrchestratorPrompt(text.slice(0, routing), renderRouting(defaultBudgets), dshRuntimeAdaptation))
  assert.equal(composeOrchestratorPrompt('first\n', 'second\n', 'third\n'), 'first\n\nsecond\n\nthird\n')
})

test('dsh adaptation documents runtime-specific overrides', () => {
  for (const part of ['takes precedence', 'subagent_fork', 'returns immediately', 'empty conversation', 'exact allowed edit surfaces', '<available_skills>', '.atl/skill-registry.md', '_shared/skill-resolver.md', '~/.claude/skills', '~/.config/opencode/skills', '.agents/skills', 'mem_session_start', 'session working directory', 'parent saves', 'mirror is pending', 'independent read-only verifier']) assert.ok(dshRuntimeAdaptation.includes(part), part)
  assert.ok(Buffer.byteLength(dshRuntimeAdaptation) < 2048)
})
