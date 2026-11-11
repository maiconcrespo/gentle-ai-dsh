// Runtime-specific overrides for the upstream gentle-ai guidance.
export const dshRuntimeAdaptation = `## dsh runtime adaptation

This section takes precedence over the gentle-ai text above where they conflict.

- Delegate with the \`subagent\` tool, or \`subagent_fork\` to fork the current context. \`subagent\` returns immediately and you are notified when the child finishes. Children start with an empty conversation, so each prompt must be self-contained. Named explore, worker, and verify roles are not installed yet; give the role's limits (read-only, or exact allowed edit surfaces) in the prompt.
- Load skills with the \`skill\` tool from the \`<available_skills>\` catalog. Ignore references to \`.atl/skill-registry.md\`, \`_shared/skill-resolver.md\`, and other agents' skill directories (\`~/.claude/skills\`, \`~/.config/opencode/skills\`, \`.agents/skills\`). Pass skill names, not paths, to subagents and tell them to load them with \`skill\`.
- Engram is optional. Use \`mem_*\` tools only when available. Before writing, call \`mem_session_start\` with the session working directory and pass its returned project; writes without it are denied. Children may not have Engram: the parent saves their reported discoveries. When Engram is unavailable, keep the feature document as the only record and say the mirror is pending.
- There is no native review in dsh: verification is the change's own checks plus, for a named high-risk item, an independent read-only verifier subagent.
`
