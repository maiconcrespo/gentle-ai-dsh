// Helpers for test/c2-replay.test.js. No function here deletes, moves or
// overwrites anything outside the directories the caller passes in, and none
// of them removes files: scratch is preserved for inspection.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, lstatSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export const sha256File = (file) => sha256(readFileSync(file))

// A dsh persisted session (session.vN.jsonl.zstd) is a concatenation of zstd
// frames. Same decoding as the P0 tools/session-dump.mjs reference tool.
export function decodeZstdFrames(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = buf.indexOf(magic); i >= 0; i = buf.indexOf(magic, i + 1)) starts.push(i)
  let out = ''
  let pos = 0
  while (pos < buf.length) {
    const nexts = starts.filter((s) => s > pos).concat([buf.length])
    let ok = false
    for (const end of nexts) {
      try {
        out += zstdDecompressSync(buf.subarray(pos, end)).toString('utf8')
        pos = end
        ok = true
        break
      } catch { /* the magic bytes occurred inside a frame payload; extend */ }
    }
    if (!ok) throw new Error(`cannot decode zstd frame at byte ${pos}`)
  }
  return out
}

/** Decoded JSONL lines of one persisted session, exactly as persisted. */
export function readSessionLines(file) {
  const raw = readFileSync(file)
  const text = file.endsWith('.zstd') ? decodeZstdFrames(raw) : raw.toString('utf8')
  return text.split('\n').filter((line) => line.length > 0)
}

export function readSessionEvents(file) {
  return readSessionLines(file).map((line) => JSON.parse(line))
}

/** Every persisted session log under `dir`, recursively. */
export function findSessionFiles(dir) {
  const found = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) found.push(p)
    }
  }
  walk(dir)
  return found.sort()
}

/** Extract an npm pack tarball (ustar, optional pax headers) into `dest`. */
export function extractTgz(file, dest) {
  const buf = gunzipSync(readFileSync(file))
  const root = resolve(dest)
  const written = []
  let offset = 0
  let paxPath
  const str = (b) => b.toString('utf8').replace(/\0.*$/s, '')
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = str(header.subarray(0, 100))
    const size = parseInt(str(header.subarray(124, 136)).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = str(header.subarray(345, 500))
    const body = buf.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      paxPath = m?.[1]
      continue
    }
    if (type === 'g') continue
    const entry = paxPath ?? (prefix ? `${prefix}/${name}` : name)
    paxPath = undefined
    if (type !== '0' && type !== '5') throw new Error(`unsupported tar entry type ${type} for ${entry}`)
    const target = resolve(root, entry)
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`tar entry escapes destination: ${entry}`)
    if (type === '5') { mkdirSync(target, { recursive: true }); continue }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, { flag: 'wx' })
    written.push(entry)
  }
  return written
}

/** Files under `dir` (no symlink or junction is followed), with size and sha256. */
export function listTree(dir) {
  const out = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      const rel = relative(dir, p).split(sep).join('/')
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out.push({ path: rel, type: 'link' })
      else if (st.isDirectory()) { out.push({ path: rel, type: 'dir' }); walk(p) }
      else out.push({ path: rel, type: 'file', size: st.size, sha256: sha256File(p) })
    }
  }
  walk(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function statOrNull(p) {
  try {
    const st = statSync(p)
    return { mtime: st.mtime.toISOString(), isDirectory: st.isDirectory() }
  } catch (error) {
    return { missing: String(error.code ?? error) }
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replace absolute local paths with stable placeholders in any text: raw,
 * forward-slash and JSON-escaped (doubled backslash) forms, case-insensitive.
 * Longer paths are replaced first.
 */
export function makeSanitizer(pairs) {
  const rules = []
  for (const [path, label] of [...pairs].sort((a, b) => b[0].length - a[0].length)) {
    if (!path) continue
    const forms = new Set([path, path.replace(/\\/g, '/'), path.replace(/\\/g, '\\\\'), path.replace(/\\/g, '\\\\\\\\')])
    for (const form of [...forms].sort((a, b) => b.length - a.length)) rules.push([new RegExp(escapeRe(form), 'gi'), label])
  }
  return (text) => {
    let out = String(text)
    for (const [re, label] of rules) out = out.replace(re, label)
    return out
  }
}

// ReplayEntry builders (dsh-llm-replay lib/types): one model call each.
const usage = { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
export function toolEntry(id, name, args) {
  const argumentsText = JSON.stringify(args)
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } },
      usage,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  }
}
export function textEntry(text) {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      usage,
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

/** Text of a tool/result event (all text blocks joined). */
export function resultText(event) {
  const content = event?.data?.message?.content ?? []
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
}

/** Tool names offered in a request/header event. */
export function headerToolNames(event) {
  const tools = event?.data?.header?.tools ?? event?.data?.tools
  if (!Array.isArray(tools)) return undefined
  return tools.map((t) => t?.name ?? t?.function?.name).sort()
}

/** Assistant texts of a session, in order. */
export function assistantTexts(events) {
  return events
    .filter((e) => e.type === 'assistant/message')
    .map((e) => (e.data?.message?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join(''))
}
