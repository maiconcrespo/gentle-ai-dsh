# C2 role presets: evidence

Feature document: `odd/tasks/c2-role-presets.md` (T2, S1-S4). Recorded 2026-11-11 by the T2 writer.
No dsh runtime was started for T2. Everything below is either an observed Node test result or a reading of the `@deepseek-ai/dsh@0.2.2-rc.1` package sources (built `lib/` files, line numbers from that version).

## Observed: Node tests

| Command | Result |
| --- | --- |
| `node --test test/role-presets.test.js` before `lib/role-restrict.js` existed (parent) | exit 1, `ERR_MODULE_NOT_FOUND` |
| `node --test test/role-presets.test.js test/routing.test.js test/bundle.test.js` after the new tests, before implementation | role-presets: module not found; bundle: `/id: tool-subagent(?:\s|$)/` did not match; routing: role guidance missing |
| Same command after implementation, Windows checkout (`core.autocrlf=true`) | 18 pass, 1 fail: `shipped prompt composes orchestrator, routing and dsh adaptation in order` (CRLF working copy, fails before this change too) |
| Same command on an LF-normalized copy of the working tree | 19 pass, 0 fail |
| `node --test test/` on the LF-normalized copy | 23 pass, 1 fail: `finds only executable files on PATH` (Windows, fails before this change too) |

`npm test` runs `test/index.js`, which did not import `test/role-presets.test.js` at first; the correction below registers it.

## Correction batch (T2, one round)

Changes: `test/index.js` imports `./role-presets.test.js`. `test/routing.test.js` and `test/orchestrator.test.js` normalize `orchestrator.md` to LF before structural checks (heading offsets, tail match, byte budget, leak scan). `orchestrator.test.js` still compares the registered section text with the raw file. No production file changed.

Baseline: unchanged HEAD `f671c11` extracted with `git archive HEAD | tar -x` into a session temp directory. `git archive` applied `core.autocrlf=true`, so `orchestrator.md` and the tests had CRLF line endings, as in the checkout.

| Run | Exit | Totals | Failing tests |
| --- | --- | --- | --- |
| Baseline HEAD, CRLF, `node --test test/` | 1 | 23 tests, 20 pass, 3 fail | `finds only executable files on PATH`; `shipped orchestrator.md is rendered, review-free and registered as a section`; `shipped prompt composes orchestrator, routing and dsh adaptation in order` |
| Baseline HEAD, LF-normalized copy, `node --test test/` | 1 | 23 tests, 22 pass, 1 fail | `finds only executable files on PATH` |
| Candidate checkout, `node --test test/role-presets.test.js test/routing.test.js test/bundle.test.js` | 0 | 19 tests, 19 pass, 0 fail | none |
| Candidate checkout, `npm test` | 1 | 36 tests, 35 pass, 1 fail | `finds only executable files on PATH` |
| Candidate, LF-normalized copy, `npm test` | 1 | 36 tests, 35 pass, 1 fail | `finds only executable files on PATH` |
| Candidate LF copy with the `## dsh runtime adaptation` heading renamed (scratch mutation) | 1 | 9 tests, 7 pass, 2 fail | both repaired tests fail again, with `dsh runtime adaptation missing` |

The engram failure is unchanged from the baseline and is caused by the platform: `test/engram.test.js:9` expects `findOnPath` to return `null` after `chmod 0o644`. On Windows, Node reports mode `666` after that chmod and `accessSync(file, X_OK)` succeeds, so the test gets the temp file path instead of `null`. Neither the test nor `lib/engram.js` was changed.

## Scratch deletion disclosure

The correction worker disclosed deleting one temporary file it created for the Windows chmod/X_OK probe. This was the worker's own action and violated the no-scratch-deletion rule; the file cannot be recovered. Other scratch was reported retained.

Separately, the pre-existing upstream `test/engram.test.js` registers `t.after` cleanup via `rmSync` for temporary directories created by the tests themselves. Previous suite runs executed those pre-existing hooks; they were not a separately authored deletion action by the worker. Lia confirmed no evidence was lost in those test-created temporary directories and directed that the hooks remain unchanged for C2. Treat their scratch hygiene as a possible later PR or upstream issue, subject to coordination; preserve scratch in subsequent runs.

## Engram PATH test on Windows (bounded continuation, L7)

This failure was already reproducible on unchanged HEAD `f671c11` before any C2 change (see "Correction batch" above): 23 tests, 22 pass on the LF-normalized baseline, failing only `finds only executable files on PATH`. It comes from the environment, not from C2.

Change: one assertion in `test/engram.test.js`. After `chmod 0o644`, the expected value is `null` on every platform except `win32`, where it is the file path. Windows has no execute permission bit: chmod only toggles read-only, and `X_OK` checks existence. Unix coverage is unchanged (missing file, then `0o644`, then `0o755` gives the path). On Windows the test still checks that a missing file gives `null` and that an existing file gives its path. The `t.after` `rmSync` hooks in `test/engram.test.js` and `test/guard.test.js` were not modified. `C2_KEEP_TEST_SCRATCH=1` is read by no repository code.

Scratch preservation without changing the hooks: a preload module in the session temp directory, loaded with `NODE_OPTIONS=--import=<file URL>`, replaced `fs.rmSync`, `rmdirSync`, `unlinkSync`, `rm`, `rmdir`, `unlink` and `fs.promises.rm`/`rmdir`/`unlink` with logged no-ops. It then called `module.syncBuiltinESMExports()` so that `import { rmSync } from 'node:fs'` picks up the no-op. Before any repository test ran, two probes confirmed it: calling `rmSync` on a missing path with `force: false` did not throw, and a `node --test` child test calling `rmSync` in its body and in `t.after` passed, with both calls logged under the child's pid. npm ran with `npm_config_logs_dir` set to the session temp directory and `npm_config_update_notifier=false`.

| Command (preload, `C2_KEEP_TEST_SCRATCH=1`) | Exit | Totals | Deletions stubbed |
| --- | --- | --- | --- |
| `node --test test/engram.test.js` before the edit (RED) | 1 | 3 tests, 2 pass, 1 fail: `finds only executable files on PATH`, actual temp file path, expected `null` | 2 `rmSync` |
| `node --test test/engram.test.js` after the edit | 0 | 3 tests, 3 pass, 0 fail | 2 `rmSync` |
| `npm test` after the edit | 0 | 36 tests, 36 pass, 0 fail | 5 `rmSync` |

All 9 `engram-test-*` and `guard-test-*` directories from these runs remained in the session temp directory. npm's debug log was written there as well. Not verified here: the Unix branch (no Unix host available), and whether `~/.npm/_logs` was untouched (a listing printed nothing before or after the run, so it is either absent or unreadable).

Separate observation, not changed: `findOnPath('engram')` looks for a file named exactly `engram`, so on Windows an `engram.exe` on PATH would not be found by name. This is production behavior outside C2.

## Read from the 0.2.2-rc.1 sources (not run)

- `dsh-tools/lib/index.js:453-467`: `tools.restrict()` needs an agent scope, rejects an empty filter and throws for any name that is not a registered global tool. `:477-506`: restrictions intersect over inherited tools; the scope's own registrations stay visible. Hence: a role preset must not mount tool plugins, and an allowlisted tool the host lacks fails the preset.
- `dsh-tool-subagent/lib/index.js:243-283`: `agentPreset` is the default when the model omits `agent_preset`; `allowedAgentPresets` must contain it, and any other value is rejected. `:348`: with either field set, the tool refuses to mount without the agent-presets service.
- `dsh-subagent/lib/index.js:349, 374-382`: an explicit preset is mounted for the child; an omitted one joins the parent's composition. Fork children therefore keep the parent's tools.
- `dsh-official-bundles/lib/index.js:5-7`: acp, web and headless are `dsh-base` plus one app bundle. Only `dsh-web-app/cordis.patch.yml:589-593` inserts `agent-preset-registry` (default `standard`). `dsh-base/cordis.patch.yml:381-385` declares `tool-subagent` (spawn).
- `dsh-web-app/cordis.patch.yml:487-510, 565-566`: web disables the host shell, fs and `tool-subagent` rows; delegation and fs tools live inside its presets.
- `cordis-plugin-include/lib/index.js:218-262`: an `insert` appends rows; a keyed patch with a different `name` is skipped; a keyed `config` replaces the whole block. `cordis-plugin-loader/lib/index.js:82-96`: the loader keeps one entry per id, the last row wins. `cordis/lib/index.js:1400`: a second provider of the same service in one realm throws.
- `dsh-agent-preset-registry/lib/index.js:471-472, 612-618, 717-735`: the registry default is read only when no preset id is given; preset-free parents keep preset-free children.
- `dsh-headless/lib/index.js:213-228`: headless refuses to drive a session that runs under a preset.

## Prior runtime evidence (other project, replayed with rc.1)

From the gentle_ai_dsh evidence log and its `tests/p0` README: P0.4 variant B (a preset whose only plugin calls `ctx.tools.restrict({ allow: [read, glob, grep] })`) started the child in the background, notified the parent when it finished, and the child got `unknown tool "write"` and `unknown tool "pwsh"`, with no file written (D-7). Headless and ACP top-level sessions run with `agentPreset: null` (D-10, D-16). That replay used a probe plugin, not this bundle.

## Pending (T3)

- Isolated rc.1 replay of this bundle (`DSH_HOME` in scratch, no credentials, never `~/.dsh`): each role child starts, the parent is notified, a tool outside the allowlist returns `unknown tool`, and the worker cannot write.
- dsh resolving `gentle-ai-dsh/role-restrict` from an installed profile.
- The registry row on the web profile (single registry, `standard` default kept).
- Verify on a non-Windows host (expected to fail closed: no `pwsh`).
- Per-role model selection unverified; agentOptions per tool instance is the only confirmed mechanism.
