# dsh-plugin-spike

Spike: prove that gentle-ai can ship to DeepSeek Harness (dsh) as an installable dsh plugin bundle.
Scope is evidence, not a product: a minimal plugin, an isolated dsh install, and a findings report.

## Specs

- S1. Build the spike the user approved: "ok dale arma el spike." The spike, as proposed and accepted: "un plugin mínimo con una skill, la persona y Engram por MCP, corriendo en un dsh aislado".
- S2. Isolation: dsh runs with an isolated `DSH_HOME` (no writes to the user's `~/.dsh`).
- S3. The plugin installs with `dsh plugin add` (from a local checkout) and its layer is visible without an LLM call (`dsh --profile <p> --dump-config`).
- S4. The plugin contributes at least one gentle-ai skill, a gentle-ai persona/system-prompt fragment, and an Engram stdio MCP server row.
- S5. Findings report `docs/spike-findings.md`: what was verified, what was not (and why), exact commands to reproduce, and the open decisions.
- S6. After the spike: "luego creamos el repo con gentle-ai-dsh, privado, mi usuario."

## Tasks

- T1 (S1-S4) Map the dsh plugin API for prompt sections, skill providers and offline verification. Route: explore. Commit: n/a
- T2 (S2-S4) Write the minimal plugin package `gentle-ai-dsh`. Route: inline. Commit: initial (feat: gentle-ai dsh plugin spike)
- T3 (S2-S3) Install dsh in isolation, add the plugin, verify with `--dump-config` and any offline check. Route: inline. Commit: initial (spike/probe)
- T4 (S5) Write the findings report. Route: inline. Commit: initial (docs/spike-findings.md)
- T5 (S6) Create the private GitHub repo `gentle-ai-dsh` under the user's account and push. Route: inline. Commit: n/a

## Log

- L1. User: "ok dale arma el spike. luego creamos el repo con gentle-ai-dsh, privado, mi usuario."
- L2. Context: dsh 0.2.2-rc.1 (developer preview). Engram 3.7.0 is on PATH. No LLM API key in the environment, so verification must work without a model call.
- L3. Evidence: plugin installs into isolated `web` and `headless` profiles; `--dump-config` shows the layer; probe boot of `--profile web` shows section `gentle-ai:persona`, skill `comment-writer` (provider gentle-ai, bundled) and 27 `mcp__engram__*` tools; `plugin remove` clears it; `~/.dsh` never created. No real model turn (no API key). Details: docs/spike-findings.md.
- L4. User asked mid-spike: "hay una pega dsh no hay para linux?" Answer: Desktop app is macOS/Windows only; the npm CLI (`dsh web`) runs on Linux (Node >= 24.9).
