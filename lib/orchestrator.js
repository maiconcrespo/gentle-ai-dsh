// Render the gentle-ai generic orchestrator for dsh (issue #3, "Genérico recortado").
//
// Mirrors gentle-ai v4.4.0 internal/components/agentguidance/orchestrator.go
// renderOrchestrator for the generic asset of a runtime WITHOUT review
// transport and WITHOUT receipt-driven development (RDD):
//   1. selectGenericOrchestrator: keep the model-capable section, drop model-small.
//   2. expandSharedOrchestratorSections(rdd=false): replace each
//      {{GENTLE_AI_ODD_SECTION:<name>}} with the "<name> (ODD only)" shared
//      section when it exists, else "<name>"; strip fragment marker lines.
//   3. removeSection("#### Review Execution Contract" .. "Cost and Context
//      Balance"): dsh has no gentle-ai review transport.
//   4. stripReceiptDrivenDevelopment: remove "#### Gentle AI Provider Defect
//      Handoff (MANDATORY)", replace the "#### Native Checking Contract" body
//      with the ODD-only section, apply the non-RDD wording replacements, and
//      fail if any review/RDD marker leaks.
//   5. Replace {{GENTLE_AI_RUNTIME_AGENT_ID}}; fail on any leftover {{GENTLE_AI_.

const SECTION_PLACEHOLDER = /\{\{GENTLE_AI_ODD_SECTION:([^}]*)\}\}/g
const FRAGMENT_LINE = /^<!-- odd-orchestrator-fragment:[a-z]+\.[a-z0-9-]+:(?:start|end) -->\n/gm
const RUNTIME_ID = '{{GENTLE_AI_RUNTIME_AGENT_ID}}'
const ODD_ONLY = ' (ODD only)'
const REVIEW_HEADING = '#### Review Execution Contract'
const REVIEW_NEXT = 'Cost and Context Balance'
const DEFECT_HANDOFF = '#### Gentle AI Provider Defect Handoff (MANDATORY)'
const NATIVE_CHECKING = '#### Native Checking Contract'

const NON_RDD_REPLACEMENTS = [
  ['| Tests, builds, installs, or native review actions |', '| Tests, builds, installs, or verification actions |'],
  ['| High-risk change, or long suites, builds, installs, or native review actions of a large task |', '| High-risk change, or long suites, builds, installs, or verification actions of a large task |'],
  ['tests, builds, installs, and native review actors may use fresh workers', 'tests, builds, installs, and verification actors may use fresh workers'],
  ['run applicable tests, builds, and native review actions as bounded steps', 'run applicable tests, builds, and verification actions as bounded steps'],
  ['- Let the native review and delivery providers select checking and delivery actions; repeated gates reuse exact authority and never reopen review for unchanged content.', '- Let the user and ordinary repository policy decide delivery; do not infer authorization from checking output.'],
  ['- Let native review select its bounded checking plan; delivery remains human-owned under ordinary repository policy.', '- Let the user and ordinary repository policy decide delivery; do not infer authorization from checking output.'],
]

const LEAK_MARKERS = ['RDD', 'receipt', 'Receipt', 'refuter', 'native review', 'Native review', 'gentle-ai review', 'review-integration', 'Native Compact Review Orchestration', 'Provider Defect Handoff']

export function assertNoReviewLeaks(content) {
  for (const marker of LEAK_MARKERS) {
    if (content.includes(marker)) throw new Error(`orchestrator without receipt-driven development still carries review content ${JSON.stringify(marker)}`)
  }
}

export function composeOrchestratorPrompt(orchestrator, routing, adaptation) {
  return [orchestrator, routing, adaptation].map((part) => part.trim()).join('\n\n') + '\n'
}

function selectCapable(content) {
  const parts = {}
  for (const name of ['capable', 'small']) {
    const open = `<!-- section:model-${name} -->`
    const close = `<!-- /section:model-${name} -->`
    const start = content.indexOf(open)
    const end = content.indexOf(close)
    if (content.split(open).length !== 2 || content.split(close).length !== 2 || end < start + open.length) {
      throw new Error(`invalid generic orchestrator model-${name} section`)
    }
    parts[name] = { start, end: end + close.length, body: content.slice(start + open.length, end) }
  }
  if (parts.capable.end > parts.small.start) throw new Error('generic orchestrator model sections overlap or are out of order')
  return content.slice(0, parts.capable.start) + parts.capable.body + content.slice(parts.capable.end, parts.small.start) + content.slice(parts.small.end)
}

function sharedSection(shared, name) {
  const open = `<!-- odd-orchestrator-section:${name}:start -->`
  const close = `<!-- odd-orchestrator-section:${name}:end -->`
  const start = shared.indexOf(open)
  const end = shared.indexOf(close)
  if (start < 0 || end < start) return ''
  return shared.slice(start + open.length, end).replace(FRAGMENT_LINE, '').trim()
}

function lineStart(content, needle) {
  if (content.startsWith(needle)) return 0
  const i = content.indexOf('\n' + needle)
  return i < 0 ? -1 : i + 1
}

// Bounds of a heading block: up to the next heading of the same or higher level.
function headingBlock(content, heading) {
  const start = lineStart(content, heading + '\n')
  if (start < 0) return null
  const level = heading.length - heading.replace(/^#+/, '').length
  let offset = start + heading.length + 1
  while (offset < content.length) {
    const lineEnd = content.indexOf('\n', offset)
    const line = lineEnd < 0 ? content.slice(offset) : content.slice(offset, lineEnd)
    const hashes = line.length - line.replace(/^#+/, '').length
    if (hashes > 0 && hashes <= level && line[hashes] === ' ') return { start, end: offset }
    if (lineEnd < 0) break
    offset = lineEnd + 1
  }
  return { start, end: content.length }
}

function joinAround(content, start, end, middle = '') {
  return content.slice(0, start).replace(/\n+$/, '') + '\n\n' + middle + content.slice(end).replace(/^\n+/, '')
}

function removeSection(content, heading, nextHeading) {
  const start = content.indexOf(heading)
  if (start < 0) return content
  let end = content.length
  const rest = content.slice(start + heading.length)
  for (const prefix of ['\n#### ', '\n### ', '\n## ']) {
    const rel = rest.indexOf(prefix + nextHeading)
    if (rel >= 0) { end = start + heading.length + rel + 1; break }
  }
  return joinAround(content, start, end)
}

/**
 * @param generic - internal/assets/generic/orchestrator.md text.
 * @param shared - internal/assets/skills/_shared/odd-orchestrator-sections.md text.
 * @param runtimeId - value for {{GENTLE_AI_RUNTIME_AGENT_ID}}.
 */
export function renderOrchestrator(generic, shared, runtimeId) {
  let content = selectCapable(generic)
  const missing = []
  content = content.replace(SECTION_PLACEHOLDER, (match, name) => {
    const body = sharedSection(shared, name + ODD_ONLY) || sharedSection(shared, name)
    if (!body) { missing.push(name); return match }
    return body
  })
  if (missing.length) throw new Error(`shared orchestrator sections ${JSON.stringify(missing)} have no canonical body`)

  content = removeSection(content, REVIEW_HEADING, REVIEW_NEXT)

  const handoff = headingBlock(content, DEFECT_HANDOFF)
  if (handoff) content = joinAround(content, handoff.start, handoff.end)
  const checking = sharedSection(shared, 'Native Checking Contract' + ODD_ONLY)
  if (!checking) throw new Error('shared orchestrator section "Native Checking Contract (ODD only)" has no canonical body')
  const block = headingBlock(content, NATIVE_CHECKING)
  if (block) content = content.slice(0, block.start) + NATIVE_CHECKING + '\n\n' + checking + '\n\n' + content.slice(block.end).replace(/^\n+/, '')
  for (const [from, to] of NON_RDD_REPLACEMENTS) content = content.split(from).join(to)
  assertNoReviewLeaks(content)

  content = content.split(RUNTIME_ID).join(runtimeId)
  if (content.includes('{{GENTLE_AI_')) throw new Error('unresolved template placeholder in generic orchestrator')
  if (content.includes('odd-orchestrator-fragment:')) throw new Error('malformed module fragment marker survived the render')
  return content.trim() + '\n'
}
