# gentle-ai-dsh overview

gentle-ai-dsh brings [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a native plugin bundle: the Gentleman persona, gentle-ai skills, the orchestrator with its ODD workflow, and optional Engram memory. Almost all of the content is reused from gentle-ai. The plugin's own code is the glue that fits it into dsh.

## What the plugin does

| Feature | How it works in dsh | Code |
|---|---|---|
| **Persona** | System-prompt section `gentle-ai:persona`, placed at dsh's persona position without replacing dsh's own prompt. | `index.js`, `persona.md` |
| **Orchestrator + ODD** | System-prompt section `gentle-ai:orchestrator`: gentle-ai's orchestrator, its Implementation Routing (ODD protocol, task size, delegation triggers, test-first policy) and a short dsh adaptation. | `index.js`, `orchestrator.md`, `lib/orchestrator.js`, `lib/routing.js`, `lib/dsh-runtime.js` |
| **Skills** | A separate skill provider (`providerName: gentle-ai`) with the bundled skills. Same-name user or project skills keep priority. Users invoke skills with `/`; the model loads them with the `skill` tool. | `cordis.patch.yml`, `skills/` |
| **Engram memory** | Engram runs as a stdio MCP server when the `engram` executable is on `PATH`. Without it, dsh still boots and the prompt tells the user how to install it. | `cordis.patch.yml`, `lib/engram.js` |
| **Engram project isolation** | dsh runs one Engram process for all sessions. A prompt section tells the model to call `mem_session_start` with the session's working directory and pass the returned project on every write. | `index.js` |
| **Engram write guard** | A `tools/pre-execute` hook denies Engram writes (`mem_save`, `mem_update`, `mem_session_summary`, `mem_save_prompt`) whose project does not match a successful `mem_session_start` for the current workspace. The denial tells the model the exact fix. Reads are never blocked. | `lib/guard.js`, `index.js` |
| **Content sync** | `npm run sync` fetches gentle-ai at the pinned ref, validates skills, renders the orchestrator and writes `NOTICE`. | `scripts/sync-gentle-ai.mjs`, `lib/skills.js` |

## What is reused from gentle-ai

All content comes from gentle-ai **v4.4.0** (commit `55240afb100ad6d2ef5fbe16f7be33a7693f77ad`, MIT). `NOTICE` lists the exact source files.

| Reused | Source in gentle-ai | Shipped as | Size |
|---|---|---|---|
| Gentleman persona | `internal/assets/generic/persona-gentleman.md` | `persona.md`, copied as is | 5,227 bytes |
| 11 skills | Skill directories in gentle-ai | `skills/`, copied as is | 14 files, 102,737 bytes |
| Generic orchestrator + shared ODD sections | `internal/assets/generic/orchestrator.md`, `internal/assets/skills/_shared/odd-orchestrator-sections.md` | First part of `orchestrator.md` | 30,954 bytes |
| Implementation Routing (ODD protocol) | `internal/components/agentguidance/routing.go` (`RenderRouting`), budgets from `internal/agents/capabilitymanifest/manifest.go` | Second part of `orchestrator.md` | 23,970 bytes |
| Engram | External `engram` executable | Not bundled; installed by the user | — |

Shipped skills: `branch-pr`, `chained-pr`, `cognitive-doc-design`, `comment-writer`, `gentle-ai-bench`, `gentle-ai-collab-perfect`, `issue-root-resolution`, `rdd-advisory-transport`, `rdd-defect-workflow`, `systemic-issue-triage`, `work-unit-commits`.

The orchestrator and routing are not hand-copied: `lib/orchestrator.js` and `lib/routing.js` are JavaScript ports of gentle-ai's own Go render logic. They take the generic, non-review path that gentle-ai uses for runtimes without its review transport. Updating gentle-ai means bumping the ref and running `npm run sync`.

### Reused vs. written here

- **Reused from gentle-ai:** about 163 KB of prompt and skill content (persona, skills, orchestrator, routing).
- **Written for dsh:** the dsh adaptation section (1,369 bytes), about 510 lines of plugin code and about 340 lines of tests.

## What is adapted or left out

- **Left out:** gentle-ai's native review / receipt-driven development (RDD), Judgment Day and the provider defect handoff. dsh has no gentle-ai review transport, so the render drops them and fails if any review content leaks through.
- **Adapted for dsh** (`lib/dsh-runtime.js`), taking precedence over the upstream text where they conflict:
  - Delegation uses dsh's `subagent` / `subagent_fork` tools.
  - Skills load with dsh's `skill` tool, not gentle-ai's skill-registry files or other agents' skill directories.
  - Engram is optional and project-scoped through `mem_session_start`.
  - Verification is the change's own checks, plus an independent read-only verifier for high-risk changes.

## Verification so far

- `npm test`: 23 tests pass.
- Isolated `dsh --profile web` boot: persona, orchestrator and Engram sections present; 11 skills; 27 Engram tools.
- Real-model checks by the user in `dsh web`: persona followed, a skill invoked, memory saved in the right project (v1); ODD small-task flow followed and Engram writes scoped correctly (v2, PR #8).

## Prompt cost

The plugin adds about 62 KB of system prompt per request: the persona (5 KB), the orchestrator (56 KB) and a small Engram note. Measured with provider-reported usage from two real `dsh web` sessions in the same test workspace, on 2026-11-11:

| Session | First request: prompt tokens | Later requests: served from cache |
|---|---|---|
| Before v2 (no orchestrator) | 19,690 | about 99% |
| With v2 (orchestrator) | 30,948 | about 99% (225–551 uncached tokens per request) |

- **The orchestrator section costs about 11,300 tokens per request**, about 5 bytes per token. This is the difference between the two first requests, so it includes some noise from the different first user message.
- **DeepSeek caches the repeated prompt prefix automatically.** After the first request in a session, almost the whole prompt is billed at the cache-hit price, a small fraction of the normal input price. See [pricing](https://api-docs.deepseek.com/quick_start/pricing) and [context caching](https://api-docs.deepseek.com/guides/kv_cache).
- **The full price is paid on the first request of a session, or when the cache has expired.** DeepSeek keeps unused cache entries for a few hours to a few days.

## Status and roadmap

v2 is tracked in issue #3:

- **#9 — orchestrator and ODD protocol:** done (PR #8).
- **#10 — explore / worker / verify subagents in `dsh web`:** open.
- **#11 — integration and docs:** open; closes #3.

Contributors: start with [the v2 plan and handoff](../odd/tasks/v2.md).
