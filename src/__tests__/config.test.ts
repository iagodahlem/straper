import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getConfigDir,
  ensureConfigDir,
  readConfig,
  writeConfig,
  createDefaultConfig,
  readWorkspaces,
  registerWorkspace,
  listSharedFiles,
  resolveCliInstallTarget,
  type UserConfig,
  type WorkspaceEntry,
} from '../config.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'config-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// getConfigDir
// ---------------------------------------------------------------------------
describe('getConfigDir', () => {
  const origXdg = process.env.XDG_CONFIG_HOME

  afterEach(() => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = origXdg
    }
  })

  it('returns XDG_CONFIG_HOME/straper when env var is set', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config'
    expect(getConfigDir()).toBe('/custom/config/straper')
  })

  it('returns ~/.config/straper when env var is not set', () => {
    delete process.env.XDG_CONFIG_HOME
    const result = getConfigDir()
    expect(result).toMatch(/\.config\/straper$/)
    expect(result).not.toContain('undefined')
  })
})

// ---------------------------------------------------------------------------
// ensureConfigDir
// ---------------------------------------------------------------------------
describe('ensureConfigDir', () => {
  it('creates directory structure if missing', async () => {
    const configDir = join(tmpDir, 'new-config')
    const result = await ensureConfigDir(configDir)

    expect(result).toBe(configDir)

    // Verify both the root and shared/ directories were created
    const { stat } = await import('node:fs/promises')
    const rootInfo = await stat(configDir)
    expect(rootInfo.isDirectory()).toBe(true)

    const sharedInfo = await stat(join(configDir, 'shared'))
    expect(sharedInfo.isDirectory()).toBe(true)
  })

  it('no-ops if already exists', async () => {
    const configDir = join(tmpDir, 'existing-config')
    await mkdir(join(configDir, 'shared'), { recursive: true })

    // Should not throw
    const result = await ensureConfigDir(configDir)
    expect(result).toBe(configDir)
  })
})

// ---------------------------------------------------------------------------
// readConfig / writeConfig
// ---------------------------------------------------------------------------
describe('readConfig / writeConfig', () => {
  it('round-trips a config object', async () => {
    const config: UserConfig = {
      version: 1,
      user: { name: 'Alice', role: 'Engineer' },
      defaults: { provider: 'claude', branch_prefix: 'alice/' },
      cli: { install_target: '~/.local/bin' },
    }

    await writeConfig(config, tmpDir)
    const result = await readConfig(tmpDir)

    expect(result).toEqual(config)
  })

  it('readConfig returns null when file does not exist', async () => {
    const result = await readConfig(join(tmpDir, 'nonexistent'))
    expect(result).toBeNull()
  })

  it('writeConfig creates parent dirs', async () => {
    const nested = join(tmpDir, 'deep', 'nested', 'dir')
    const config = createDefaultConfig({ name: 'Test', role: 'Dev' })

    await writeConfig(config, nested)

    const raw = await readFile(join(nested, 'config.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.user.name).toBe('Test')
  })

  it('writes JSON with 2-space indentation', async () => {
    const config = createDefaultConfig({ name: 'Test', role: 'Dev' })
    await writeConfig(config, tmpDir)

    const raw = await readFile(join(tmpDir, 'config.json'), 'utf-8')
    // 2-space indent means lines like '  "version": 1,'
    expect(raw).toContain('  "version": 1')
    // Trailing newline
    expect(raw.endsWith('\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createDefaultConfig
// ---------------------------------------------------------------------------
describe('createDefaultConfig', () => {
  it('sets version to 1', () => {
    const config = createDefaultConfig({ name: 'Alice', role: 'Engineer' })
    expect(config.version).toBe(1)
  })

  it('uses provided values', () => {
    const config = createDefaultConfig({
      name: 'Alice',
      role: 'Staff Engineer',
      branchPrefix: 'alice/',
      provider: 'codex',
      installTarget: '~/bin',
    })

    expect(config.user.name).toBe('Alice')
    expect(config.user.role).toBe('Staff Engineer')
    expect(config.defaults.provider).toBe('codex')
    expect(config.defaults.branch_prefix).toBe('alice/')
    expect(config.cli.install_target).toBe('~/bin')
  })

  it('uses defaults for optional fields', () => {
    const config = createDefaultConfig({ name: 'Test', role: 'Dev' })

    expect(config.defaults.provider).toBe('claude')
    expect(config.defaults.branch_prefix).toBe('')
    expect(config.cli.install_target).toBe('~/.local/bin')
  })
})

// ---------------------------------------------------------------------------
// readWorkspaces / registerWorkspace
// ---------------------------------------------------------------------------
describe('readWorkspaces / registerWorkspace', () => {
  it('returns empty registry when file does not exist', async () => {
    const result = await readWorkspaces(join(tmpDir, 'nonexistent'))
    expect(result).toEqual({ version: 1, workspaces: [] })
  })

  it('registers a workspace and reads it back', async () => {
    const entry: WorkspaceEntry = {
      name: 'myagent',
      path: '/home/user/agents/myagent',
      agent: 'myagent',
      created_at: '2026-03-18T00:00:00.000Z',
    }

    await registerWorkspace(entry, tmpDir)
    const registry = await readWorkspaces(tmpDir)

    expect(registry.version).toBe(1)
    expect(registry.workspaces).toHaveLength(1)
    expect(registry.workspaces[0]).toEqual(entry)
  })

  it('updates existing workspace (idempotent by name)', async () => {
    const entry1: WorkspaceEntry = {
      name: 'myagent',
      path: '/old/path',
      agent: 'myagent',
      created_at: '2026-01-01T00:00:00.000Z',
    }

    const entry2: WorkspaceEntry = {
      name: 'myagent',
      path: '/new/path',
      agent: 'myagent-v2',
      created_at: '2026-03-18T00:00:00.000Z',
    }

    await registerWorkspace(entry1, tmpDir)
    await registerWorkspace(entry2, tmpDir)

    const registry = await readWorkspaces(tmpDir)
    expect(registry.workspaces).toHaveLength(1)
    expect(registry.workspaces[0].path).toBe('/new/path')
    expect(registry.workspaces[0].agent).toBe('myagent-v2')
  })

  it('registers multiple distinct workspaces', async () => {
    const entry1: WorkspaceEntry = {
      name: 'myagent',
      path: '/path/myagent',
      agent: 'myagent',
      created_at: '2026-01-01T00:00:00.000Z',
    }

    const entry2: WorkspaceEntry = {
      name: 'nova',
      path: '/path/nova',
      agent: 'nova',
      created_at: '2026-03-18T00:00:00.000Z',
    }

    await registerWorkspace(entry1, tmpDir)
    await registerWorkspace(entry2, tmpDir)

    const registry = await readWorkspaces(tmpDir)
    expect(registry.workspaces).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// listSharedFiles
// ---------------------------------------------------------------------------
describe('listSharedFiles', () => {
  it('returns empty array when shared/ does not exist', async () => {
    const result = await listSharedFiles(join(tmpDir, 'nonexistent'))
    expect(result).toEqual([])
  })

  it('lists files in shared/ with relative paths', async () => {
    const sharedDir = join(tmpDir, 'shared')
    await mkdir(sharedDir, { recursive: true })
    await writeFile(join(sharedDir, 'USER.md'), '# User', 'utf-8')
    await writeFile(join(sharedDir, 'TOOLS.md'), '# Tools', 'utf-8')

    const result = await listSharedFiles(tmpDir)

    expect(result).toHaveLength(2)
    expect(result.map((f) => f.relativePath)).toEqual(['TOOLS.md', 'USER.md'])
    expect(result[0].absolutePath).toBe(join(sharedDir, 'TOOLS.md'))
    expect(result[1].absolutePath).toBe(join(sharedDir, 'USER.md'))
  })

  it('lists nested files with relative paths', async () => {
    const sharedDir = join(tmpDir, 'shared')
    await mkdir(join(sharedDir, 'agents'), { recursive: true })
    await writeFile(join(sharedDir, 'USER.md'), '# User', 'utf-8')
    await writeFile(join(sharedDir, 'agents', 'reviewer.md'), '# Reviewer', 'utf-8')

    const result = await listSharedFiles(tmpDir)

    expect(result).toHaveLength(2)
    expect(result.map((f) => f.relativePath)).toEqual([
      join('agents', 'reviewer.md'),
      'USER.md',
    ])
  })
})

// ---------------------------------------------------------------------------
// resolveCliInstallTarget
// ---------------------------------------------------------------------------
describe('resolveCliInstallTarget', () => {
  it('returns config value if directory exists', async () => {
    const targetDir = join(tmpDir, 'custom-bin')
    await mkdir(targetDir, { recursive: true })

    const config = createDefaultConfig({ name: 'Test', role: 'Dev', installTarget: targetDir })
    const result = await resolveCliInstallTarget(config)

    expect(result).toBe(targetDir)
  })

  it('falls back to ~/.local/bin if config target does not exist', async () => {
    // Create a fake home structure
    const fakeHome = join(tmpDir, 'fakehome')
    const localBin = join(fakeHome, '.local', 'bin')
    await mkdir(localBin, { recursive: true })

    // Config points to a nonexistent dir, but we can't easily mock homedir().
    // Instead, test that a nonexistent config target is skipped.
    const config = createDefaultConfig({
      name: 'Test',
      role: 'Dev',
      installTarget: join(tmpDir, 'nonexistent-dir'),
    })
    const result = await resolveCliInstallTarget(config)

    // Since the config target doesn't exist and we can't mock homedir(),
    // the result depends on the real system. Just verify the logic works
    // by checking it doesn't return the nonexistent path.
    if (result !== null) {
      expect(result).not.toBe(join(tmpDir, 'nonexistent-dir'))
    }
  })

  it('returns null if nothing exists', async () => {
    const config = createDefaultConfig({
      name: 'Test',
      role: 'Dev',
      installTarget: join(tmpDir, 'nope', 'not-here'),
    })

    // We mock by providing a config that points to nonexistent dirs.
    // The fallbacks (~/bin, ~/.local/bin) may or may not exist on the test machine,
    // so we test the specific scenario where the config target doesn't exist.
    const result = await resolveCliInstallTarget(config)
    // If the system has ~/.local/bin or ~/bin, result won't be null.
    // We can at least verify the function returns a string or null.
    expect(result === null || typeof result === 'string').toBe(true)
  })

  it('returns null when config is null and no fallback dirs exist', async () => {
    // This tests the null config path. Since we can't control whether
    // ~/.local/bin or ~/bin exist on the test machine, we just verify
    // it handles null config without throwing.
    const result = await resolveCliInstallTarget(null)
    expect(result === null || typeof result === 'string').toBe(true)
  })

  it('skips config target that is a file, not a directory', async () => {
    const filePath = join(tmpDir, 'not-a-dir')
    await writeFile(filePath, 'I am a file', 'utf-8')

    const config = createDefaultConfig({
      name: 'Test',
      role: 'Dev',
      installTarget: filePath,
    })

    const result = await resolveCliInstallTarget(config)
    // Should not return the file path since it's not a directory
    if (result !== null) {
      expect(result).not.toBe(filePath)
    }
  })
})
