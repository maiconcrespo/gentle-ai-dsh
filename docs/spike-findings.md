# Spike findings: gentle-ai as a dsh plugin

**Verdict:** it works. A dsh plugin bundle can deliver the gentle-ai persona, gentle-ai skills, and Engram memory. Install and removal each take one command and never touch the user's own config files.

- Tested on: dsh `0.2.2-rc.1` (npm, Linux, Node 24.10.0, pnpm 11.28.5), Engram 3.7.0.
- Content source: gentle-ai `4309309fa90c2ad7eeee3126aa4de8a420915ede`. The persona came from `internal/assets/generic/persona-gentleman.md` and the skill from `skills/comment-writer`.

## What was verified

| Spec | Check | Result |
|---|---|---|
| S2 | Isolated `DSH_HOME=.spike/home`; `~/.dsh` was never created | ✅ |
| S3 | `dsh plugin --profile headless add <repo>` and `--profile web add <repo>` append `gentle-ai-dsh` after the base and surface bundles | ✅ |
| S3 | `--dump-config` shows a `# == gentle-ai-dsh` layer with the 3 rows | ✅ |
| S3 | `dsh plugin --profile web remove gentle-ai-dsh` removes both the dependency and the layer (0 matches after removal) | ✅ |
| S4 persona | Boot of `dsh --profile web`: section `gentle-ai:persona` (5219 chars) sits right after `deployment:persona-prefix` and before the surface sections | ✅ |
| S4 skill | `comment-writer` loads from provider `gentle-ai`, source `bundled` | ✅ |
| S4 Engram | 27 `mcp__engram__mem_*` tools are registered, and the `mcp:engram` server-instructions section is in the prompt | ✅ |

Runtime evidence comes from a spike-only probe plugin (`spike/probe/`). It is loaded with `--patch`, makes no model call, and writes a JSON report.

## What was NOT verified

- **A real conversation.** No LLM API key was available, so nobody has watched the model actually follow the persona or invoke the skill. The prompt contents are proven; the model's behavior is not.
- **The headless profile at runtime.** Its layer is verified with `--dump-config` only. Headless exits early without a key (`MISSING_CREDENTIAL`).
- **Skill precedence against user skills.** The probe's unscoped `ctx.skills.list()` returned only the bundled skill. It did not show skills from `~/.agents/skills`, which may be resolved per session cwd. By design, bundled rank 600 should lose to user-level skills of the same name. Not observed.
- **Subagents, slash commands, and the ODD/SDD orchestrator.** These are out of scope for this spike.

## Design choices the spike validated

1. **Persona as its own prompt section** (`ctx.systemPrompt.section`) and not by overriding `personaPrefix`. Overriding that row would replace configuration owned by the base, web-app, and headless bundles. `interpolate: false` keeps braces literal.
2. **Skills through a second `dsh-skill-filesystem` row** (`providerName: gentle-ai`, `bundledSkillDir`, `includeDefaultRoots: false`). This duplicates neither the base provider nor the user roots.
3. **Engram as a stdio `dsh-mcp-client` row.** Engram owns its storage: the spike connected to the user's real Engram database but made no tool calls.

## Gotchas found

- `dsh web` rejects launcher flags such as `--patch`. Use `dsh --profile web --patch … --no-open --port 0` instead.
- dsh routes plugin `console` output through its logger. The probe writes to a file (`GENTLE_PROBE_OUT`).
- `dsh plugin` needs `--profile`. `web` and `headless` are separate profiles, so the plugin has to be added to each one.

## Reproduce

```sh
mkdir -p .spike/dsh .spike/home .spike/play && cd .spike/dsh
echo '{"private":true}' > package.json && npm install @deepseek-ai/dsh@0.2.2-rc.1 && cd ../..
export DSH_HOME=$PWD/.spike/home DSH_TELEMETRY_DISABLED=1
D=$PWD/.spike/dsh/node_modules/.bin/dsh

$D plugin --profile web add "$PWD"
$D --profile web --dump-config | grep -A3 'gentle-ai'

cd .spike/play && git init -q
GENTLE_PROBE_OUT=$PWD/../probe-web.json timeout 20 \
  $D --profile web --patch ../../spike/probe/probe.patch.yml --no-open --port 0
cat ../probe-web.json
```

## Open decisions

1. **Engram when the binary is missing.** The row spawns `engram` on every boot. The options are to detect it and warn (recommended for v1), to download it on first use, or to leave installation to `gentle-ai install`.
2. **Syncing content.** Persona and skills are copied by hand at a pinned gentle-ai commit. A build step should pull them from a gentle-ai release.
3. **Which skills ship, and the orchestrator.** Choose which skills ship and whether the ODD/SDD orchestrator (subagents and commands) goes in a v2.
4. **Default profiles.** Decide whether the plugin should be offered for `web` only or for every profile.
