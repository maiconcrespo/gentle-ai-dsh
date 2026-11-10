# gentle-ai-dsh

Spike: [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin bundle.

> Status: proof of concept, not published. See [docs/spike-findings.md](docs/spike-findings.md).

## What it adds to dsh

- **Persona:** the gentle-ai Gentleman persona, added as its own system-prompt section.
- **Skills:** gentle-ai skills from `skills/`, loaded at bundled priority so your own skills with the same name win.
- **Memory:** [Engram](https://github.com/Gentleman-Programming/engram) over stdio MCP. This needs the `engram` executable on your `PATH`.

## Try it locally

Requires Node.js 24.9 or newer and pnpm.

```sh
dsh plugin --profile web add /path/to/gentle-ai-dsh
dsh web
```

To remove it:

```sh
dsh plugin --profile web remove gentle-ai-dsh
```

## Layout

| Path | Purpose |
|---|---|
| `package.json` | Declares the `dsh.bundle` and the supported `engines.dsh` range |
| `cordis.patch.yml` | The bundle layer: the persona plugin, the skill provider, and the Engram MCP row |
| `index.js` | The persona plugin |
| `persona.md`, `skills/` | Content copied from gentle-ai (see NOTICE) |
| `spike/probe/` | A spike-only runtime probe; not part of the bundle |
| `odd/tasks/` | Spike task tracking |

## License

MIT. Content copied from gentle-ai keeps its upstream license; see [NOTICE](NOTICE).
