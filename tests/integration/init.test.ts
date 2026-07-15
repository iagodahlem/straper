import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { init } from '../../src/commands/init.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp dir for each test and point XDG_CONFIG_HOME away from real config. */
let tmpDir: string
let configDir: string
const origXdg = process.env.XDG_CONFIG_HOME
const origEmail = process.env.GIT_AUTHOR_EMAIL
const origCommitterEmail = process.env.GIT_COMMITTER_EMAIL

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-init-test-'))
  configDir = join(tmpDir, 'xdg-config')
  await mkdir(configDir, { recursive: true })
  process.env.XDG_CONFIG_HOME = configDir
  // Ensure git commit works even without global git config
  process.env.GIT_AUTHOR_EMAIL = 'test@straper.dev'
  process.env.GIT_COMMITTER_EMAIL = 'test@straper.dev'
})

afterEach(async () => {
  if (origXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = origXdg
  }
  if (origEmail === undefined) {
    delete process.env.GIT_AUTHOR_EMAIL
  } else {
    process.env.GIT_AUTHOR_EMAIL = origEmail
  }
  if (origCommitterEmail === undefined) {
    delete process.env.GIT_COMMITTER_EMAIL
  } else {
    process.env.GIT_COMMITTER_EMAIL = origCommitterEmail
  }
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 })
  vi.restoreAllMocks()
})

/** Run init with defaults suitable for testing. */
async function initWorkspace(
  name: string,
  overrides: Partial<Parameters<typeof init>[0]> = {},
): Promise<string> {
  const dir = overrides.dir ?? join(tmpDir, name)
  await init({
    name,
    dir,
    user: 'Test User',
    project: 'TestProject',
    description: 'A test workspace',
    ...overrides,
  })
  return dir
}

/** Check whether a path exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Recursively collect all file paths under a directory. */
async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(join(dir, entry.name), rel)))
    } else {
      files.push(rel)
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(
  'straper init — integration',
  () => {
    // ------------------------------------------------------------------
    // 1. Creates a complete workspace
    // ------------------------------------------------------------------
    describe('creates a complete workspace', () => {
      let wsDir: string

      beforeEach(async () => {
        wsDir = await initWorkspace('nova')
      })

      it('creates root markdown files', async () => {
        for (const file of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'BOOT.md', 'MEMORY.md']) {
          expect(await exists(join(wsDir, file))).toBe(true)
        }
      })

      it('creates preferences.json', async () => {
        const path = join(wsDir, 'preferences.json')
        expect(await exists(path)).toBe(true)
        const content = await readFile(path, 'utf-8')
        JSON.parse(content) // should not throw
      })

      it('creates .gitignore', async () => {
        expect(await exists(join(wsDir, '.gitignore'))).toBe(true)
      })

      it('creates an empty straper.lock so the workspace is add-ready', async () => {
        const lockPath = join(wsDir, 'straper.lock')
        expect(await exists(lockPath)).toBe(true)
        const lock = JSON.parse(await readFile(lockPath, 'utf-8'))
        expect(lock).toEqual({ lockfileVersion: 1, modules: {} })
      })

      it('CLAUDE.md is a symlink pointing to AGENTS.md', async () => {
        const info = await lstat(join(wsDir, 'CLAUDE.md'))
        expect(info.isSymbolicLink()).toBe(true)
        const target = await readlink(join(wsDir, 'CLAUDE.md'))
        expect(target).toBe('AGENTS.md')
      })

      it('.claude/settings.json exists and is valid JSON', async () => {
        const settingsPath = join(wsDir, '.claude', 'settings.json')
        expect(await exists(settingsPath)).toBe(true)
        const content = await readFile(settingsPath, 'utf-8')
        expect(() => JSON.parse(content)).not.toThrow()
      })

      it('tasks/schema.json exists', async () => {
        expect(await exists(join(wsDir, 'tasks', 'schema.json'))).toBe(true)
      })

      it('designs/TEMPLATE.md and designs/INDEX.md exist', async () => {
        expect(await exists(join(wsDir, 'designs', 'TEMPLATE.md'))).toBe(true)
        expect(await exists(join(wsDir, 'designs', 'INDEX.md'))).toBe(true)
      })

      it('scripts/ contains agent-named CLI wrapper and .js orchestrator', async () => {
        expect(await exists(join(wsDir, 'scripts', 'nova'))).toBe(true)
        expect(await exists(join(wsDir, 'scripts', 'nova.js'))).toBe(true)
      })

      it('prompts/ contains root-level prompt template files', async () => {
        for (const file of ['ship.md', 'session-review.md']) {
          expect(await exists(join(wsDir, 'prompts', file))).toBe(true)
        }
      })

      it('completions/ contains agent-named completion scripts', async () => {
        expect(await exists(join(wsDir, 'completions', 'nova.bash'))).toBe(true)
        expect(await exists(join(wsDir, 'completions', '_nova'))).toBe(true)
      })

      it('empty directories exist with .gitkeep', async () => {
        for (const dir of ['memory', 'plans', 'repos', 'workspaces', 'agents', 'patches']) {
          const dirPath = join(wsDir, dir)
          const info = await stat(dirPath)
          expect(info.isDirectory()).toBe(true)
          expect(await exists(join(dirPath, '.gitkeep'))).toBe(true)
        }
      })

      it('.githooks/pre-commit exists and is executable', async () => {
        const hookPath = join(wsDir, '.githooks', 'pre-commit')
        expect(await exists(hookPath)).toBe(true)
        const info = await stat(hookPath)
        // Owner-execute bit set
        expect(info.mode & 0o100).toBeGreaterThan(0)
      })
    })

    // ------------------------------------------------------------------
    // 2. Template variables are fully substituted
    // ------------------------------------------------------------------
    it('no {{...}} placeholders remain in any generated file', async () => {
      const wsDir = await initWorkspace('nova')

      const allFiles = await walkFiles(wsDir)
      // Match scaffold-style placeholders: {{word_chars}} only.
      // Excludes JS template literals like `{{${key}}}` which are runtime code.
      const placeholderPattern = /\{\{\w+\}\}/g

      for (const relPath of allFiles) {
        // Skip .git internals
        if (relPath.startsWith('.git/') || relPath.startsWith('.git\\')) continue
        // Skip prompt templates — they contain runtime {{PLACEHOLDER}} variables
        // that are resolved by the workspace CLI, not by Straper's scaffold engine
        if (relPath.startsWith('prompts/') || relPath.startsWith('prompts\\')) continue

        const fullPath = join(wsDir, relPath)
        try {
          const info = await stat(fullPath)
          if (info.isDirectory() || info.size > 100_000) continue

          const content = await readFile(fullPath, 'utf-8')
          const matches = content.match(placeholderPattern)
          if (matches) {
            expect.fail(
              `File "${relPath}" still contains unresolved template placeholder: ${matches[0]}`,
            )
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EISDIR') continue
          throw err
        }
      }
    })

    // ------------------------------------------------------------------
    // 3. preferences.json has correct values
    // ------------------------------------------------------------------
    it('preferences.json contains correct agent_name and agent_display_name', async () => {
      const wsDir = await initWorkspace('nova')
      const content = await readFile(join(wsDir, 'preferences.json'), 'utf-8')
      const prefs = JSON.parse(content)

      expect(prefs.agent_name).toBe('nova')
      expect(prefs.agent_display_name).toBe('Nova')
    })

    it('config/providers.json sets codex profiles to empty model strings', async () => {
      const wsDir = await initWorkspace('nova')
      const content = await readFile(join(wsDir, 'config', 'providers.json'), 'utf-8')
      const providers = JSON.parse(content)

      expect(providers.providers.codex.profiles.fast.model).toBe('')
      expect(providers.providers.codex.profiles.strong.model).toBe('')
    })

    // ------------------------------------------------------------------
    // 4. Scripts are executable
    // ------------------------------------------------------------------
    it('.sh files and the CLI wrapper are executable', async () => {
      const wsDir = await initWorkspace('nova')

      const scriptsDir = join(wsDir, 'scripts')
      const allScripts = await walkFiles(scriptsDir)

      for (const relPath of allScripts) {
        const fullPath = join(scriptsDir, relPath)
        const info = await stat(fullPath)
        if (info.isDirectory()) continue

        if (relPath.endsWith('.sh') || relPath.endsWith('.js') || !relPath.includes('.')) {
          // Should be executable (owner-execute bit)
          expect(
            info.mode & 0o100,
            `${relPath} should be executable`,
          ).toBeGreaterThan(0)
        }
      }
    })

    // ------------------------------------------------------------------
    // 5. Git repo is initialized
    // ------------------------------------------------------------------
    it('initializes a git repo on the main branch', async () => {
      const wsDir = await initWorkspace('nova')

      expect(await exists(join(wsDir, '.git'))).toBe(true)

      // Verify the branch is set to main.
      // Use symbolic-ref which works even if there are no commits yet.
      const ref = execSync('git symbolic-ref HEAD', {
        cwd: wsDir,
        encoding: 'utf-8',
      }).trim()
      expect(ref).toBe('refs/heads/main')

      // The initial commit may fail in some CI/local environments (e.g. GPG agent).
      // If it succeeded, verify at least one commit exists.
      try {
        const commitCount = execSync('git rev-list --count HEAD', {
          cwd: wsDir,
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim()
        expect(Number(commitCount)).toBeGreaterThanOrEqual(1)
      } catch {
        // No commits — that's acceptable; init prints a warning and continues.
        // At minimum, git was initialized and branch is set.
      }
    })

    // ------------------------------------------------------------------
    // 6. Errors on non-empty directory
    // ------------------------------------------------------------------
    it('errors on non-empty directory', async () => {
      const dir = join(tmpDir, 'occupied')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'existing-file.txt'), 'hello', 'utf-8')

      // init calls process.exit(1) on error — mock it to throw instead
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`)
      })

      await expect(
        init({ name: 'nova', dir, user: 'Test User' }),
      ).rejects.toThrow('process.exit(1)')

      exitSpy.mockRestore()
    })

    // ------------------------------------------------------------------
    // 7. Errors on invalid agent name
    // ------------------------------------------------------------------
    describe('errors on invalid agent name', () => {
      const invalidNames = [
        'Has Spaces',
        'UpperCase',
        '123start',
        'special@char',
        'dot.name',
        '',
      ]

      for (const name of invalidNames) {
        it(`rejects "${name}"`, async () => {
          const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit(${code})`)
          })

          const dir = join(tmpDir, `invalid-${name.replace(/[^a-z0-9]/gi, '_') || 'empty'}`)

          await expect(
            init({ name, dir, user: 'Test User' }),
          ).rejects.toThrow('process.exit(1)')

          exitSpy.mockRestore()
        })
      }
    })

    // ------------------------------------------------------------------
    // 8. Agent-named files are correct
    // ------------------------------------------------------------------
    it('agent-named files use the actual name, not a placeholder', async () => {
      const wsDir = await initWorkspace('bolt')

      // CLI wrapper
      expect(await exists(join(wsDir, 'scripts', 'bolt'))).toBe(true)
      expect(await exists(join(wsDir, 'scripts', 'bolt.js'))).toBe(true)

      // Completion scripts
      expect(await exists(join(wsDir, 'completions', 'bolt.bash'))).toBe(true)
      expect(await exists(join(wsDir, 'completions', '_bolt'))).toBe(true)

      // Verify no leftover placeholder-named files
      for (const dir of ['scripts', 'completions']) {
        const files = await readdir(join(wsDir, dir))
        for (const file of files) {
          expect(file).not.toContain('{{')
          expect(file).not.toContain('}}')
        }
      }
    })

    // ------------------------------------------------------------------
    // 9. Engine skeleton — skills are published to the registry and added
    //    later, not baked into the scaffold
    // ------------------------------------------------------------------
    describe('engine skeleton (skills are not baked in)', () => {
      let wsDir: string

      beforeEach(async () => {
        wsDir = await initWorkspace('nova')
      })

      it('does not scaffold a baked-in skills/ tree', async () => {
        expect(await exists(join(wsDir, 'skills'))).toBe(false)
      })

      it('scripts/lib/skills.sh exists and is executable', async () => {
        const skillsShPath = join(wsDir, 'scripts', 'lib', 'skills.sh')
        expect(await exists(skillsShPath)).toBe(true)
        const info = await stat(skillsShPath)
        expect(info.mode & 0o100).toBeGreaterThan(0)
      })

      it('scripts/lib/cli-utils.js exists', async () => {
        expect(await exists(join(wsDir, 'scripts', 'lib', 'cli-utils.js'))).toBe(true)
      })

      it('does not pre-scaffold .claude/commands/ pointers (added skills emit their own)', async () => {
        // Command pointers are generated by `skills sync` once modules are added,
        // not baked into the scaffold — a fresh workspace has no skills to point at.
        expect(await exists(join(wsDir, '.claude', 'commands'))).toBe(false)
      })

      it('CLI router is slim (< 250 lines)', async () => {
        const cliPath = join(wsDir, 'scripts', 'nova.js')
        const content = await readFile(cliPath, 'utf-8')
        const lineCount = content.split('\n').length
        expect(lineCount).toBeLessThan(250)
      })
    })
  },
  30_000,
)
