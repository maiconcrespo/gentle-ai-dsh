// Runtime-specific overrides for the upstream gentle-ai guidance.
export const dshRuntimeAdaptation = `## dsh runtime adaptation

This section takes precedence over the gentle-ai text above where they conflict.

- Delegate with the \`subagent\` tool. It returns immediately and you are notified when the child finishes. Children start with an empty conversation, so each prompt must be self-contained. When the \`subagent\` tool offers \`agent_preset\`, pick the role with it: \`gentle-ai-explore\` (the default) and \`gentle-ai-worker\` get only \`glob\`, \`grep\` and \`read\`; \`gentle-ai-verify\` also gets the platform shell, \`pwsh\` on Windows and \`bash\` on Linux and macOS, for checks; it is not limited by path or command, so name the exact commands. Role children have no \`skill\`, Engram or delegation tools. The worker is read-only until the edit-surface guard (#16) ships: make edits yourself, within the exact allowed edit surfaces. \`subagent_fork\` children keep every parent tool; never use them for restricted work. Otherwise, delegate without it and state the role limits in the prompt.
- Load skills with the \`skill\` tool from the \`<available_skills>\` catalog, which lists every skill installed for this session. Put the skill instructions a role child needs in its prompt.
- Engram is optional. Use \`mem_*\` tools only when available. Before writing, call \`mem_session_start\` with the session working directory and pass its returned project; writes without it are denied. Children may not have Engram: the parent saves their reported discoveries. When Engram is unavailable, keep the feature document as the only record and say the mirror is pending.
- There is no native review in dsh: verification is the change's own checks plus, for a named high-risk item, an independent read-only verifier subagent.
`
