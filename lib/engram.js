import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'

export function findOnPath(command, env = process.env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = resolve(dir, command)
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch { /* Missing or not executable. */ }
  }
  return null
}
