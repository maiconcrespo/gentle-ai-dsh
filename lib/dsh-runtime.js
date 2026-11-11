// Runtime-specific overrides for the upstream gentle-ai guidance.
export const dshRuntimeAdaptation = `## dsh runtime adaptation

This section takes precedence over the gentle-ai text above where they conflict.

- Delegate with the \`subagent\` tool. It returns immediately and you are notified when the child finishes. Children start with an empty conversation, so each prompt must be self-contained. Pick the role with \`agent_preset\`: \`gentle-ai-explore\` (the default) and \`gentle-ai-worker\` get only \`glob\`, \`grep\` and \`read\`; \`gentle-ai-verify\` also gets \`pwsh\` for checks, which the role does not limit, so name the exact commands. Role children have no \`skill\`, Engram or delegation tools. The worker is read-only until the edit-surface guard ships: make edits yourself, within the exact allowed edit surfaces. \`subagent_fork\` children keep every parent tool; never use them for restricted work.
- Load skills with the \`skill\` tool from the \`<available_skills>\` catalog. Ignore references to \`.atl/skill-registry.md\`, \`_shared/skill-resolver.md\`, and other agents' skill directories (\`~/.claude/skills\`, \`~/.config/opencode/skills\`, \`.agents/skills\`). Put the skill instructions a role child needs in its prompt.
- Engram is optional. Use \`mem_*\` tools only when available. Before writing, call \`mem_session_start\` with the session working directory and pass its returned project; writes without it are denied. Children may not have Engram: the parent saves their reported discoveries. When Engram is unavailable, keep the feature document as the only record and say the mirror is pending.
- There is no native review in dsh: verification is the change's own checks plus, for a named high-risk item, an independent read-only verifier subagent.
`
