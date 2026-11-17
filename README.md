# gentle-ai-dsh

A [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) persona, skills and optional Engram memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It also ships the gentle-ai orchestrator with its ODD workflow.

## V2 status

The gentle-ai orchestrator and its ODD protocol ship as the `gentle-ai:orchestrator` system-prompt section (#9). Subagents (#10) ship for headless/ACP first and are in review (PR #15); web and desktop follow in #17. Integration and docs (#11) close the tracking issue #3. Contributors: start with [the v2 plan and handoff](odd/tasks/v2.md).

For what the plugin does and what it reuses from gentle-ai, see the [overview](docs/overview.md).

## Install and remove

Requires Node.js 24.9 or newer and dsh. Add the checkout to each profile you use:

```sh
dsh plugin --profile web add /path/to/gentle-ai-dsh
dsh plugin --profile headless add /path/to/gentle-ai-dsh
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

The dump should include the `gentle-ai-dsh` layer. From a dsh source checkout, use `pnpm dsh` in place of `dsh`, for example `pnpm dsh plugin --profile web add /path/to/gentle-ai-dsh`.

Remove it separately from each profile:

```sh
dsh plugin --profile web remove gentle-ai-dsh
dsh plugin --profile headless remove gentle-ai-dsh
```

## Engram memory

Persistent memory requires the `engram` executable on `PATH`. Install it with `brew install gentleman-programming/tap/engram` (see [Engram](https://github.com/Gentleman-Programming/engram)) and restart dsh. Without Engram, dsh still boots with the persona and skills, but memory is unavailable: the plugin adds a system-prompt note so the agent can tell you how to install it, and logs a warning through dsh. The plugin does not download binaries.

dsh runs one Engram process for all sessions, started from the directory dsh was launched in, so Engram's default project is that launch directory. To keep memories in the session's own project, the plugin instructs the agent to start an Engram session with `mem_session_start` (passing the session's working directory as `directory`) and pass the returned project as `project` on every Engram call. Engram only accepts an explicit `project` backed by known context, and starting a session provides it, even for a workspace Engram has never seen. This is a prompt instruction, not enforcement: dsh 0.2.x cannot rewrite tool arguments or scope an MCP server per session.

As a hard backstop, the plugin also denies Engram writes (`mem_save`, `mem_update`, `mem_session_summary`, `mem_save_prompt`) that do not pass the project returned by `mem_session_start` for the session's current working directory. The denial message tells the agent the exact call to make and the project to pass, so it can retry correctly. Reads are never blocked.

## Subagent roles

The bundle adds three agent presets and makes the `subagent` tool (in-process spawn) start every child under one of them. The model picks a role through the tool's `agent_preset` parameter; omitting it selects `gentle-ai-explore`.

| `agent_preset` | Tools the child keeps |
| --- | --- |
| `gentle-ai-explore` (default) | `glob`, `grep`, `read` |
| `gentle-ai-verify` | `glob`, `grep`, `read` and the platform shell: `pwsh` on Windows, `bash` on Linux and macOS |
| `gentle-ai-worker` | `glob`, `grep`, `read` |

The roles come from one shared table, [lib/roles.js](lib/roles.js), exported as `gentle-ai-dsh/roles`. Each entry holds the role name, its preset id, title and description, a role prompt and the allowed tools; `roleTools(role, platform)` resolves the exact allowlist for a host platform. [lib/role-presets.js](lib/role-presets.js), exported as `gentle-ai-dsh/role-presets` and called from `index.js`, registers the presets at start from that table, once the tools and agent-presets services are active. It offers a role only when the host serves `glob`, `grep` and `read` as global tools, and skips the rest with one log line, so a preset that could not mount is never listed. The platform shell is not part of that check: it is a property of the platform, and a host without the verify shell fails that one preset closed at mount instead of hiding every role. The headless and acp adapter reads the table through `gentle-ai-dsh/role-restrict`, and future web or desktop adapters (#17) can read the same table instead of restating the policy. No preset row is declared in `cordis.patch.yml`: a composition patch can only insert rows or override one by id, so it cannot condition a row on the profile, and a row can only name a package root. The adapter does not inject the role prompt into the child; it is there for adapters that compose a child prompt.

How it is enforced: plugins listed in a dsh preset are added to the tools a child inherits from the host; they never remove any. The only enforcement is `ctx.tools.restrict({ allow })` called from inside the preset, so each role preset mounts exactly one plugin, `gentle-ai-dsh/role-restrict` ([lib/role-restrict.js](lib/role-restrict.js)), and no tool plugins of its own (a preset's own tools are exempt from its restriction). Every other inherited tool, including `write`, `edit`, `skill`, the Engram tools and the delegation tools, is unknown to the child. A missing or unknown role, a verify role on a platform other than Windows, Linux or macOS, or an allowed tool the host does not register, fails the preset, so dsh does not start the child rather than starting it unrestricted. The registration step applies the same rule earlier: a role whose allowlist this host does not serve globally is never offered, so no child ever starts under a preset that would fail to mount.

The worker is fail-closed: it is read-only like explore, with edit surfaces pending the guard (#16). It gets no `edit`, `write`, `apply_patch`, shell or `working_directory` until an edit-surface guard exists that resolves paths against the calling agent's directory; a fixed-directory guard can be bypassed, and shell and `apply_patch` writes are not covered by a path guard at all.

Limits and status:

- Only children started by `subagent` are restricted. The parent session keeps every host tool: headless and acp do not apply presets to the top-level session (`agentPreset` is null), and nothing in this bundle guards the parent's edits. `subagent_fork` children inherit the parent's tools and are not restricted.
- `gentle-ai-verify` keeps the platform shell for checks, `pwsh` on Windows and `bash` on Linux and macOS. By design, the role does not limit the shell by path or command, so the parent names the exact commands.
- Per-role model selection unverified; agentOptions per tool instance is the only confirmed mechanism. Role children use the parent's model route.
- `dsh web`: the web profile disables the host `tool-subagent` row and takes delegation tools from its own presets, which this bundle does not change, so the roles are not offered there. The web host registers no global `glob`, `grep` or `read`, so the registration skips all three role presets there and logs one line: they do not appear in web's roster at all, which removes the failed-mount list the earlier declarative rows produced. Offering the roles in web and desktop is #17 work.
- To offer presets, headless and acp need the agent-presets registry, which only web ships. The bundle inserts it under web's id and with web's default, `standard`; the loader keeps the last row per id, so web keeps a single registry. This is read from the 0.2.2-rc.1 source, not run. `standard` exists only in web, and headless and acp never compose a preset for the top-level session, so nothing resolves that default there; a caller that asks the registry for a default preset in those profiles gets not-found. Pass an explicit `agent_preset` instead: the `subagent` tool's own default, `gentle-ai-explore`, applies when the model omits the parameter.
- Runtime status: the replay of this bundle against `@deepseek-ai/dsh@0.2.2-rc.1`, with the package installed into an isolated headless profile, passes 26 of 26 checks on Windows with the presets registered from code, the shared role table and the platform shell. The `bash` shell for Linux and macOS has not been replayed, and no Linux or macOS host has run the replay. See [the replay evidence summary](test/evidence/c2-replay.md).

## Content and tests

Content comes from a pinned gentle-ai ref. To update it, bump `gentleAi.ref` in `package.json`, then run:

```sh
npm run sync
npm test
```

GitHub Actions runs `npm test` on Linux and Windows for every pull request and every push to `main` (`.github/workflows/test.yml`).

`npm test` runs `node --test test/`, which with Node 24 resolves to `test/index.js` only, so every test file runs exactly once. On Windows that is 90 tests, 89 passing and 1 skipped with the pinned dsh install available; without one the replay reports its skip reason and the paths it checked, and the suite is 64 tests, 62 passing and 2 skipped. Those two skips are the C2 replay and a POSIX permission-bit check that does not apply on Windows; CI runs on Linux and Windows without a pinned install. Bare `node --test` discovers each file separately as well, so it reports a much larger, doubled count; use `npm test`.

A composition guard ([test/dsh-composition.test.js](test/dsh-composition.test.js)) records the rows this bundle inserts and overrides, in the order the loader applies them, in [test/fixtures/bundle-rows.json](test/fixtures/bundle-rows.json): a row that moves, loses its name, repeats an id or is both inserted and overridden fails there, and a patch shape the guard cannot read fails instead of being skipped. It also keeps the tested dsh release in one place, [test/dsh-pin.mjs](test/dsh-pin.mjs), in agreement with the `engines.dsh` floor, this file, the replay evidence and `docs/spike-findings.md`, and the replay imports that constant instead of holding its own literal. It needs no dsh install, so it runs on every CI leg. It guards composition, not dsh compatibility: only the replay boots dsh.

See [content sync](docs/content-sync.md) for details and [spike findings](docs/spike-findings.md) for historical verification. The sync uses Git and network access.

## License

MIT. Content copied from gentle-ai keeps its upstream license; see [NOTICE](NOTICE).
