import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertCrossPlatformScratch, renderOrchestrator, substituteScratchCommand } from '../lib/orchestrator.js'
import { defaultBudgets, renderRouting } from '../lib/routing.js'

const powershellForm = 'New-Item -ItemType Directory -Path'

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

test('the routing guidance names a scratch command both platforms have', () => {
  const text = renderRouting(defaultBudgets)
  assert.ok(text.includes(powershellForm), 'routing does not carry the PowerShell form')
  assert.ok(text.includes('`mktemp -d` on POSIX or '), 'routing does not name the POSIX form first')
  assert.doesNotThrow(() => assertCrossPlatformScratch(text))
})

test('the render gives every upstream spelling of the command its Windows form', () => {
  const spellings = ['created with `mktemp -d` under the system temp dir.', 'run `mktemp -d -p x` first.', 'run `mktemp -d -t scratch` first.', 'run mktemp -d first.']
  for (const spelling of spellings) {
    const out = renderOrchestrator(generic(spelling), shared, 'dsh')
    assert.ok(out.includes(powershellForm), `${spelling} did not get the PowerShell form`)
    assert.ok(!/[^\s`]\s*`\s*(first|under)/.test(out), `${spelling} left a fragment behind: ${out}`)
    assert.doesNotThrow(() => assertCrossPlatformScratch(out), spelling)
  }
})

test('substituting an already phrased mention changes nothing', () => {
  const once = substituteScratchCommand('created with `mktemp -d` under the system temp dir.')
  assert.equal(substituteScratchCommand(once), once)
})

test('the committed orchestrator.md ships no bare `mktemp -d`', () => {
  const text = readFileSync(new URL('../orchestrator.md', import.meta.url), 'utf8')
  assert.doesNotThrow(() => assertCrossPlatformScratch(text))
  assert.ok(text.includes(powershellForm), 'orchestrator.md does not carry the PowerShell form')
})
