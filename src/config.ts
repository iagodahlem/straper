import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

export interface UserConfig {
  version: number
  user: {
    name: string
    role: string
  }
  defaults: {
    provider: string
    branch_prefix: string
  }
  cli: {
    install_target: string
  }
}

export interface WorkspaceEntry {
  name: string
  path: string
  agent: string
  created_at: string // ISO date
}

export interface WorkspacesRegistry {
  version: number
  workspaces: WorkspaceEntry[]
}

/**
 * Get the config directory path.
 * Respects $XDG_CONFIG_HOME if set, otherwise ~/.config/straper
 */
export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) {
    return join(xdg, 'straper')
  }
  return join(homedir(), '.config', 'straper')
}

/**
 * Ensure the config directory and subdirectories exist.
 * Creates ~/.config/straper/, ~/.config/straper/shared/ if missing.
 */
export async function ensureConfigDir(configDir?: string): Promise<string> {
  const dir = configDir ?? getConfigDir()
  await mkdir(join(dir, 'shared'), { recursive: true })
  return dir
}

/**
 * Read config.json. Returns null if doesn't exist.
 */
export async function readConfig(configDir?: string): Promise<UserConfig | null> {
  const dir = configDir ?? getConfigDir()
  try {
    const raw = await readFile(join(dir, 'config.json'), 'utf-8')
    return JSON.parse(raw) as UserConfig
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * Write config.json. Creates config dir if needed.
 */
export async function writeConfig(config: UserConfig, configDir?: string): Promise<void> {
  const dir = configDir ?? getConfigDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

/**
 * Create a default UserConfig from provided values.
 */
export function createDefaultConfig(opts: {
  name: string
  role: string
  branchPrefix?: string
  provider?: string
  installTarget?: string
}): UserConfig {
  return {
    version: 1,
    user: {
      name: opts.name,
      role: opts.role,
    },
    defaults: {
      provider: opts.provider ?? 'claude',
      branch_prefix: opts.branchPrefix ?? '',
    },
    cli: {
      install_target: opts.installTarget ?? '~/.local/bin',
    },
  }
}

/**
 * Read workspaces.json. Returns empty registry if doesn't exist.
 */
export async function readWorkspaces(configDir?: string): Promise<WorkspacesRegistry> {
  const dir = configDir ?? getConfigDir()
  try {
    const raw = await readFile(join(dir, 'workspaces.json'), 'utf-8')
    return JSON.parse(raw) as WorkspacesRegistry
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { version: 1, workspaces: [] }
    }
    throw err
  }
}

/**
 * Register a new workspace in workspaces.json.
 * Idempotent -- updates if workspace with same name exists.
 */
export async function registerWorkspace(entry: WorkspaceEntry, configDir?: string): Promise<void> {
  const dir = configDir ?? getConfigDir()
  const registry = await readWorkspaces(dir)

  const index = registry.workspaces.findIndex((w) => w.name === entry.name)
  if (index >= 0) {
    registry.workspaces[index] = entry
  } else {
    registry.workspaces.push(entry)
  }

  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify(registry, null, 2) + '\n', 'utf-8')
}

/**
 * List all shared files from ~/.config/straper/shared/.
 * Returns array of { relativePath, absolutePath }.
 */
export async function listSharedFiles(
  configDir?: string,
): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const dir = configDir ?? getConfigDir()
  const sharedDir = join(dir, 'shared')

  try {
    await access(sharedDir)
  } catch {
    return []
  }

  const results: Array<{ relativePath: string; absolutePath: string }> = []

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current)
    for (const entry of entries) {
      const fullPath = join(current, entry)
      const info = await stat(fullPath)
      if (info.isDirectory()) {
        await walk(fullPath)
      } else {
        results.push({
          relativePath: relative(sharedDir, fullPath),
          absolutePath: fullPath,
        })
      }
    }
  }

  await walk(sharedDir)
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/**
 * Resolve the CLI install target directory.
 * Priority: 1) config.cli.install_target, 2) ~/.local/bin, 3) ~/bin, 4) null
 * Only returns paths that exist on disk.
 */
export async function resolveCliInstallTarget(config: UserConfig | null): Promise<string | null> {
  const home = homedir()

  const candidates: string[] = []

  if (config?.cli.install_target) {
    candidates.push(expandTilde(config.cli.install_target, home))
  }

  candidates.push(join(home, '.local', 'bin'))
  candidates.push(join(home, 'bin'))

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) {
        return candidate
      }
    } catch {
      // Directory doesn't exist, try next
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function expandTilde(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
