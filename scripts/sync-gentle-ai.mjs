import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, validateSkill } from '../lib/skills.js'
import { composeOrchestratorPrompt, renderOrchestrator } from '../lib/orchestrator.js'
import { defaultBudgets, renderRouting } from '../lib/routing.js'
import { dshRuntimeAdaptation } from '../lib/dsh-runtime.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { gentleAi: { repository, ref } } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const temp = mkdtempSync(join(tmpdir(), 'gentle-ai-sync-'))
const source = join(temp, 'source')
try {
  execFileSync('git', ['clone', '--depth', '1', '--branch', ref, '--', repository, source], { stdio: 'inherit' })
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const personaPath = 'internal/assets/generic/persona-gentleman.md'
  const persona = readFileSync(join(source, personaPath), 'utf8')
  if (persona.includes('{{')) throw new Error('Persona contains template markers')
  const orchestratorPath = 'internal/assets/generic/orchestrator.md'
  const sectionsPath = 'internal/assets/skills/_shared/odd-orchestrator-sections.md'
  const orchestrator = composeOrchestratorPrompt(renderOrchestrator(readFileSync(join(source, orchestratorPath), 'utf8'), readFileSync(join(source, sectionsPath), 'utf8'), 'dsh'), renderRouting(defaultBudgets), dshRuntimeAdaptation)
  const skillRoot = join(source, 'skills')
  const skills = []
  for (const entry of readdirSync(skillRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(skillRoot, entry.name, 'SKILL.md')
    let text
    try { text = readFileSync(path, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const problems = validateSkill(parseFrontmatter(text))
    if (problems.length) {
      console.warn(`Skipping ${entry.name}: ${problems.join('; ')}`)
      continue
    }
    skills.push(entry.name)
  }
  skills.sort()
  const target = join(root, 'skills')
  rmSync(target, { recursive: true, force: true })
  for (const skill of skills) cpSync(join(skillRoot, skill), join(target, skill), { recursive: true })
  writeFileSync(join(root, 'persona.md'), persona)
  writeFileSync(join(root, 'orchestrator.md'), orchestrator)
  writeFileSync(join(root, 'NOTICE'), `Content from ${repository}\nRef: ${ref}\nCommit: ${commit}\nMIT License\nCopyright (c) 2025 Gentleman Programming\n\nPersona: ${personaPath}\nOrchestrator: ${orchestratorPath} + ${sectionsPath} + internal/components/agentguidance/routing.go + internal/agents/capabilitymanifest/manifest.go (rendered for dsh without review/RDD sections)\nShipped skill directories:\n${skills.map((skill) => `- skills/${skill}/`).join('\n')}\n\nEach skill's own frontmatter license may differ.\n`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
