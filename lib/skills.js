export function parseFrontmatter(text) {
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  const result = {}
  if (!match) return result
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(name|description):[ \t]*(.*)$/)
    if (!field) continue
    let value = field[2].trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) } catch { value = '' }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'")
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    result[field[1]] = value
  }
  return result
}

export function validateSkill(frontmatter) {
  const problems = []
  if (typeof frontmatter.name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(frontmatter.name)) problems.push('name must be kebab-case')
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) problems.push('description must be non-empty')
  return problems
}
