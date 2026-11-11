// C2 integration evidence (issue #10, odd/tasks/c2-role-presets.md T3).
//
// Boots the pinned @deepseek-ai/dsh@0.2.2-rc.1 headless runner with the keyless
// replay provider @deepseek-ai/dsh-llm-replay@0.2.2-rc.1 and this package
// installed into an isolated profile the way a user installs it:
// `npm pack` of the working tree, then `dsh plugin --profile headless add`.
// For each role (explore, verify, fail-closed worker) a parent session spawns
// one child through the bundle's `subagent` tool with an explicit
// `agent_preset`, and the test checks: the spawn returns at once, the parent
// gets the background completion notice, the child's exact tool roster, every
// tool outside the allowlist answers `unknown tool`, the allowed tools work and
// the workspace on disk is unchanged.
//
// Not covered: per-role model routing (unverified; agentOptions per tool
// instance is the only confirmed mechanism), real models, web/ACP profiles,
// non-Windows hosts.
//
// Requirements: an existing install of exactly those two packages, found at
// $C2_DSH_INSTALL, <tmpdir>/c2-dsh/install or <parent of tmpdir>/c2-dsh/install.
// Without one the test is skipped. Nothing is installed from the network:
// pnpm runs with --offline and both plugins are local directories.
//
// Isolation: every run uses a fresh directory under os.tmpdir() for DSH_HOME,
// DSH_AGENTS_HOME, the pnpm store, npm cache and logs, workspaces and
// evidence. The test never accesses ~/.dsh in any way, not even its metadata;
// it only refuses a DSH_HOME whose path contains a `.dsh` segment, a check on
// the string that inspects nothing on disk. Isolation is checked only from
// test-owned state: every dsh command's DSH_HOME, dsh's own profile-init log
// line, the bundle layer in the composed config, and new session logs under
// <run>\dsh-home\sessions after every headless run. Variables whose names look
// like credentials are removed from every child environment. This test never
// deletes anything: its scratch stays for inspection, and sanitized evidence is
// written to <run>/evidence for copying into test/c2-replay/evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assistantTexts, extractTgz, findSessionFiles, headerToolNames, listTree, makeSanitizer,
  readSessionEvents, readSessionLines, resultText, sha256File, textEntry, toolEntry,
} from './c2-replay/lib.mjs'

const PIN = '0.2.2-rc.1'
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const OVERLAY = join(REPO, 'test', 'c2-replay', 'replay.patch.yml')
const ROLES = {
  explore: ['glob', 'grep', 'read'],
  verify: ['glob', 'grep', 'pwsh', 'read'],
  worker: ['glob', 'grep', 'read'],
}
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH)/i
const DSH_TIMEOUT_MS = 240_000

function locateInstall() {
  const candidates = [
    process.env.C2_DSH_INSTALL,
    join(tmpdir(), 'c2-dsh', 'install'),
    join(dirname(tmpdir()), 'c2-dsh', 'install'),
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) return { dir: resolve(dir), candidates }
  }
  return { reason: `no dsh ${PIN} install found (checked: ${candidates.join(', ')}); set C2_DSH_INSTALL`, candidates }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}...[${s.length - n} more chars]` : s)

test(`C2 role presets on dsh ${PIN} replay with the installed bundle`, { timeout: 45 * 60_000 }, async (t) => {
  const located = locateInstall()
  if (!located.dir) {
    t.skip(located.reason)
    return
  }
  const INSTALL = located.dir
  const RUN = mkdtempSync(join(tmpdir(), 'c2-replay-'))
  const EVIDENCE = join(RUN, 'evidence')
  const LOGS = join(RUN, 'logs')
  for (const d of [EVIDENCE, LOGS, join(EVIDENCE, 'logs'), join(RUN, 'fixtures')]) mkdirSync(d, { recursive: true })
  const sanitize = makeSanitizer([
    [RUN, '<RUN>'], [INSTALL, '<DSH_INSTALL>'], [REPO, '<REPO>'],
    [tmpdir(), '<TMP>'], [dirname(tmpdir()), '<TMP_PARENT>'], [homedir(), '<HOME>'],
  ])
  const evidence = (name, data) => {
    const file = join(EVIDENCE, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, sanitize(typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'))
  }
  const progressFile = join(EVIDENCE, 'progress.log')
  const progress = (line) => {
    const text = `${new Date().toISOString()} ${line}`
    appendFileSync(progressFile, sanitize(text) + '\n')
    console.error(`[c2-replay] ${sanitize(text)}`)
  }
  progress(`START run root=${RUN}`)

  const commands = []
  const summary = { pin: PIN, started: new Date().toISOString(), setup: {}, roles: {}, checks: [] }

  // Child environment: no credential-like variables, no inherited DSH_*/NODE_OPTIONS/test-runner state.
  const stripped = []
  const dropped = []
  const base = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k)) stripped.push(k)
    else if (/^DSH_/i.test(k) || /^NODE_OPTIONS$/i.test(k) || /^NODE_TEST/i.test(k) || /^C2_/i.test(k)) dropped.push(k)
    else base[k] = v
  }
  const DSH_HOME = join(RUN, 'dsh-home')
  const AGENTS_HOME = join(RUN, 'agents-home-empty')
  mkdirSync(AGENTS_HOME, { recursive: true })
  const dshEnv = (extra = {}) => {
    const env = { ...base, DSH_HOME, DSH_AGENTS_HOME: AGENTS_HOME, DSH_TELEMETRY_MODE: 'DISABLED', DO_NOT_TRACK: '1', ...extra }
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
    const leaked = Object.keys(env).filter((k) => /API_?KEY/i.test(k))
    if (leaked.length > 0) throw new Error(`credential-like variables in child env: ${leaked.join(', ')}`)
    return env
  }
  const DSH_BIN = join(INSTALL, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  const run = (label, args, { cwd, env, timeout = DSH_TIMEOUT_MS, bin = DSH_BIN }) => {
    const started = new Date()
    progress(`START ${label}`)
    const r = spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true })
    const ended = new Date()
    const stdoutFile = join(LOGS, `${label}.stdout.txt`)
    const stderrFile = join(LOGS, `${label}.stderr.txt`)
    writeFileSync(stdoutFile, r.stdout ?? '')
    writeFileSync(stderrFile, r.stderr ?? '')
    evidence(`logs/${label}.stdout.txt`, truncate(r.stdout ?? '', 200_000))
    evidence(`logs/${label}.stderr.txt`, truncate(r.stderr ?? '', 200_000))
    const record = {
      label,
      argv: ['node', bin, ...args],
      cwd,
      env: Object.fromEntries(Object.entries(env).filter(([k]) => /^(DSH_|DO_NOT_TRACK|XDG_|npm_config_)/i.test(k))),
      start: started.toISOString(),
      end: ended.toISOString(),
      durationMs: ended - started,
      exitCode: r.status,
      signal: r.signal,
      spawnError: r.error ? String(r.error.code ?? r.error.message) : null,
      stdout: `logs/${label}.stdout.txt`,
      stderr: `logs/${label}.stderr.txt`,
    }
    commands.push(record)
    progress(`END ${label} exit=${r.status} signal=${r.signal} error=${record.spawnError} durationMs=${record.durationMs}`)
    return { ...record, stdoutText: r.stdout ?? '', stderrText: r.stderr ?? '' }
  }
  const sessionsFor = (cwd) => findSessionFiles(join(DSH_HOME, 'sessions'))
    .map((file) => ({ file, events: readSessionEvents(file) }))
    .filter((s) => s.events[0]?.type === 'session' && typeof s.events[0].cwd === 'string' && samePath(s.events[0].cwd, cwd))
  const headless = (label, ws, script, { childFile, mode, prompt }) => {
    const scriptFile = join(RUN, 'fixtures', `${label}.replay.json`)
    writeFileSync(scriptFile, JSON.stringify(script, null, 1) + '\n')
    evidence(`fixtures/${label}.replay.json`, readFileSync(scriptFile, 'utf8'))
    // Effective DSH_HOME, from test-owned state only: the run must persist new
    // session logs for its own workspace under <RUN>\dsh-home\sessions.
    const before = findSessionFiles(join(DSH_HOME, 'sessions')).length
    const result = run(label, ['--profile', 'headless', '--patch', OVERLAY, '--permission-mode', mode, '--approval-policy', 'never', '--json', prompt], {
      cwd: ws,
      env: dshEnv({ DSH_SNAPSHOT_FILE: scriptFile, DSH_SNAPSHOT_OVERRIDE: scriptFile, DSH_SNAPSHOT_CHILD_FILES: childFile }),
    })
    const sessionFiles = { before, after: findSessionFiles(join(DSH_HOME, 'sessions')).length, forWorkspace: sessionsFor(ws).length }
    commands.at(-1).sessionFilesUnderDshHome = sessionFiles
    return { ...result, sessionFilesUnderDshHome: sessionFiles }
  }

  const writeEvidence = () => {
    summary.ended = new Date().toISOString()
    evidence('commands.json', commands)
    evidence('summary.json', summary)
  }

  // ---------- Setup (any failure here stops before every probe) ----------
  let roster
  let profileDir
  try {
    const dshPkg = readJson(join(INSTALL, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const replayDir = join(INSTALL, 'node_modules', '@deepseek-ai', 'dsh-llm-replay')
    const replayPkg = readJson(join(replayDir, 'package.json'))
    summary.setup.versions = { node: process.version, dsh: dshPkg.version, 'dsh-llm-replay': replayPkg.version, installManifest: readJson(join(INSTALL, 'package.json')) }
    summary.setup.environment = { strippedCredentialLikeNames: stripped.sort(), droppedNames: dropped.sort(), DSH_HOME, DSH_AGENTS_HOME: AGENTS_HOME, tmpdir: tmpdir() }
    if (dshPkg.version !== PIN || replayPkg.version !== PIN) throw new Error(`pin mismatch: dsh ${dshPkg.version}, dsh-llm-replay ${replayPkg.version}, expected ${PIN}`)
    if (/[\\/]\.dsh([\\/]|$)/i.test(DSH_HOME) || !resolve(RUN).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase() + sep)) throw new Error(`refusing DSH_HOME ${DSH_HOME}`)

    // 1. Pack the working tree as npm would publish it, then extract the tarball.
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npmCli)) throw new Error(`npm CLI not found next to node: ${npmCli}`)
    const packDir = join(RUN, 'pack')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(RUN, 'empty.npmrc'), '')
    const npmEnv = {
      ...base,
      npm_config_cache: join(RUN, 'npm-cache'), npm_config_logs_dir: join(RUN, 'npm-logs'),
      npm_config_userconfig: join(RUN, 'empty.npmrc'), npm_config_update_notifier: 'false',
      npm_config_fund: 'false', npm_config_audit: 'false',
    }
    const pack = run('setup-01-npm-pack', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { cwd: REPO, env: npmEnv, timeout: 120_000, bin: npmCli })
    if (pack.exitCode !== 0) throw new Error(`npm pack exited ${pack.exitCode}`)
    const packed = JSON.parse(pack.stdoutText)[0]
    const tarball = join(packDir, packed.filename)
    const bundleRoot = join(RUN, 'bundle')
    const extracted = extractTgz(tarball, bundleRoot)
    const STAGED = join(bundleRoot, 'package')
    const fileHashes = packed.files.map((f) => {
      const staged = sha256File(join(STAGED, f.path))
      const repo = sha256File(join(REPO, f.path))
      return { path: f.path, size: f.size, sha256: staged, matchesWorkingTree: staged === repo }
    })
    summary.setup.pack = { filename: packed.filename, integrity: packed.integrity, shasum: packed.shasum, entryCount: packed.entryCount, extracted: extracted.length, files: fileHashes }
    const mismatched = fileHashes.filter((f) => !f.matchesWorkingTree)
    if (mismatched.length > 0) throw new Error(`packed files differ from the working tree: ${mismatched.map((f) => f.path).join(', ')}`)
    if (!fileHashes.some((f) => f.path === 'lib/role-restrict.js')) throw new Error('lib/role-restrict.js is not in the packed bundle')

    // 2. Install the packed bundle and the replay provider into the isolated headless profile.
    const xdg = Object.fromEntries(['CONFIG', 'CACHE', 'STATE', 'DATA'].map((k) => [`XDG_${k}_HOME`, join(RUN, 'xdg', k.toLowerCase())]))
    const pnpmEnv = dshEnv({ ...xdg, npm_config_userconfig: join(RUN, 'empty.npmrc'), npm_config_update_notifier: 'false' })
    const storeDir = `--store-dir=${join(RUN, 'pnpm-store')}`
    const addBundle = run('setup-02-plugin-add-bundle', ['plugin', '--profile', 'headless', 'add', '--offline', storeDir, STAGED], { cwd: RUN, env: pnpmEnv, timeout: 300_000 })
    if (addBundle.exitCode !== 0) throw new Error(`dsh plugin add (bundle) exited ${addBundle.exitCode}`)
    // Effective DSH_HOME of the profile commands, from dsh's own log line.
    const initLine = `initialized profile headless at ${join(DSH_HOME, 'profiles', 'headless')}`
    if (!addBundle.stderrText.toLowerCase().includes(initLine.toLowerCase())) throw new Error(`dsh plugin add did not report initializing the profile under the test DSH_HOME (expected "${initLine}")`)
    summary.setup.isolation = { dshHome: DSH_HOME, profileInitLine: initLine }
    const addReplay = run('setup-03-plugin-add-replay', ['plugin', '--profile', 'headless', 'add', '--offline', storeDir, replayDir], { cwd: RUN, env: pnpmEnv, timeout: 300_000 })
    if (addReplay.exitCode !== 0) throw new Error(`dsh plugin add (replay) exited ${addReplay.exitCode}`)
    profileDir = join(DSH_HOME, 'profiles', 'headless')
    const profileManifest = readJson(join(profileDir, 'package.json'))
    summary.setup.profileManifest = profileManifest
    evidence('profile/package.json', JSON.stringify(profileManifest, null, 2) + '\n')
    if (!(profileManifest.dsh?.profile?.bundles ?? []).includes('gentle-ai-dsh')) throw new Error('gentle-ai-dsh is not a profile bundle layer after dsh plugin add')

    // 3. Node resolution of the role plugin specifier from the profile, as the loader resolves bare names.
    const profileRequire = createRequire(join(profileDir, 'package.json'))
    const resolved = profileRequire.resolve('gentle-ai-dsh/role-restrict')
    const real = realpathSync(resolved)
    summary.setup.resolution = {
      specifier: 'gentle-ai-dsh/role-restrict',
      resolved,
      realpath: real,
      insideStagedBundle: samePath(real, join(STAGED, 'lib', 'role-restrict.js')),
      sha256: sha256File(real),
      repoSha256: sha256File(join(REPO, 'lib', 'role-restrict.js')),
    }
    if (!summary.setup.resolution.insideStagedBundle) throw new Error(`gentle-ai-dsh/role-restrict resolves outside the installed copy: ${real}`)

    // 4. Composed configuration with the overlay.
    const wsRoster = join(RUN, 'ws-roster')
    mkdirSync(wsRoster, { recursive: true })
    const rosterScriptFile = join(RUN, 'fixtures', 'setup-roster.replay.json')
    writeFileSync(rosterScriptFile, JSON.stringify([textEntry('c2-roster-probe')], null, 1) + '\n')
    const dump = run('setup-04-dump-config', ['--profile', 'headless', '--patch', OVERLAY, '--dump-config'], {
      cwd: wsRoster, env: dshEnv({ DSH_SNAPSHOT_FILE: rosterScriptFile, DSH_SNAPSHOT_OVERRIDE: rosterScriptFile }), timeout: 120_000,
    })
    evidence('dump-config.yml', dump.stdoutText)
    if (dump.exitCode !== 0) throw new Error(`--dump-config exited ${dump.exitCode}`)
    // The `# == gentle-ai-dsh` layer comes only from the bundle list in the profile manifest under the test DSH_HOME.
    for (const needle of ['# == gentle-ai-dsh', 'gentle-ai-preset-explore', 'gentle-ai-preset-verify', 'gentle-ai-preset-worker', 'gentle-ai-dsh/role-restrict', 'allowedAgentPresets', 'agent-preset-registry', 'llm-replay']) {
      if (!dump.stdoutText.includes(needle)) throw new Error(`--dump-config lacks ${needle}`)
    }

    // 5. Parent roster: one replayed text turn, read from the persisted request header.
    const rosterRun = headless('setup-05-roster', wsRoster, [textEntry('c2-roster-probe')], { mode: 'read-only', prompt: 'C2 roster probe' })
    if (rosterRun.exitCode !== 0) throw new Error(`roster run exited ${rosterRun.exitCode}`)
    const rosterSessions = sessionsFor(wsRoster)
    if (rosterSessions.length !== 1) throw new Error(`roster run: expected 1 session, found ${rosterSessions.length}`)
    const headers = rosterSessions[0].events.filter((e) => e.type === 'request/header' && headerToolNames(e))
    if (headers.length === 0) throw new Error('roster run: no request/header with tools')
    roster = headerToolNames(headers.at(-1))
    const subagentTool = (headers.at(-1).data.header?.tools ?? headers.at(-1).data.tools).find((x) => x.name === 'subagent')
    summary.setup.parentRoster = roster
    evidence('parent-roster.json', { toolNames: roster, subagentTool })
    for (const name of ['glob', 'grep', 'read', 'pwsh', 'write', 'edit', 'subagent']) {
      if (!roster.includes(name)) throw new Error(`parent roster lacks ${name}`)
    }
    if (roster.some((n) => n.startsWith('mcp__engram'))) throw new Error('Engram MCP tools are mounted despite the overlay')
    summary.setup.status = 'ok'
    progress('END setup ok')
  } catch (error) {
    summary.setup.status = 'failed'
    summary.setup.error = String(error?.stack ?? error)
    progress(`END setup FAILED: ${error?.message ?? error}`)
    writeEvidence()
    throw error
  }

  // ---------- Probes: one parent run per role ----------
  const children = {}
  try {
    for (const [role, allow] of Object.entries(ROLES)) {
      const preset = `gentle-ai-${role}`
      const hex = randomBytes(4).toString('hex')
      const seed = `C2SEED-${hex}`
      const done = `C2MARK-${role.toUpperCase()}-DONE-${hex}`
      const pwshMarker = `C2-VERIFY-PWSH-${hex}`
      const forbidden = roster.filter((n) => !allow.includes(n))
      const extraForbidden = roster.includes('apply_patch') ? [] : ['apply_patch']
      const argsFor = (name) => ({
        write: { file_path: `escape-${role}.txt`, content: 'must not be written\n' },
        edit: { file_path: 'probe/seed.txt', old_string: seed, new_string: `edited-by-${role}` },
        pwsh: { description: 'write via shell', command: `Set-Content -Path shell-${role}.txt -Value x` },
        apply_patch: { input: `*** Begin Patch\n*** Add File: patch-${role}.txt\n+x\n*** End Patch\n` },
        working_directory: { cd: 'probe' },
      })[name] ?? {}
      const calls = [
        ...[...forbidden, ...extraForbidden].map((name, i) => ({ id: `call_c2_${role}_f${i}_${name}`, name, args: argsFor(name), expect: 'unknown', inParentRoster: roster.includes(name) })),
        { id: `call_c2_${role}_read`, name: 'read', args: { file_path: 'probe/seed.txt' }, expect: 'ok', contains: seed },
        { id: `call_c2_${role}_glob`, name: 'glob', args: { pattern: '**/*.txt' }, expect: 'ok', contains: 'seed.txt' },
        { id: `call_c2_${role}_grep`, name: 'grep', args: { pattern: 'C2SEED-' }, expect: 'ok', contains: 'seed.txt' },
        ...(allow.includes('pwsh') ? [{ id: `call_c2_${role}_pwsh`, name: 'pwsh', args: { description: 'print marker', command: `Write-Output ${pwshMarker}` }, expect: 'ok', contains: pwshMarker }] : []),
      ]
      const childScript = [...calls.map((c) => toolEntry(c.id, c.name, c.args)), textEntry(`${done} ${role} child finished`)]
      const info = { preset, seed, done, calls, forbidden, extraForbidden }
      summary.roles[role] = info

      // Record the child script as a primary session (read-only) to get the child session log the replay plugin needs.
      const wsRec = join(RUN, `rec-${role}`)
      mkdirSync(join(wsRec, 'probe'), { recursive: true })
      writeFileSync(join(wsRec, 'probe', 'seed.txt'), `${seed}\n`)
      const rec = headless(`${role}-1-record-child`, wsRec, childScript, { mode: 'read-only', prompt: `C2 ${role} child recording` })
      const recSessions = sessionsFor(wsRec)
      info.recording = { exitCode: rec.exitCode, sessions: recSessions.length }
      if (recSessions.length !== 1) throw new Error(`${role} recording: expected 1 session, found ${recSessions.length}`)
      const recAssistant = recSessions[0].events.filter((e) => e.type === 'assistant/message').length
      info.recording.assistantMessages = recAssistant
      if (recAssistant !== childScript.length) throw new Error(`${role} recording: ${recAssistant} assistant messages for ${childScript.length} scripted calls`)
      const childFile = join(RUN, 'fixtures', `${role}.child.session.v4.jsonl`)
      writeFileSync(childFile, readSessionLines(recSessions[0].file).join('\n') + '\n')

      // Parent run: spawn the child under the role preset, then echo the completion notice.
      const ws = join(RUN, `ws-${role}`)
      mkdirSync(join(ws, 'probe'), { recursive: true })
      writeFileSync(join(ws, 'probe', 'seed.txt'), `${seed}\n`)
      const seedSha = sha256File(join(ws, 'probe', 'seed.txt'))
      const parentScript = [
        toolEntry(`call_c2_${role}_spawn`, 'subagent', { description: `c2 ${role} probe`, prompt: `C2 ${role} role probe.`, agent_preset: preset }),
        textEntry(`launched-${role}`),
        textEntry(`parent-notified={{fromRequest:(C2MARK-${role.toUpperCase()}-DONE-[0-9a-f]{8})}}`),
      ]
      const main = headless(`${role}-2-parent`, ws, parentScript, { childFile, mode: 'workspace-write', prompt: `C2 ${role} delegation probe` })
      const sessions = sessionsFor(ws)
      const parent = sessions.find((s) => !s.events[0].parentSession)
      const child = parent && sessions.find((s) => s.events[0].parentSession === parent.events[0].id)
      info.run = { exitCode: main.exitCode, sessions: sessions.length, seedSha, disk: listTree(ws) }
      children[role] = { parent, child, main, info, ws, seedSha }

      // Sanitized excerpts and raw decoded logs.
      const excerpt = (events) => events.flatMap((e) => {
        switch (e.type) {
          case 'session': return [{ type: e.type, id: e.id, cwd: e.cwd, agentPreset: e.agentPreset ?? null, origin: e.origin ?? null, parentSession: e.parentSession ?? null, delegationDepth: e.delegationDepth }]
          case 'request/header': return [{ type: e.type, seq: e.seq, toolNames: headerToolNames(e) ?? null }]
          case 'tool/call': return [{ type: e.type, seq: e.seq, time: e.time, callId: e.data?.callId, name: e.data?.name, arguments: e.data?.arguments }]
          case 'tool/result': return [{ type: e.type, seq: e.seq, time: e.time, callId: e.data?.message?.toolCallId, isError: e.data?.message?.isError ?? false, text: truncate(resultText(e), 600) }]
          case 'turn/start': case 'turn/end': case 'agent-preset/selected': case 'subagent/catalog': return [{ type: e.type, seq: e.seq, time: e.time, data: e.data }]
          case 'agent/inbox/spliced': {
            const texts = (e.data?.inserted ?? []).flatMap((m) => (m.content ?? []).filter((c) => c.type === 'text').map((c) => truncate(c.text, 800)))
            return texts.length ? [{ type: e.type, seq: e.seq, time: e.time, texts }] : []
          }
          case 'assistant/message': {
            const content = e.data?.message?.content ?? []
            return [{ type: e.type, seq: e.seq, time: e.time, text: content.filter((c) => c.type === 'text').map((c) => c.text).join(''), toolCalls: content.filter((c) => c.type === 'tool-call').map((c) => c.name) }]
          }
          default: return []
        }
      }).map((o) => JSON.stringify(o)).join('\n') + '\n'
      if (parent) {
        evidence(`${role}/parent.excerpt.jsonl`, excerpt(parent.events))
        evidence(`${role}/raw/parent.session.jsonl`, readSessionLines(parent.file).join('\n') + '\n')
      }
      if (child) {
        evidence(`${role}/child.excerpt.jsonl`, excerpt(child.events))
        evidence(`${role}/raw/child.session.jsonl`, readSessionLines(child.file).join('\n') + '\n')
      }
      evidence(`${role}/raw/recorded-child-fixture.session.jsonl`, readFileSync(childFile, 'utf8'))
      evidence(`${role}/disk.json`, { workspace: ws, seedSha256Before: seedSha, files: info.run.disk, recordingWorkspace: wsRec, recordingFiles: listTree(wsRec) })
    }
  } finally {
    writeEvidence()
  }

  // ---------- Checks ----------
  const check = async (name, fn) => {
    const entry = { name, status: 'fail' }
    summary.checks.push(entry)
    await t.test(name, async () => {
      try {
        await fn()
        entry.status = 'pass'
      } catch (error) {
        entry.error = String(error?.message ?? error)
        throw error
      }
    })
  }
  const timing = {}
  for (const role of Object.keys(ROLES)) {
    const { parent, child, main, info, ws, seedSha } = children[role]
    const pEvents = parent?.events ?? []
    const cEvents = child?.events ?? []
    const spawnResult = pEvents.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === `call_c2_${role}_spawn`)
    const childId = cEvents[0]?.id

    await check(`${role}: headless parent run exits 0 with one parent and one child session`, () => {
      assert.equal(main.exitCode, 0)
      assert.ok(parent, 'parent session persisted')
      assert.ok(child, 'child session persisted')
      assert.equal(info.run.sessions, 2)
    })
    await check(`${role}: parent selects ${info.preset} and the spawn returns at once`, () => {
      const call = pEvents.find((e) => e.type === 'tool/call' && e.data?.callId === `call_c2_${role}_spawn`)
      assert.equal(call?.data?.name, 'subagent')
      assert.equal(JSON.parse(call.data.arguments).agent_preset, info.preset)
      assert.equal(resultText(spawnResult), `started subagent ${childId}`)
      assert.equal(spawnResult.data.message.isError ?? false, false)
    })
    await check(`${role}: child runs under ${info.preset}`, () => {
      assert.equal(cEvents[0].agentPreset, info.preset)
      assert.equal(cEvents[0].origin, 'subagent')
      assert.equal(cEvents[0].parentSession, pEvents[0].id)
      const selected = cEvents.filter((e) => e.type === 'agent-preset/selected').map((e) => e.data?.agentPreset)
      assert.deepEqual(selected, [info.preset])
    })
    await check(`${role}: exact child tool roster is ${ROLES[role].join(', ')}`, () => {
      const rosters = cEvents.filter((e) => e.type === 'request/header').map(headerToolNames).filter(Boolean)
      assert.ok(rosters.length > 0, 'child request header with tools')
      for (const names of rosters) assert.deepEqual(names, [...ROLES[role]].sort())
    })
    await check(`${role}: every tool outside the allowlist answers unknown tool`, () => {
      const unknown = info.calls.filter((c) => c.expect === 'unknown')
      assert.ok(unknown.length >= info.forbidden.length && info.forbidden.length > 0)
      if (role === 'worker') for (const n of ['write', 'edit', 'pwsh', 'working_directory', 'subagent', 'apply_patch']) assert.ok(unknown.some((c) => c.name === n), `worker probes ${n}`)
      for (const c of unknown) {
        const r = cEvents.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === c.id)
        assert.ok(r, `result for ${c.name}`)
        assert.equal(r.data.message.isError, true, `${c.name} is an error`)
        assert.match(resultText(r), new RegExp(`unknown tool "${c.name}"`), `${c.name} is unknown`)
      }
    })
    await check(`${role}: allowed tools work`, () => {
      for (const c of info.calls.filter((x) => x.expect === 'ok')) {
        const r = cEvents.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === c.id)
        assert.ok(r, `result for ${c.name}`)
        assert.equal(r.data.message.isError ?? false, false, `${c.name} succeeded: ${truncate(resultText(r), 300)}`)
        assert.ok(resultText(r).includes(c.contains), `${c.name} result contains ${c.contains}`)
      }
    })
    await check(`${role}: parent receives the background completion notice`, () => {
      const turnEnds = pEvents.filter((e) => e.type === 'turn/end')
      const notice = pEvents.find((e) => e.type === 'agent/inbox/spliced' && JSON.stringify(e.data).includes(`Background subagent ${childId}`))
      assert.ok(notice, 'notice spliced into the parent inbox')
      assert.ok(JSON.stringify(notice.data).includes(info.done), 'notice carries the child final answer')
      assert.ok(turnEnds.length >= 2 && turnEnds[0].seq < notice.seq, 'notice arrives after parent turn 1 ended')
      assert.ok(!resultText(spawnResult).includes(info.done), 'spawn result does not wait for the child')
      assert.equal(assistantTexts(pEvents).at(-1), `parent-notified=${info.done}`)
      const childEnd = cEvents.filter((e) => e.type === 'turn/end').at(-1)
      timing[role] = { parentTurn1End: turnEnds[0].time, childLastTurnEnd: childEnd?.time, notice: notice.time, parentTurnEnds: turnEnds.map((e) => e.time) }
    })
    await check(`${role}: workspace unchanged on disk`, () => {
      const files = info.run.disk.filter((f) => f.type === 'file').map((f) => f.path)
      assert.deepEqual(files, ['probe/seed.txt'])
      assert.equal(sha256File(join(ws, 'probe', 'seed.txt')), seedSha)
      for (const n of [`escape-${role}.txt`, `shell-${role}.txt`, `patch-${role}.txt`, 'probe/escape-' + role + '.txt']) assert.equal(existsSync(join(ws, n)), false, n)
    })
  }
  await check('isolation: every dsh command used the test-owned DSH_HOME', () => {
    const dshCommands = commands.filter((c) => c.argv[1] === DSH_BIN)
    assert.equal(dshCommands.length, 10)
    for (const c of dshCommands) {
      assert.equal(c.env.DSH_HOME, DSH_HOME, `${c.label} DSH_HOME`)
      assert.equal(c.env.DSH_AGENTS_HOME, AGENTS_HOME, `${c.label} DSH_AGENTS_HOME`)
    }
    assert.ok(summary.setup.isolation?.profileInitLine, 'profile initialized under the test DSH_HOME')
    const headlessRuns = dshCommands.filter((c) => c.sessionFilesUnderDshHome)
    assert.equal(headlessRuns.length, 7)
    for (const c of headlessRuns) {
      const s = c.sessionFilesUnderDshHome
      assert.ok(s.after > s.before, `${c.label} persisted new sessions under the test DSH_HOME`)
      assert.ok(s.forWorkspace >= 1, `${c.label} sessions for its workspace are under the test DSH_HOME`)
    }
  })
  await check('roles are distinct child sessions with their own preset', () => {
    const presets = Object.values(children).map((c) => c.child?.events[0]?.agentPreset)
    assert.deepEqual(presets, ['gentle-ai-explore', 'gentle-ai-verify', 'gentle-ai-worker'])
    assert.equal(new Set(Object.values(children).map((c) => c.child?.events[0]?.id)).size, 3)
  })
  summary.timing = timing
  writeEvidence()
  progress(`END run checks=${summary.checks.length} failed=${summary.checks.filter((c) => c.status !== 'pass').length}`)
  console.error(`[c2-replay] evidence: ${sanitize(EVIDENCE)} (run ${basename(RUN)})`)
})
