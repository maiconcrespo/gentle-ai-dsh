// C2 integration evidence (issue #10).
//
// Boots the pinned @deepseek-ai/dsh@0.2.2-rc.1 headless runner with the keyless
// replay provider @deepseek-ai/dsh-llm-replay@0.2.2-rc.1 and this package
// installed into an isolated profile the way a user installs it:
// `npm pack` of the working tree, then `dsh plugin --profile headless add`.
// For each role (explore, verify, and the worker that edits behind the
// edit-surface guard of #16) a parent session spawns one child through the
// bundle's `subagent` tool with an explicit `agent_preset`, and the test
// checks: the spawn returns at once, the parent gets the background completion
// notice, the child's exact tool roster, every tool outside the allowlist is
// refused (`unknown tool` for explore and verify, the guard's denial for the
// worker), and the allowed tools work. Explore and verify must leave their
// workspace unchanged on disk. The worker creates one file with `write` and
// changes the seed with `edit` inside its workspace, and is denied a `write` to
// an absolute path outside it; its disk check expects exactly the created file
// and the edited seed, and the outside path must not exist.
//
// One more worker child is spawned with `subagent`'s `cwd` set to a directory
// outside the workspace. Its current directory moves there while the guard's
// allowed roots stay anchored to the project, so its relative `write` must be
// denied, the denial must name the moved cwd and the unmoved roots, and the
// outside directory must stay empty.
//
// The expected rosters come from the shared role table (lib/roles.js) for the
// host platform, so the verify role probes `pwsh` on Windows and `bash` on
// Linux and macOS. Only Windows has run this test; the bash probe arguments
// below follow the pwsh tool's shape and are unverified against dsh.
//
// Not covered: per-role model routing (unverified; agentOptions per tool
// instance is the only confirmed mechanism), real models, web/ACP profiles,
// Linux and macOS hosts.
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
// written to <run>/evidence for local inspection; raw logs are not committed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assistantTexts, extractTgz, findSessionFiles, headerToolNames, listTree, makeSanitizer,
  readSessionEvents, readSessionLines, resultText, sha256File, textEntry, toolEntry,
} from './c2-replay/lib.mjs'
import { ROLE_NAMES, roleTools, shellTool } from '../lib/roles.js'

const PIN = '0.2.2-rc.1'
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const OVERLAY = join(REPO, 'test', 'c2-replay', 'replay.patch.yml')
// Shell probes per shell tool: one that would write a file, one that prints a marker.
const SHELL_PROBES = {
  pwsh: { write: (file) => `Set-Content -Path ${file} -Value x`, print: (marker) => `Write-Output ${marker}` },
  bash: { write: (file) => `printf x > ${file}`, print: (marker) => `echo ${marker}` },
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
  // Resolved inside the test so an unsupported platform fails this test only.
  const SHELL = shellTool(process.platform)
  const ROLES = Object.fromEntries(ROLE_NAMES.map((role) => [role, roleTools(role, process.platform).sort()]))
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
    for (const file of ['lib/role-restrict.js', 'lib/roles.js']) {
      if (!fileHashes.some((f) => f.path === file)) throw new Error(`${file} is not in the packed bundle`)
    }

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
    for (const needle of ['# == gentle-ai-dsh', 'allowedAgentPresets', 'agent-preset-registry', 'llm-replay']) {
      if (!dump.stdoutText.includes(needle)) throw new Error(`--dump-config lacks ${needle}`)
    }
    // The role presets are registered at start by index.js from lib/roles.js,
    // so the static composition carries no preset row of its own; the probes
    // below prove the registered presets exist and restrict.
    if (dump.stdoutText.includes('@deepseek-ai/dsh-agent-preset\'')) throw new Error('--dump-config still declares a preset row')

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
    for (const name of ['glob', 'grep', 'read', SHELL, 'write', 'edit', 'subagent']) {
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
  let moved
  // Sanitized excerpt of a session log for the evidence directory.
  const excerpt = (events) => events.flatMap((e) => {
    switch (e.type) {
      case 'session': return [{ type: e.type, id: e.id, cwd: e.cwd, agentPreset: e.agentPreset ?? null, origin: e.origin ?? null, parentSession: e.parentSession ?? null, delegationDepth: e.delegationDepth }]
      case 'request/header': return [{ type: e.type, seq: e.seq, toolNames: headerToolNames(e) ?? null }]
      case 'tool/call': return [{ type: e.type, seq: e.seq, time: e.time, callId: e.data?.callId, name: e.data?.name, arguments: e.data?.arguments }]
      // 1200 characters fit a whole edit-guard denial, which names four absolute paths.
      case 'tool/result': return [{ type: e.type, seq: e.seq, time: e.time, callId: e.data?.message?.toolCallId, isError: e.data?.message?.isError ?? false, text: truncate(resultText(e), 1200) }]
      // The cwd change is what the moved-cwd worker case is about, so it is kept.
      case 'turn/start': case 'turn/end': case 'agent-preset/selected': case 'subagent/catalog': case 'working-directory/change': return [{ type: e.type, seq: e.seq, time: e.time, data: e.data }]
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
  try {
    for (const [role, allow] of Object.entries(ROLES)) {
      const preset = `gentle-ai-${role}`
      const hex = randomBytes(4).toString('hex')
      const seed = `C2SEED-${hex}`
      const done = `C2MARK-${role.toUpperCase()}-DONE-${hex}`
      const shellMarker = `C2-VERIFY-${SHELL.toUpperCase()}-${hex}`
      const forbidden = roster.filter((n) => !allow.includes(n))
      const extraForbidden = roster.includes('apply_patch') ? [] : ['apply_patch']
      // Guard probes, only for a role that is offered `write`: the inside file
      // proves ordinary file creation still works under the guard, and the
      // outside path is absolute and next to the workspace, so only the guard's
      // roots (not a relative-path accident) keep it from being written.
      const writes = allow.includes('write')
      const created = writes ? { path: `probe/created-${role}.txt`, content: `created-by-${role}-${hex}\n` } : null
      // The seed exists in every workspace, so editing it proves the guard lets
      // an ordinary in-place change through, not only a new file.
      const edited = allow.includes('edit') ? { path: 'probe/seed.txt', content: `edited-by-${role}-${hex}\n` } : null
      const outside = writes ? join(RUN, `outside-${role}-${hex}.txt`) : null
      const argsFor = (name) => ({
        write: { file_path: `escape-${role}.txt`, content: 'must not be written\n' },
        edit: { file_path: 'probe/seed.txt', old_string: seed, new_string: `edited-by-${role}` },
        [SHELL]: { description: 'write via shell', command: SHELL_PROBES[SHELL].write(`shell-${role}.txt`) },
        apply_patch: { input: `*** Begin Patch\n*** Add File: patch-${role}.txt\n+x\n*** End Patch\n` },
        working_directory: { cd: 'probe' },
      })[name] ?? {}
      const calls = [
        ...[...forbidden, ...extraForbidden].map((name, i) => ({ id: `call_c2_${role}_f${i}_${name}`, name, args: argsFor(name), expect: 'unknown', inParentRoster: roster.includes(name) })),
        { id: `call_c2_${role}_read`, name: 'read', args: { file_path: 'probe/seed.txt' }, expect: 'ok', contains: seed },
        { id: `call_c2_${role}_glob`, name: 'glob', args: { pattern: '**/*.txt' }, expect: 'ok', contains: 'seed.txt' },
        { id: `call_c2_${role}_grep`, name: 'grep', args: { pattern: 'C2SEED-' }, expect: 'ok', contains: 'seed.txt' },
        ...(allow.includes(SHELL) ? [{ id: `call_c2_${role}_${SHELL}`, name: SHELL, args: { description: 'print marker', command: SHELL_PROBES[SHELL].print(shellMarker) }, expect: 'ok', contains: shellMarker }] : []),
        // After read/glob/grep, so those still see only the seed.
        ...(writes ? [
          { id: `call_c2_${role}_write_inside`, name: 'write', args: { file_path: created.path, content: created.content }, expect: 'ok', contains: 'Created file' },
        ] : []),
        ...(edited ? [
          { id: `call_c2_${role}_edit_inside`, name: 'edit', args: { file_path: edited.path, old_string: seed, new_string: edited.content.trimEnd() }, expect: 'ok', contains: 'has been updated successfully' },
        ] : []),
        ...(writes ? [
          { id: `call_c2_${role}_write_outside`, name: 'write', args: { file_path: outside, content: 'must not be written\n' }, expect: 'denied', path: outside },
        ] : []),
      ]
      const childScript = [...calls.map((c) => toolEntry(c.id, c.name, c.args)), textEntry(`${done} ${role} child finished`)]
      const info = { preset, seed, done, calls, forbidden, extraForbidden, created, edited, outside: outside && { path: outside } }
      summary.roles[role] = info

      // Record the child script as a primary session (read-only) to get the child session log the replay plugin needs.
      const wsRec = join(RUN, `rec-${role}`)
      mkdirSync(join(wsRec, 'probe'), { recursive: true })
      writeFileSync(join(wsRec, 'probe', 'seed.txt'), `${seed}\n`)
      const rec = headless(`${role}-1-record-child`, wsRec, childScript, { mode: 'read-only', prompt: `C2 ${role} child recording` })
      const recSessions = sessionsFor(wsRec)
      info.recording = { exitCode: rec.exitCode, sessions: recSessions.length }
      // The recording replays the same outside write without the guard; if it
      // landed there, the absence check after the parent run would prove nothing.
      if (outside) info.outside.existsAfterRecording = existsSync(outside)
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
      info.run = { exitCode: main.exitCode, sessions: sessions.length, seedSha, seedAfter: readFileSync(join(ws, 'probe', 'seed.txt'), 'utf8'), disk: listTree(ws) }
      if (outside) {
        const denied = child?.events.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === `call_c2_${role}_write_outside`)
        info.outside.existsAfterParentRun = existsSync(outside)
        info.outside.result = denied ? { isError: denied.data.message.isError ?? false, text: resultText(denied) } : null
      }
      children[role] = { parent, child, main, info, ws, seedSha }

      // Sanitized excerpts and raw decoded logs.
      if (parent) {
        evidence(`${role}/parent.excerpt.jsonl`, excerpt(parent.events))
        evidence(`${role}/raw/parent.session.jsonl`, readSessionLines(parent.file).join('\n') + '\n')
      }
      if (child) {
        evidence(`${role}/child.excerpt.jsonl`, excerpt(child.events))
        evidence(`${role}/raw/child.session.jsonl`, readSessionLines(child.file).join('\n') + '\n')
      }
      evidence(`${role}/raw/recorded-child-fixture.session.jsonl`, readFileSync(childFile, 'utf8'))
      evidence(`${role}/disk.json`, {
        workspace: ws, seedSha256Before: seedSha, seedContentAfter: info.run.seedAfter, files: info.run.disk, recordingWorkspace: wsRec, recordingFiles: listTree(wsRec),
        ...(created ? { requestedFile: created, outsideWrite: info.outside } : {}),
        ...(edited ? { editedFile: edited } : {}),
      })
    }

    // A worker child whose cwd is moved out of the project at spawn (S5). dsh
    // keeps the child's session header on the parent's project and only moves
    // its working directory, so the guard's roots stay on the workspace while a
    // relative path now resolves next to it. Without the guard the write below
    // would land in `away`.
    if (ROLES.worker?.includes('write')) {
      const hex = randomBytes(4).toString('hex')
      const preset = 'gentle-ai-worker'
      const seed = `C2SEED-${hex}`
      const done = `C2MARK-WORKERCWD-DONE-${hex}`
      const away = join(RUN, `away-worker-${hex}`)
      mkdirSync(away)
      const relativePath = `moved-${hex}.txt`
      const writeId = 'call_c2_worker_cwd_write_relative'
      const childScript = [
        toolEntry(writeId, 'write', { file_path: relativePath, content: 'must not be written\n' }),
        textEntry(`${done} worker cwd child finished`),
      ]
      const wsRec = join(RUN, 'rec-worker-cwd')
      mkdirSync(wsRec, { recursive: true })
      const rec = headless('worker-cwd-1-record-child', wsRec, childScript, { mode: 'read-only', prompt: 'C2 worker cwd child recording' })
      const recSessions = sessionsFor(wsRec)
      if (recSessions.length !== 1) throw new Error(`worker cwd recording: expected 1 session, found ${recSessions.length}`)
      const childFile = join(RUN, 'fixtures', 'worker-cwd.child.session.v4.jsonl')
      writeFileSync(childFile, readSessionLines(recSessions[0].file).join('\n') + '\n')

      const ws = join(RUN, 'ws-worker-cwd')
      mkdirSync(join(ws, 'probe'), { recursive: true })
      writeFileSync(join(ws, 'probe', 'seed.txt'), `${seed}\n`)
      const seedSha = sha256File(join(ws, 'probe', 'seed.txt'))
      const spawnArgs = { description: 'c2 worker cwd probe', prompt: 'C2 worker cwd probe.', agent_preset: preset, cwd: away }
      const parentScript = [
        toolEntry('call_c2_worker_cwd_spawn', 'subagent', spawnArgs),
        textEntry('launched-worker-cwd'),
        textEntry('parent-notified={{fromRequest:(C2MARK-WORKERCWD-DONE-[0-9a-f]{8})}}'),
      ]
      const main = headless('worker-cwd-2-parent', ws, parentScript, { childFile, mode: 'workspace-write', prompt: 'C2 worker cwd delegation probe' })
      const sessions = sessionsFor(ws)
      const parent = sessions.find((s) => !s.events[0].parentSession)
      const child = parent && sessions.find((s) => s.events[0].parentSession === parent.events[0].id)
      const denied = child?.events.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === writeId)
      moved = {
        preset, done, away, relativePath, writeId, spawnArgs, ws, seedSha, main, parent, child,
        recording: { exitCode: rec.exitCode, sessions: recSessions.length },
        sessions: sessions.length,
        childCwdChanges: (child?.events ?? []).filter((e) => e.type === 'working-directory/change').map((e) => e.data?.cwd),
        result: denied ? { isError: denied.data.message.isError ?? false, text: resultText(denied) } : null,
        awayAfterRun: listTree(away),
        targetExistsAfterRun: existsSync(join(away, relativePath)),
        disk: listTree(ws),
      }
      summary.workerCwd = {
        spawnArguments: spawnArgs, childHeaderCwd: child?.events[0]?.cwd ?? null, childCwdChanges: moved.childCwdChanges,
        result: moved.result, awayAfterRun: moved.awayAfterRun, targetExistsAfterRun: moved.targetExistsAfterRun,
        recording: moved.recording, run: { exitCode: main.exitCode, sessions: sessions.length },
      }
      if (parent) evidence('worker-cwd/parent.excerpt.jsonl', excerpt(parent.events))
      if (child) evidence('worker-cwd/child.excerpt.jsonl', excerpt(child.events))
      evidence('worker-cwd/disk.json', {
        workspace: ws, seedSha256Before: seedSha, files: moved.disk, spawnArguments: spawnArgs,
        outsideDirectory: away, requestedRelativePath: relativePath, outsideFilesAfterRun: moved.awayAfterRun,
        targetExistsAfterRun: moved.targetExistsAfterRun, denial: moved.result,
      })
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
    // dsh runs tools.guard before dispatch, and dispatch is where a hidden tool
    // answers `unknown tool`. The edit guard mounted in an editing role denies
    // every tool name it does not know (S4), so there its denial arrives first.
    const guarded = ROLES[role].includes('write') || ROLES[role].includes('edit')
    await check(guarded ? `${role}: every tool outside the allowlist is refused by the edit guard` : `${role}: every tool outside the allowlist answers unknown tool`, () => {
      const unknown = info.calls.filter((c) => c.expect === 'unknown')
      assert.ok(unknown.length >= info.forbidden.length && info.forbidden.length > 0)
      // The worker is offered write and edit behind the guard (#16), so they are
      // no longer unknown to it; every tool that could bypass the guard still is.
      if (role === 'worker') for (const n of [SHELL, 'working_directory', 'subagent', 'apply_patch']) assert.ok(unknown.some((c) => c.name === n), `worker probes ${n}`)
      if (role === 'worker') for (const n of ['write', 'edit']) assert.ok(!unknown.some((c) => c.name === n), `worker does not expect ${n} to be unknown`)
      for (const c of unknown) {
        const r = cEvents.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === c.id)
        assert.ok(r, `result for ${c.name}`)
        assert.equal(r.data.message.isError, true, `${c.name} is an error`)
        if (guarded) assert.match(resultText(r), new RegExp(`^Error: gentle-ai edit-guard denied "${c.name}": this worker can only call `), `${c.name} is refused by the guard`)
        else assert.match(resultText(r), new RegExp(`unknown tool "${c.name}"`), `${c.name} is unknown`)
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
    if (info.created) {
      await check(`${role}: edit guard denies a write outside the workspace`, () => {
        const c = info.calls.find((x) => x.expect === 'denied')
        assert.ok(c, 'outside write probed')
        assert.ok(isAbsolute(c.path) && !samePath(dirname(c.path), ws), 'outside path is absolute and not in the workspace')
        const r = cEvents.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === c.id)
        assert.ok(r, 'result for the outside write')
        assert.equal(r.data.message.isError, true, 'outside write is an error')
        const text = resultText(r)
        assert.doesNotMatch(text, /unknown tool/, 'denied by the guard, not hidden by the preset')
        assert.match(text, /gentle-ai edit-guard denied "write": .*outside the allowed roots/, `guard denial: ${truncate(text, 300)}`)
        // The guard prints the requested path JSON-quoted (lib/edit-guard.js show()).
        assert.ok(text.includes(`Requested path: ${JSON.stringify(c.path)};`), 'denial names the requested path')
      })
    }
    if (info.edited) {
      await check(`${role}: edit guard allows an edit inside the workspace`, () => {
        const c = info.calls.find((x) => x.name === 'edit' && x.expect === 'ok')
        assert.ok(c, 'inside edit probed')
        const r = cEvents.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === c.id)
        assert.ok(r, 'result for the inside edit')
        const text = resultText(r)
        assert.equal(r.data.message.isError ?? false, false, `inside edit succeeded: ${truncate(text, 300)}`)
        assert.doesNotMatch(text, /edit-guard/, 'the guard did not deny it')
        assert.match(text, /^The file .*seed\.txt has been updated successfully\.$/)
        assert.equal(info.run.seedAfter, info.edited.content, 'the edit reached the seed on disk')
      })
    }
    // Explore and verify must leave the workspace untouched; a role that may
    // write must leave exactly the file it was asked to create and, when it
    // may edit, the seed with exactly the requested change.
    await check(info.created ? `${role}: workspace holds only the requested file and the edited seed` : `${role}: workspace unchanged on disk`, () => {
      const files = info.run.disk.filter((f) => f.type === 'file').map((f) => f.path)
      if (info.created) {
        assert.deepEqual(info.run.disk.map((f) => f.path), ['probe', info.created.path, 'probe/seed.txt'].sort((a, b) => a.localeCompare(b)), 'nothing else appeared')
        assert.equal(readFileSync(join(ws, info.created.path), 'utf8'), info.created.content)
        assert.equal(info.outside.existsAfterRecording, false, 'outside path absent after the recording run')
        assert.equal(info.outside.existsAfterParentRun, false, 'outside path absent after the parent run')
        assert.equal(existsSync(info.outside.path), false, 'outside path absent now')
      } else {
        assert.deepEqual(files, ['probe/seed.txt'])
      }
      if (info.edited) {
        assert.equal(readFileSync(join(ws, info.edited.path), 'utf8'), info.edited.content, 'seed holds the edited content')
        assert.notEqual(sha256File(join(ws, 'probe', 'seed.txt')), seedSha, 'seed changed on disk')
      } else {
        assert.equal(sha256File(join(ws, 'probe', 'seed.txt')), seedSha)
      }
      for (const n of [`escape-${role}.txt`, `shell-${role}.txt`, `patch-${role}.txt`, 'probe/escape-' + role + '.txt']) assert.equal(existsSync(join(ws, n)), false, n)
    })
  }
  if (ROLES.worker?.includes('write')) {
    const { away, relativePath, writeId, spawnArgs, ws, seedSha, main, parent, child, done } = moved
    const pEvents = parent?.events ?? []
    const cEvents = child?.events ?? []
    await check('worker cwd: the parent spawns a worker child with cwd outside the workspace', () => {
      assert.equal(main.exitCode, 0)
      assert.equal(moved.sessions, 2)
      assert.ok(parent && child, 'parent and child sessions persisted')
      assert.ok(isAbsolute(away) && !samePath(away, ws) && !resolve(away).toLowerCase().startsWith(resolve(ws).toLowerCase() + sep), 'away is outside the workspace')
      const call = pEvents.find((e) => e.type === 'tool/call' && e.data?.callId === 'call_c2_worker_cwd_spawn')
      assert.equal(call?.data?.name, 'subagent')
      assert.deepEqual(JSON.parse(call.data.arguments), spawnArgs, 'the spawn carried the outside cwd')
      const spawned = pEvents.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === 'call_c2_worker_cwd_spawn')
      assert.equal(resultText(spawned), `started subagent ${cEvents[0].id}`)
      assert.equal(cEvents[0].agentPreset, 'gentle-ai-worker')
      // The header is what anchors the roots; the cwd change is what moved.
      assert.ok(samePath(cEvents[0].cwd, ws), `child header stays on the workspace: ${cEvents[0].cwd}`)
      assert.ok(moved.childCwdChanges.length > 0 && moved.childCwdChanges.every((cwd) => samePath(cwd, away)), `child cwd moved to away: ${JSON.stringify(moved.childCwdChanges)}`)
      assert.equal(assistantTexts(pEvents).at(-1), `parent-notified=${done}`)
    })
    await check('worker cwd: a relative write after the cwd change is denied by the edit guard', () => {
      const r = cEvents.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === writeId)
      assert.ok(r, 'result for the relative write')
      assert.equal(r.data.message.isError, true, 'relative write is an error')
      const text = resultText(r)
      assert.doesNotMatch(text, /unknown tool/, 'denied by the guard, not hidden by the preset')
      assert.match(text, /gentle-ai edit-guard denied "write": the path resolves to .*outside the allowed roots/, `guard denial: ${truncate(text, 400)}`)
      assert.ok(text.includes(`Requested path: ${JSON.stringify(relativePath)};`), 'denial names the relative path')
      // The guard prints each path JSON-quoted (lib/edit-guard.js show()).
      const quoted = '("(?:[^"\\\\]|\\\\.)*")'
      const facts = text.match(new RegExp(`the path resolves to ${quoted}, .*; cwd: ${quoted}; allowed roots: ${quoted}\\.$`))
      assert.ok(facts, `denial has target, cwd and roots: ${truncate(text, 400)}`)
      const [target, cwd, root] = facts.slice(1).map((s) => JSON.parse(s))
      assert.ok(samePath(target, join(away, relativePath)), `the write would have landed in away: ${target}`)
      assert.ok(samePath(cwd, away), `denial names the moved cwd: ${cwd}`)
      assert.ok(samePath(root, ws), `the allowed root did not follow the cwd: ${root}`)
    })
    await check('worker cwd: the outside directory gained no file and the workspace is unchanged', () => {
      assert.deepEqual(moved.awayAfterRun, [], 'away was empty after the parent run')
      assert.equal(moved.targetExistsAfterRun, false, 'target absent after the parent run')
      assert.equal(existsSync(join(away, relativePath)), false, 'target absent now')
      assert.deepEqual(moved.disk.map((f) => f.path), ['probe', 'probe/seed.txt'])
      assert.equal(sha256File(join(ws, 'probe', 'seed.txt')), seedSha)
      assert.equal(existsSync(join(ws, relativePath)), false, 'nothing landed in the workspace either')
    })
  }
  await check('isolation: every dsh command used the test-owned DSH_HOME', () => {
    const dshCommands = commands.filter((c) => c.argv[1] === DSH_BIN)
    // Setup runs four, each role two, and the moved-cwd worker case two more.
    assert.equal(dshCommands.length, ROLES.worker?.includes('write') ? 12 : 10)
    for (const c of dshCommands) {
      assert.equal(c.env.DSH_HOME, DSH_HOME, `${c.label} DSH_HOME`)
      assert.equal(c.env.DSH_AGENTS_HOME, AGENTS_HOME, `${c.label} DSH_AGENTS_HOME`)
    }
    assert.ok(summary.setup.isolation?.profileInitLine, 'profile initialized under the test DSH_HOME')
    const headlessRuns = dshCommands.filter((c) => c.sessionFilesUnderDshHome)
    assert.equal(headlessRuns.length, ROLES.worker?.includes('write') ? 9 : 7)
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
