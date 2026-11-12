# gentle-ai-dsh

A [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) persona, skills and optional Engram memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It also ships the gentle-ai orchestrator with its ODD workflow.

## V2 status

The gentle-ai orchestrator and its ODD protocol ship as the `gentle-ai:orchestrator` system-prompt section (#9). Explore, worker and verify [subagent roles](#subagent-roles) (#10) ship for the `subagent` tool of the headless and acp profiles; `dsh web`, a writable worker, and their integration and docs (#11) are in progress under the tracking issue #3. Contributors: start with [the v2 plan and handoff](odd/tasks/v2.md).

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

The roles come from one shared table, [lib/roles.js](lib/roles.js), exported as `gentle-ai-dsh/roles`. Each entry holds the role name, its preset id, title and description, a role prompt and the allowed tools; `roleTools(role, platform)` resolves the exact allowlist for a host platform. The headless and acp adapter reads it through `gentle-ai-dsh/role-restrict`, and future web or desktop adapters (#17) can read the same table instead of restating the policy. The preset rows in `cordis.patch.yml` only name a role, and tests check that their ids, titles and descriptions match the table. The headless and acp adapter does not inject the role prompt into the child; it is there for adapters that compose a child prompt.

How it is enforced: plugins listed in a dsh preset are added to the tools a child inherits from the host; they never remove any. The only enforcement is `ctx.tools.restrict({ allow })` called from inside the preset, so each role preset mounts exactly one plugin, `gentle-ai-dsh/role-restrict` ([lib/role-restrict.js](lib/role-restrict.js)), and no tool plugins of its own (a preset's own tools are exempt from its restriction). Every other inherited tool, including `write`, `edit`, `skill`, the Engram tools and the delegation tools, is unknown to the child. A missing or unknown role, a verify role on a platform other than Windows, Linux or macOS, or an allowed tool the host does not register, fails the preset, so dsh does not start the child rather than starting it unrestricted.

The worker is fail-closed: it is read-only like explore, with edit surfaces pending the guard (#16). It gets no `edit`, `write`, `apply_patch`, shell or `working_directory` until an edit-surface guard exists that resolves paths against the calling agent's directory; a fixed-directory guard can be bypassed, and shell and `apply_patch` writes are not covered by a path guard at all.

Limits and status:

- Only children started by `subagent` are restricted. The parent session keeps every host tool: headless and acp do not apply presets to the top-level session (`agentPreset` is null), and nothing in this bundle guards the parent's edits. `subagent_fork` children inherit the parent's tools and are not restricted.
- `gentle-ai-verify` keeps the platform shell for checks, `pwsh` on Windows and `bash` on Linux and macOS. By design, the role does not limit the shell by path or command, so the parent names the exact commands.
- Per-role model selection unverified; agentOptions per tool instance is the only confirmed mechanism. Role children use the parent's model route.
- `dsh web`: the web profile disables the host `tool-subagent` row and takes delegation tools from its own presets, which this bundle does not change, so the roles are not offered there. The role presets still appear in its preset list but, from the dsh 0.2.2-rc.1 source, cannot mount there because the web host registers no global `glob`, `grep` or `read`; this is inferred, not run.
- To offer presets, headless and acp need the agent-presets registry, which only web ships. The bundle inserts it under web's id and with web's default, `standard`; the loader keeps the last row per id, so web keeps a single registry. This is read from the 0.2.2-rc.1 source, not run.
- Runtime status: a replay of this bundle's own presets against `@deepseek-ai/dsh@0.2.2-rc.1`, with the package installed into an isolated headless profile, passed on Windows before the shared role table existed, when verify's shell was `pwsh` on every host. That Windows result is historical: the shared table and the `bash` shell for Linux and macOS have not been replayed, and no Linux or macOS host has run the replay. See [the replay evidence summary](test/evidence/c2-replay.md).

## Content and tests

Content comes from a pinned gentle-ai ref. To update it, bump `gentleAi.ref` in `package.json`, then run:

```sh
npm run sync
npm test
```

See [content sync](docs/content-sync.md) for details and [spike findings](docs/spike-findings.md) for historical verification. The sync uses Git and network access.

## License

MIT. Content copied from gentle-ai keeps its upstream license; see [NOTICE](NOTICE).
