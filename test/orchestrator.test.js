import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderOrchestrator } from '../lib/orchestrator.js'
import { sections } from '../index.js'

const shared = [
  '<!-- odd-orchestrator-section:Identity:start -->',
  '### Identity',
  'You are {{GENTLE_AI_RUNTIME_AGENT_ID}}.',
  '<!-- odd-orchestrator-fragment:identity.core:start -->',
  'Core role.',
  '<!-- odd-orchestrator-fragment:identity.core:end -->',
  '<!-- odd-orchestrator-section:Identity:end -->',
  '<!-- odd-orchestrator-section:Gate:start -->',
  'Gate with native review.',
  '<!-- odd-orchestrator-section:Gate:end -->',
  '<!-- odd-orchestrator-section:Gate (ODD only):start -->',
  'Gate without review.',
  '<!-- odd-orchestrator-section:Gate (ODD only):end -->',
  '<!-- odd-orchestrator-section:Native Checking Contract (ODD only):start -->',
  'Check with ordinary verification.',
  '<!-- odd-orchestrator-section:Native Checking Contract (ODD only):end -->',
].join('\n')

const generic = (capable) => [
  '<!-- section:model-capable -->',
  capable,
  '<!-- /section:model-capable -->',
  '<!-- section:model-small -->',
  'SMALL MODEL TEXT',
  '<!-- /section:model-small -->',
].join('\n')

test('renders the capable variant with ODD-only shared sections and the runtime id', () => {
  const out = renderOrchestrator(generic('# Orchestrator\n{{GENTLE_AI_ODD_SECTION:Identity}}\n{{GENTLE_AI_ODD_SECTION:Gate}}'), shared, 'dsh')
  assert.match(out, /You are dsh\./)
  assert.match(out, /Gate without review\./)
  assert.doesNotMatch(out, /SMALL MODEL TEXT/)
  assert.doesNotMatch(out, /odd-orchestrator-fragment|\{\{/)
})

test('removes the review execution contract and provider defect handoff, and rewrites native checking', () => {
  const capable = [
    '# Orchestrator',
    '#### Review Execution Contract',
    'review steps',
    '#### Cost and Context Balance',
    'balance text',
    '#### Gentle AI Provider Defect Handoff (MANDATORY)',
    'handoff text',
    '#### Native Checking Contract',
    'old checking',
    '#### Next',
    'next text',
  ].join('\n')
  const out = renderOrchestrator(generic(capable), shared, 'dsh')
  assert.doesNotMatch(out, /Review Execution Contract|review steps|handoff text|old checking/)
  assert.match(out, /balance text/)
  assert.match(out, /#### Native Checking Contract\n\nCheck with ordinary verification\./)
  assert.match(out, /next text/)
})

test('fails loudly on a missing shared section, leftover markers or review leaks', () => {
  assert.throws(() => renderOrchestrator(generic('{{GENTLE_AI_ODD_SECTION:Nope}}'), shared, 'dsh'), /Nope/)
  assert.throws(() => renderOrchestrator(generic('{{GENTLE_AI_OTHER}}'), shared, 'dsh'), /placeholder/)
  assert.throws(() => renderOrchestrator(generic('uses gentle-ai review'), shared, 'dsh'), /review content/)
  assert.throws(() => renderOrchestrator('no sections', shared, 'dsh'), /model-capable/)
})

test('shipped orchestrator.md is rendered, review-free and registered as a section', () => {
  const text = readFileSync(new URL('../orchestrator.md', import.meta.url), 'utf8')
  assert.ok(text.trim().length > 1000)
  // Faithful v4.4.0 render is ~31 KB; guard against unexpected growth.
  assert.ok(Buffer.byteLength(text) < 34000, `orchestrator.md is ${Buffer.byteLength(text)} bytes`)
  for (const leak of ['{{', 'gentle_review', 'Judgment Day', 'RDD', 'native review', 'odd-orchestrator-fragment']) {
    assert.ok(!text.includes(leak), `orchestrator.md contains ${leak}`)
  }
  const orchestrator = sections({ PATH: '' }).find((s) => s.name === 'gentle-ai:orchestrator')
  assert.ok(orchestrator, 'gentle-ai:orchestrator section missing')
  assert.equal(orchestrator.interpolate, false)
  assert.equal(orchestrator.text, text)
})
