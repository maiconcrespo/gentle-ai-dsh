# gentle-ai-dsh

A [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) persona, skills and optional Engram memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It also ships the gentle-ai orchestrator with its ODD workflow.

## V2 status

The gentle-ai orchestrator and its ODD protocol ship as the `gentle-ai:orchestrator` system-prompt section (#9). Explore, worker and verify subagents for `dsh web` (#10) and their integration and docs (#11) are in progress under the tracking issue #3. Contributors: start with [the v2 plan and handoff](odd/tasks/v2.md).

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

## Content and tests

Content comes from a pinned gentle-ai ref. To update it, bump `gentleAi.ref` in `package.json`, then run:

```sh
npm run sync
npm test
```

GitHub Actions runs `npm test` on Linux and Windows for every pull request and every push to `main` (`.github/workflows/test.yml`).

See [content sync](docs/content-sync.md) for details and [spike findings](docs/spike-findings.md) for historical verification. The sync uses Git and network access.

## License

MIT. Content copied from gentle-ai keeps its upstream license; see [NOTICE](NOTICE).
