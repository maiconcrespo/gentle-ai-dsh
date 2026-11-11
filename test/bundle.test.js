import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { parseFrontmatter, validateSkill } from '../lib/skills.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('skill frontmatter validation', () => {
  const parse = (body) => parseFrontmatter(`---\n${body}\n---\n# Skill`)
  assert.deepEqual(validateSkill(parse('name: good-name\ndescription: useful')), [])
  assert.deepEqual(validateSkill(parse('name: good\ndescription: "quoted: text"')), [])
  assert.ok(validateSkill(parse('description: useful')).length)
  assert.ok(validateSkill(parse('name: BadName\ndescription: useful')).length)
  assert.ok(validateSkill(parse('name: good')).length)
})

test('bundle metadata and shipped content', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.ok(pkg.dsh.bundle.patch)
  assert.ok(pkg.engines.dsh)
  for (const file of ['index.js', 'lib', 'persona.md', 'cordis.patch.yml', 'skills']) assert.ok(pkg.files.includes(file), file)
  assert.ok(pkg.exports['./package.json'])
  for (const id of ['gentle-ai', 'gentle-ai-skills', 'gentle-ai-engram', 'tool-subagent', 'agent-preset-registry', 'gentle-ai-preset-explore', 'gentle-ai-preset-verify', 'gentle-ai-preset-worker']) assert.match(read('../cordis.patch.yml'), new RegExp(`id: ${id}(?:\\s|$)`))
  assert.ok(pkg.exports['./role-restrict'])
  const dirs = readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory())
  assert.ok(dirs.length)
  for (const dir of dirs) assert.deepEqual(validateSkill(parseFrontmatter(read(`../skills/${dir.name}/SKILL.md`))), [], dir.name)
  const persona = read('../persona.md')
  assert.ok(persona.trim())
  assert.ok(!persona.includes('{{'))
  assert.ok(read('../NOTICE').includes(pkg.gentleAi.ref))
})
