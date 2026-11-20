import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copySkills, excludedSkills, isEntryPoint, listSkills } from '../scripts/sync-gentle-ai.mjs'

const rdd = ['rdd-advisory-transport', 'rdd-defect-workflow']

function writeSkill(root, name, frontmatter = `name: ${name}\ndescription: useful`) {
  mkdirSync(join(root, name, 'references'), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\n${frontmatter}\n---\n# ${name}\n`)
  writeFileSync(join(root, name, 'references', 'note.md'), 'note\n')
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gentle-ai-dsh-skills-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the sync excludes exactly the RDD skills', () => {
  assert.deepEqual([...excludedSkills].sort(), rdd)
})

test('the shipped tree carries no RDD skill', () => {
  const shipped = readdirSync(new URL('../skills/', import.meta.url))
  for (const name of rdd) assert.ok(!shipped.includes(name), `skills/${name} is shipped`)
  const notice = readFileSync(new URL('../NOTICE', import.meta.url), 'utf8')
  for (const name of rdd) assert.ok(!notice.includes(name), `NOTICE names ${name}`)
})

test('a sync of a source that contains the RDD skills copies nothing from them', (t) => {
  const dir = scratch(t)
  const source = join(dir, 'source')
  const target = join(dir, 'target')
  for (const name of ['good-skill', ...rdd]) writeSkill(source, name)
  // A stale copy left by an older sync must not survive either.
  writeSkill(target, 'rdd-defect-workflow')
  assert.deepEqual(listSkills(source), ['good-skill'])
  assert.deepEqual(copySkills(source, target), ['good-skill'])
  assert.deepEqual(readdirSync(target), ['good-skill'])
  assert.ok(existsSync(join(target, 'good-skill', 'references', 'note.md')))
})

test('the sync still skips directories without a valid SKILL.md', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const source = scratch(t)
  writeSkill(source, 'good-skill')
  writeSkill(source, 'BadName', 'name: BadName\ndescription: useful')
  mkdirSync(join(source, 'no-skill-file'))
  writeFileSync(join(source, 'loose.md'), 'not a directory\n')
  assert.deepEqual(listSkills(source), ['good-skill'])
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /^Skipping BadName: name must be kebab-case$/)
})

test('the script runs when it is reached through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-entry-'))
  const target = join(dir, 'real.mjs')
  const link = join(dir, 'link.mjs')
  writeFileSync(target, ['export {}', ''].join('\n'))
  symlinkSync(target, link)
  assert.equal(isEntryPoint(target, pathToFileURL(target).href), true)
  assert.equal(isEntryPoint(link, pathToFileURL(target).href), true, 'a symlinked entry point must still run the sync')
  assert.equal(isEntryPoint(join(dir, 'other.mjs'), pathToFileURL(target).href), false)
  assert.equal(isEntryPoint(undefined, pathToFileURL(target).href), false)
  assert.equal(realpathSync(link), realpathSync(target))
})
