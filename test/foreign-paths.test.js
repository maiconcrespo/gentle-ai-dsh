import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FOREIGN_PATH_PATTERNS, FOREIGN_PATH_SUBSTITUTIONS, FOREIGN_PATH_TOKENS, assertNoForeignPaths, renderOrchestrator } from '../lib/orchestrator.js'

const shared = [
  '<!-- odd-orchestrator-section:Native Checking Contract (ODD only):start -->',
  'Check with ordinary verification.',
  '<!-- odd-orchestrator-section:Native Checking Contract (ODD only):end -->',
].join('\n')

const generic = (body) => [
  '<!-- section:model-capable -->',
  body,
  '<!-- /section:model-capable -->',
  '<!-- section:model-small -->',
  'SMALL MODEL TEXT',
  '<!-- /section:model-small -->',
].join('\n')

// Upstream-shaped skill discovery text carrying every foreign skill path.
const upstream = [
  '# Skill discovery',
  '1. Read `.atl/skill-registry.md` when present.',
  '2. Search common project/user skill directories such as `./skills`, `.agents/skills`, `~/.config/opencode/skills`, `~/.claude/skills`, and other configured skill roots.',
  '3. Follow the protocol (see `_shared/skill-resolver.md` in the skills directory).',
  '4. Fallback: read `.atl/skill-registry.md` if engram not available',
].join('\n')

test('the render substitutes every foreign skill path with the dsh discovery surface', () => {
  const out = renderOrchestrator(generic(upstream), shared, 'dsh')
  for (const [from] of FOREIGN_PATH_SUBSTITUTIONS) assert.ok(!out.includes(from), `${JSON.stringify(from)} survived the render`)
  for (const token of FOREIGN_PATH_TOKENS) assert.ok(!out.includes(token), `${token} survived the render`)
  assert.ok(out.includes('the `<available_skills>` catalog'), out)
  assert.ok(out.includes('the `SKILL.md` path the `skill` tool reports for each skill'), out)
  assert.ok(out.includes('ask the `skill` tool which skills this session has'), out)
  assert.doesNotThrow(() => assertNoForeignPaths(out))
})

test('the post-substitution assertion throws and names the surviving foreign token', () => {
  for (const token of FOREIGN_PATH_TOKENS) {
    assert.throws(() => assertNoForeignPaths(`ships ${token} today`), (error) => {
      assert.match(error.message, /foreign skill path/)
      assert.ok(error.message.includes(token), `${JSON.stringify(error.message)} does not name ${token}`)
      return true
    })
  }
})

test('the committed orchestrator.md ships no foreign skill path', () => {
  const text = readFileSync(new URL('../orchestrator.md', import.meta.url), 'utf8')
  for (const { token, pattern } of FOREIGN_PATH_PATTERNS) assert.ok(!pattern.test(text), `orchestrator.md ships ${token}`)
  assert.doesNotThrow(() => assertNoForeignPaths(text))
})
