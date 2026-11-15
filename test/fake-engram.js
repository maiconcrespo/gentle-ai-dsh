import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Writes a fake engram executable that findOnPath accepts on this platform:
// an executable `engram` on POSIX, plus `engram.exe` on Windows.
export function installFakeEngram(dir) {
  writeFileSync(join(dir, 'engram'), '')
  chmodSync(join(dir, 'engram'), 0o755)
  if (process.platform === 'win32') writeFileSync(join(dir, 'engram.exe'), '')
}
