import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { add } from '../../src/commands/add.js'
import { init } from '../../src/commands/init.js'

const REPO_REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'registry')

// The workspace CLI statically requires every skill command module at load time,
// so booting `scripts/<agent>.js` needs the whole set vendored.
const CLI_MODULES = [
  'fd',
  'ship',
  'session',
  'session-review',
  'worktree',
  'sync-branch',
  'slack-status',
  'task',
  'memory',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const origXdg = process.env.XDG_CONFIG_HOME
const origEmail = process.env.GIT_AUTHOR_EMAIL
const origCommitterEmail = process.env.GIT_COMMITTER_EMAIL

let tmpDir: string
let configDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-e2e-'))
  configDir = join(tmpDir, 'xdg-config')
  await mkdir(configDir, { recursive: true })
  process.env.XDG_CONFIG_HOME = configDir
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
})

/** Scaffold a workspace into the temp dir. */
async function scaffold(name: string): Promise<string> {
  const dir = join(tmpDir, name)
  await init({
    name,
    dir,
    user: 'Test User',
    project: 'TestProject',
    description: 'E2E test workspace',
  })
  return dir
}

/** Check if a CLI tool is available. */
function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** execSync with common options for running scripts inside a workspace. */
function runInWorkspace(
  command: string,
  cwd: string,
): string {
  return execSync(command, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
      // Prevent session-start.sh from looking at real gh auth
      GH_TOKEN: '',
    },
    timeout: 20_000,
  })
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

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe(
  'workspace boot — e2e',
  () => {
    // ------------------------------------------------------------------
    // 1. Task CLI works
    // ------------------------------------------------------------------
    // Exercises skills/task/task.js, vendored from the registry via `add`.
    describe('task CLI', () => {
      it('creates a task file with correct schema', async () => {
        const wsDir = await scaffold('taskbot')
        await add({ modules: ['task'], dir: wsDir, registry: REPO_REGISTRY })

        const output = runInWorkspace(
          'node skills/task/task.js create "Test task"',
          wsDir,
        )

        expect(output).toContain('Created TASK-001')

        const taskPath = join(wsDir, 'tasks', 'TASK-001.json')
        expect(await exists(taskPath)).toBe(true)

        const { readFile } = await import('node:fs/promises')
        const raw = await readFile(taskPath, 'utf-8')
        const task = JSON.parse(raw)

        expect(task.id).toBe('TASK-001')
        expect(task.title).toBe('Test task')
        expect(task.status).toBe('backlog')
        expect(task.priority).toBe('medium')
        expect(Array.isArray(task.prs)).toBe(true)
        expect(Array.isArray(task.blockers)).toBe(true)
        expect(Array.isArray(task.log)).toBe(true)
        expect(typeof task.created_at).toBe('string')
        expect(typeof task.updated_at).toBe('string')
      })

      it('creates sequential task IDs', async () => {
        const wsDir = await scaffold('seqbot')
        await add({ modules: ['task'], dir: wsDir, registry: REPO_REGISTRY })

        runInWorkspace('node skills/task/task.js create "First task"', wsDir)
        runInWorkspace('node skills/task/task.js create "Second task"', wsDir)

        expect(await exists(join(wsDir, 'tasks', 'TASK-001.json'))).toBe(true)
        expect(await exists(join(wsDir, 'tasks', 'TASK-002.json'))).toBe(true)
      })
    })

    // ------------------------------------------------------------------
    // 2. Validate tasks passes on clean workspace
    // ------------------------------------------------------------------
    // Exercises skills/task/validate.js, vendored from the registry via `add`.
    describe('validate-tasks', () => {
      it('passes on a workspace with a valid task', async () => {
        const wsDir = await scaffold('valbot')
        await add({ modules: ['task'], dir: wsDir, registry: REPO_REGISTRY })

        // Create a valid task first
        runInWorkspace('node skills/task/task.js create "Valid task"', wsDir)

        // Run validation
        const output = runInWorkspace('node skills/task/validate.js', wsDir)
        expect(output).toContain('Validated 1 task file(s): OK')
      })

      it('passes on a workspace with no tasks', async () => {
        const wsDir = await scaffold('emptybot')
        await add({ modules: ['task'], dir: wsDir, registry: REPO_REGISTRY })

        const output = runInWorkspace('node skills/task/validate.js', wsDir)
        expect(output).toContain('No task files found')
      })
    })

    // ------------------------------------------------------------------
    // 3. Session start script runs
    // ------------------------------------------------------------------
    // session-start.sh runs `./scripts/validate-tasks.sh` (the `task` module) and
    // validates each vendored skill's `depends_on`. Vendoring `task` supplies the
    // validator and resolves the boot's task-file check.
    describe('session-start.sh', () => {
      // session-start.sh's preflight hard-requires all four before doing anything.
      const requiredTools = ['jq', 'node', 'git', 'gh']

      it.skipIf(!requiredTools.every(hasCommand))(
        'runs successfully in a clean workspace',
        async (ctx) => {
          const wsDir = await scaffold('bootbot')
          await add({ modules: ['task'], dir: wsDir, registry: REPO_REGISTRY })

          // session-start.sh needs gh but not gh *auth*: sync-pr-status.sh is
          // guarded with `|| echo "PR sync skipped."` and cleanup runs --dry-run.
          // If it still fails on gh, skip loudly rather than pass with no assertions.
          let output: string
          try {
            output = runInWorkspace('bash scripts/session-start.sh', wsDir)
          } catch (err) {
            const stderr = (err as { stderr?: string }).stderr ?? ''
            if (stderr.includes('gh') || stderr.includes('Missing required tools')) {
              ctx.skip()
              return
            }
            throw err
          }

          expect(output).toContain('Boot')
          expect(output).toContain('All dependencies found')
          expect(output).toContain('Loading memory context')
        },
      )

      it.skipIf(!requiredTools.every(hasCommand))(
        'session-start.sh includes skills validation step',
        async (ctx) => {
          const wsDir = await scaffold('skillboot')
          await add({ modules: ['task'], dir: wsDir, registry: REPO_REGISTRY })

          let output: string
          try {
            output = runInWorkspace('bash scripts/session-start.sh', wsDir)
          } catch (err) {
            const stderr = (err as { stderr?: string }).stderr ?? ''
            if (stderr.includes('gh') || stderr.includes('Missing required tools')) {
              ctx.skip()
              return
            }
            throw err
          }

          expect(output).toContain('Validating skills')
          expect(output).toMatch(/Validated \d+ skill\(s\): OK/)
        },
      )
    })

    // ------------------------------------------------------------------
    // 4. Skills framework runtime
    // ------------------------------------------------------------------
    describe('skills framework runtime', () => {
      it('scripts/lib/skills.sh is sourceable (valid bash)', async () => {
        const wsDir = await scaffold('syntaxbot')
        // bash -n does a syntax check without executing
        runInWorkspace('bash -n scripts/lib/skills.sh', wsDir)
      })

      it('does not scaffold a baked-in skills/ tree', async () => {
        const wsDir = await scaffold('nobakedskills')
        expect(await exists(join(wsDir, 'skills'))).toBe(false)
      })

      // Re-enabled by `straper add`: a scaffolded workspace has no skills until a
      // module is vendored in. After `add session-review`, the skill source, the
      // consumer SKILL.md pointer, and the lock entry all land, and the skill
      // framework (scripts/lib/skills.sh) enumerates the vendored skill.
      it('add vendors a registry skill that the skill framework enumerates', async () => {
        const wsDir = await scaffold('addbot')
        await add({ modules: ['session-review'], dir: wsDir, registry: REPO_REGISTRY })

        expect(await exists(join(wsDir, 'skills', 'session-review', 'session-review.md'))).toBe(true)
        expect(
          await exists(join(wsDir, '.claude', 'skills', 'session-review', 'SKILL.md')),
        ).toBe(true)

        const listed = runInWorkspace(
          "bash -c 'source scripts/lib/skills.sh && skills_list'",
          wsDir,
        ).trim()
        expect(listed.split('\n')).toContain('session-review')

        const lock = JSON.parse(await readFile(join(wsDir, 'straper.lock'), 'utf-8'))
        expect(Object.keys(lock.modules)).toContain('session-review')
      })

      // The workspace CLI statically requires the fd/ship/session/session-review/
      // worktree/sync-branch/slack-status command modules at load time, so the
      // whole set is vendored before the CLI can boot.
      it('CLI with no arguments exits 0 and shows usage on stderr', async () => {
        const wsDir = await scaffold('helpbot')
        await add({ modules: CLI_MODULES, dir: wsDir, registry: REPO_REGISTRY })
        // The CLI prints usage to stderr with no args and exits 0.
        // execSync returns stdout; stderr is captured separately.
        const result = execSync('node scripts/helpbot.js 2>&1', {
          cwd: wsDir,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 20_000,
        })
        expect(result).toContain('Usage:')
        expect(result).toContain('fd-new')
        expect(result).toContain('ship')
        expect(result).toContain('skills')
      })

      it('CLI skills list works', async () => {
        const wsDir = await scaffold('listbot')
        await add({ modules: CLI_MODULES, dir: wsDir, registry: REPO_REGISTRY })
        const output = runInWorkspace('node scripts/listbot.js skills list', wsDir)
        // Should list the skills with their names
        expect(output).toContain('fd')
        expect(output).toContain('ship')
        expect(output).toContain('task')
      })
    })
  },
  30_000,
)
