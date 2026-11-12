> **VERIFYING ISOLATION:** Never access `~/.dsh`, including metadata or directory listings. Verify isolation exclusively from the effective `DSH_HOME` in the run logs and the composed configuration. If you think access is needed, do not access it; use those logs instead.

# C2 role presets: replay evidence summary

**Historical result.** This replay ran on Windows against the revision before the shared role table (`lib/roles.js`), when the verify allowlist was `pwsh` on every host. The current revision takes the allowlists from that table and gives verify `bash` on Linux and macOS. It has not been replayed since, and no Linux or macOS host has run the replay; the unit tests in `test/role-presets.test.js` cover the table and the per-platform allowlists without dsh.

The corrected C2 replay passed 27/27 on Windows with the headless profile, and an independent security verification passed. Each role child ran with only its allowlisted tools, and the parent received each child's completion notice. The worker role stays read-only until #16. The verify shell is unrestricted by design. The platforms and models listed under "Not tested" were not covered.

Runner: `test/c2-replay.test.js`, helpers in `test/c2-replay/lib.mjs`, overlay in `test/c2-replay/replay.patch.yml`. The test writes its evidence (command manifest, composed config, session excerpts and disk listings) under its own temporary run directory. That evidence is kept locally and is not part of the repository.

## Result

| Item | Observed |
| --- | --- |
| Command | `node --test test/c2-replay.test.js`, run once on 2026-11-11 against the corrected test |
| Host and profile | Windows (win32), dsh headless profile, keyless replay provider |
| Pins | `@deepseek-ai/dsh` and `@deepseek-ai/dsh-llm-replay` `0.2.2-rc.1` from an existing isolated install; the test fails on any other version |
| Exit and totals | Exit 0; 27 tests passed (1 parent test and 26 checks), 0 failed, 0 skipped |
| Independent verification | Passed. The verifier inspected the corrected evidence without rerunning the replay or accessing the real DSH home. |

The test installs the package the way a user does: `npm pack` of the working tree, then `dsh plugin --profile headless add --offline` for the packed bundle and the local replay package. Nothing is installed from the network.

## Child restrictions and notifications

For each role, a parent session calls `subagent` with an explicit `agent_preset` in a fresh workspace that contains only `probe/seed.txt`. The child calls every parent tool outside its allowlist, then `apply_patch`, then its allowed tools, and ends with a marker text. Write-capable probes use real arguments, such as writing `escape-<role>.txt` or editing the seed file.

| Role | Preset | Exact child tool roster |
| --- | --- | --- |
| explore | `gentle-ai-explore` | `glob grep read` |
| verify | `gentle-ai-verify` | `glob grep pwsh read` |
| worker (fail-closed) | `gentle-ai-worker` | `glob grep read` |

Eight checks passed for each role:

1. The headless parent run exits 0 and persists one parent and one child session.
2. The parent selects the role preset, and the spawn returns `started subagent <id>` at once, without waiting for the child.
3. The child session runs under that preset, with `origin: subagent`.
4. Every child request offers exactly the role allowlist.
5. Every tool outside the allowlist answers `unknown tool` as an error. For the worker, this includes `write`, `edit`, `pwsh`, `working_directory`, `subagent` and `apply_patch`.
6. The allowed tools work: `read`, `glob` and `grep` find the seed, and the verify role's `pwsh` prints a marker.
7. After its first turn ends, the parent receives the background completion notice carrying the child's final answer, and the parent's final text repeats it.
8. The workspace is unchanged on disk: only `probe/seed.txt` remains, with the same sha256, and no escape, shell or patch file exists.

Two more checks passed: the three roles ran as distinct child sessions with their own presets, and every dsh command used the test-owned `DSH_HOME` (see "Isolation").

## Isolation

- Every run uses a fresh directory under `os.tmpdir()` for `DSH_HOME`, `DSH_AGENTS_HOME` (empty), the pnpm store, the npm cache and logs, the workspaces and the evidence. npm and pnpm use an empty user config there.
- The test refuses a `DSH_HOME` with a `.dsh` path segment and a run root outside `os.tmpdir()`. This check inspects the path string only, not the disk.
- Telemetry is disabled (`DSH_TELEMETRY_MODE=DISABLED`, `DO_NOT_TRACK=1`, OTEL `DISABLED`). No model key is used, because the replay provider is keyless.
- Child environments drop variables whose names look like credentials, as well as inherited `DSH_*`, `NODE_OPTIONS` and test-runner variables. Only the names of removed variables are recorded, never their values.
- The overlay disables the bundle's Engram MCP row, so no `mcp__engram__*` tool is mounted.
- The test writes only new files under its run directory and contains no delete calls or cleanup hooks.

The corrected test never accesses the real DSH home (`~/.dsh`), not even its metadata. It checks isolation only from test-owned state:

1. Setup fails unless `dsh plugin add` reports that it initialized the headless profile under the test `DSH_HOME`.
2. Setup fails unless the composed `--dump-config` contains the `# == gentle-ai-dsh` layer header, which can only come from the profile manifest under the test `DSH_HOME`.
3. The check `isolation: every dsh command used the test-owned DSH_HOME` asserts that all 10 dsh commands ran with the test `DSH_HOME` and `DSH_AGENTS_HOME`, and that each of the 7 headless runs added session logs for its own workspace under the test `DSH_HOME`.

## Historical incident: unauthorized metadata reads (disclosure)

An earlier, pre-correction version of the test passed 26/26 but broke the rule never to touch the real DSH home. Through `fs.statSync` (via `statOrNull`), it read the mtime and directory type of `~/.dsh`, `~/.dsh/profiles` and `~/.dsh/sessions` once before the probes and once after. It read no file contents and wrote nothing.

- The recorded values were discarded and must not be cited as evidence that the real DSH home was isolated or left unchanged.
- That run is not evidence for the corrected test. The corrected 27/27 replay and the independent verification above are the evidence.
- The correction removed the reads, the recorded fields and the `statOrNull` import from the test. `statOrNull` remains exported but unused in `test/c2-replay/lib.mjs`.

## Limitations

- **Worker is read-only, pending #16.** Its edit surfaces depend on the guard work tracked in #16, and nothing here tests a guard. The parent's `subagent` tool also exposes `cwd`, which is relevant to #16.
- **Verify shell is unrestricted by design.** The verify role keeps `pwsh` with no path restriction, and the role does not limit what the shell does. The probe only ran `Write-Output`, so this replay says nothing about the verify role writing through the shell.
- **Per-role model selection is unverified.** Per-tool-instance `agentOptions` is the only confirmed mechanism. The `subagent` tool in this configuration exposes no provider or model parameter, and the test does not route models.
- **The default role was not exercised.** Every spawn passed an explicit `agent_preset`. Only the tool schema and the composed config show that the default is `gentle-ai-explore`.
- **Replay fixtures, not live behavior.** Each child script was recorded beforehand as a read-only primary session of the same profile. Those recording runs used the full tool roster, their results are not used, and their workspaces stayed unchanged.

### Not tested

- Hosts other than Windows, including Linux and macOS. The verify role's `bash` shell there comes from the shared role table and is not replayed. The replay test now probes the host shell from that table, but its `bash` probe arguments are unverified against dsh.
- The shared role table itself: the replay above predates it.
- Profiles other than headless, including web and ACP.
- Real models: only the keyless replay provider ran.
- Concurrent children and `send_message`. The `subagent` description says that children report through `send_message`, which role children do not have; the completion notice still carried the child's final answer.
