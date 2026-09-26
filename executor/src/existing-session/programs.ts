import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveProgramPath } from '../coding-session/program-path.js'
import { runCommand } from '../coding-session/agent-env.js'
import type { ExistingProvider } from './types.js'

export type ProviderProgram = { path: string; version: string }

/** Native executables only: no shell, npm script shim, model-supplied path or working-directory lookup. */
export const findProviderProgram = async (
  provider: ExistingProvider, env: NodeJS.ProcessEnv,
): Promise<ProviderProgram | undefined> => {
  const home = homedir()
  const candidates: string[] = []
  if (provider === 'codex' && process.platform === 'darwin') {
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  }
  if (provider === 'codex' && process.platform === 'win32') {
    const directory = join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')
    const versions = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of versions.filter((item) => item.isDirectory()).slice(-32).reverse()) {
      candidates.push(join(directory, entry.name, 'codex.exe'))
    }
  }
  const fromPath = await resolveProgramPath(provider, env)
  if (fromPath) candidates.push(fromPath)
  candidates.push(join(home, '.local', 'bin', process.platform === 'win32' ? `${provider}.exe` : provider))
  for (const candidate of [...new Set(candidates)]) {
    if (!await access(candidate).then(() => true, () => false)) continue
    const result = await runCommand(candidate, ['--version'], { env, timeoutMs: 5_000, maxBytes: 4_096 })
    if (result.code === 0) return { path: candidate, version: result.stdout.trim().slice(0, 100) }
  }
  return undefined
}
