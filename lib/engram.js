import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'

// Windows has no executable bit: a command is found by trying each PATHEXT
// extension (engram installs as engram.exe), and a bare name never runs.
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

function candidateNames(command, env, platform) {
  if (platform !== 'win32') return [command]
  const exts = (env.PATHEXT || WINDOWS_DEFAULT_PATHEXT).split(';').filter(Boolean).map((ext) => ext.toLowerCase())
  if (exts.some((ext) => command.toLowerCase().endsWith(ext))) return [command]
  return exts.map((ext) => command + ext)
}

export function findOnPath(command, env = process.env, platform = process.platform) {
  const names = candidateNames(command, env, platform)
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = resolve(dir, name)
      try {
        if (statSync(candidate).isFile()) {
          if (platform !== 'win32') accessSync(candidate, constants.X_OK)
          return candidate
        }
      } catch { /* Missing or not executable. */ }
    }
  }
  return null
}
