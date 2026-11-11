# Content sync

`npm run sync` clones the repository and ref in `package.json`'s `gentleAi` field into a temporary directory, then copies the generic persona and valid skill directories into this bundle. It never executes upstream code. Invalid skill frontmatter is reported and skipped; the full directory of each valid skill is copied, including references. Persona template markers cause the sync to fail.

To update content, change `gentleAi.ref` to the intended tag or commit and run `npm run sync`, then `npm test`. Review the resulting content and `NOTICE`, which records the source, resolved commit and shipped directories. Individual skills may declare a different license in their frontmatter. The command needs Git and network access.
