import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { add } from '../../src/commands/add.js'
import { init } from '../../src/commands/init.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_NAME = 'smokebot'

const REPO_REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'registry')

// The workspace CLI statically requires every skill command module at load time,
// so the whole set is vendored up front — a partial set leaves the CLI unloadable.
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

// session-start.sh hard-requires all of these in its dependency preflight.
const requiredTools = ['jq', 'node', 'git', 'gh']

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

let tmpDir: string
let configDir: string
let wsDir: string

const origXdg = process.env.XDG_CONFIG_HOME
const origAuthorName = process.env.GIT_AUTHOR_NAME
const origCommitterName = process.env.GIT_COMMITTER_NAME
const origEmail = process.env.GIT_AUTHOR_EMAIL
const origCommitterEmail = process.env.GIT_COMMITTER_EMAIL

/** Run a command inside the scaffolded workspace, returning stdout. */
function run(command: string): string {
  return execSync(command, {
    cwd: wsDir,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GH_TOKEN: '',
    },
    timeout: 20_000,
  })
}

/** Run a command that may fail; return { stdout, stderr, status }. */
function runSafe(command: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(command, {
      cwd: wsDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: {
        ...process.env,
        GH_TOKEN: '',
      },
      timeout: 20_000,
    })
    return { stdout, stderr: '', status: 0 }
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      status: error.status ?? 1,
    }
  }
}

function gitCommitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'test@straper.dev',
    GIT_COMMITTER_EMAIL: 'test@straper.dev',
  }
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
// Smoke Test Suite
// ---------------------------------------------------------------------------

// Drives the workspace CLI (`scripts/<agent>.js`), which statically requires
// the fd, ship, session, session-review, worktree, sync-branch, and slack-status
// skill command modules at load time, plus `scripts/task` and the session
// lifecycle scripts. The scaffold ships no baked-in skills — `straper add`
// vendors the modules from the registry in beforeAll so the CLI can boot.
describe(
  'smoke test — scaffolded workspace end-to-end',
  () => {
    // Set up a single workspace for all tests in this suite
    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'straper-smoke-'))
      configDir = join(tmpDir, 'xdg-config')
      await mkdir(configDir, { recursive: true })
      process.env.XDG_CONFIG_HOME = configDir
      process.env.GIT_AUTHOR_NAME = 'Test User'
      process.env.GIT_COMMITTER_NAME = 'Test User'
      process.env.GIT_AUTHOR_EMAIL = 'test@straper.dev'
      process.env.GIT_COMMITTER_EMAIL = 'test@straper.dev'

      wsDir = join(tmpDir, AGENT_NAME)
      await init({
        name: AGENT_NAME,
        dir: wsDir,
        user: 'Test User',
        project: 'SmokeProject',
        description: 'Comprehensive smoke test workspace',
      })
      await add({ modules: CLI_MODULES, dir: wsDir, registry: REPO_REGISTRY })
    })

    afterAll(async () => {
      if (origXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = origXdg
      }
      if (origAuthorName === undefined) {
        delete process.env.GIT_AUTHOR_NAME
      } else {
        process.env.GIT_AUTHOR_NAME = origAuthorName
      }
      if (origCommitterName === undefined) {
        delete process.env.GIT_COMMITTER_NAME
      } else {
        process.env.GIT_COMMITTER_NAME = origCommitterName
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

    // ----------------------------------------------------------------
    // 1. Session start (boot)
    // ----------------------------------------------------------------
    describe('session-start', () => {
      it.skipIf(!requiredTools.every(hasCommand))('runs session-start.sh successfully', () => {
        const output = run('bash scripts/session-start.sh')
        expect(output).toContain('Boot')
        expect(output).toContain('All dependencies found')
        expect(output).toContain('Validating skills')
        expect(output).toMatch(/Validated \d+ skill\(s\): OK/)
        expect(output).toContain('Loading memory context')
      })
    })

    // ----------------------------------------------------------------
    // 2. Feature design commands
    // ----------------------------------------------------------------
    describe('fd-new', () => {
      it('creates a feature design and updates the index', async () => {
        const output = run(
          `node scripts/${AGENT_NAME}.js fd-new "Test Feature" --effort small --priority medium`,
        )
        expect(output).toContain('Created designs/FD-001.md')
        expect(output).toContain('Updated designs/INDEX.md')

        expect(await exists(join(wsDir, 'designs', 'FD-001.md'))).toBe(true)

        const indexContent = await readFile(join(wsDir, 'designs', 'INDEX.md'), 'utf-8')
        expect(indexContent).toContain('FD-001')
        expect(indexContent).toContain('Test Feature')
      })
    })

    describe('fd-status', () => {
      it('lists FD-001 in the status table', () => {
        const output = run(`node scripts/${AGENT_NAME}.js fd-status`)
        expect(output).toContain('FD-001')
        expect(output).toContain('Test Feature')
      })
    })

    describe('fd-work-prompt', () => {
      it('outputs a work prompt for a sub-item', async () => {
        // First, flesh out FD-001 with real sub-items so fd-work-prompt can find them
        const fdPath = join(wsDir, 'designs', 'FD-001.md')
        let fdContent = await readFile(fdPath, 'utf-8')

        // Replace the placeholder sub-items table with real entries
        fdContent = fdContent.replace(
          '| A1   |      |            | todo   |\n| A2   |      |            | todo   |',
          '| A1   | Implement core logic |            | todo   |\n| A2   | Add tests            | A1         | todo   |',
        )
        await writeFile(fdPath, fdContent, 'utf-8')

        // Commit so git is clean
        execSync('git add -A && git -c commit.gpgSign=false commit -m "flesh out FD-001"', {
          cwd: wsDir,
          stdio: 'pipe',
          env: gitCommitEnv(),
        })

        const output = run(`node scripts/${AGENT_NAME}.js fd-work-prompt FD-001 A1`)
        expect(output).toContain('worker agent implementing')
        expect(output).toContain('FD-001')
        expect(output).toContain('A1')
        // The published fd prompt uses generic wording and keeps workspace-relative
        // `./scripts/malvin` paths; it substitutes no agent name. Assert it stays generic.
        expect(output).not.toContain('Malvin workspace')
      })
    })

    describe('fd-new-prompt', () => {
      // The published fd prompt uses generic wording (no agent-name substitution) and
      // keeps workspace-relative `./scripts/malvin` paths. Assert the functional content
      // renders and that no publisher identity ("Malvin workspace") leaks through.
      it('outputs a generic design prompt with the feature title', () => {
        const output = run(
          `node scripts/${AGENT_NAME}.js fd-new-prompt "Another Feature"`,
        )
        expect(output).toContain('Another Feature')
        expect(output).toContain('feature design')
        expect(output).not.toContain('Malvin workspace')
      })
    })

    describe('fd-close', () => {
      it('archives the feature design', async () => {
        const output = run(`node scripts/${AGENT_NAME}.js fd-close FD-001 --force`)
        expect(output).toContain('Archived')
        expect(output).toContain('designs/archive/FD-001.md')

        expect(await exists(join(wsDir, 'designs', 'archive', 'FD-001.md'))).toBe(true)
        expect(await exists(join(wsDir, 'designs', 'FD-001.md'))).toBe(false)
      })
    })

    // ----------------------------------------------------------------
    // 3. Prompt commands (ship, session-review)
    // ----------------------------------------------------------------
    describe('ship-prompt', () => {
      it('outputs a ship prompt with agent name substituted', () => {
        const output = run(
          `node scripts/${AGENT_NAME}.js ship-prompt some-worktree`,
        )
        expect(output).toContain(AGENT_NAME)
        expect(output).toContain('some-worktree')
      })
    })

    describe('session-review-prompt', () => {
      it('outputs a session review prompt with agent name substituted', () => {
        const output = run(
          `node scripts/${AGENT_NAME}.js session-review-prompt`,
        )
        expect(output).toContain(AGENT_NAME)
      })
    })

    describe('session-review', () => {
      it('outputs a review with active tasks and designs info', () => {
        const output = run(`node scripts/${AGENT_NAME}.js session-review`)
        expect(output).toContain('Session Review')
        expect(output).toContain('Active tasks')
        expect(output).toContain('Active feature designs')
      })
    })

    // ----------------------------------------------------------------
    // 4. Skills list
    // ----------------------------------------------------------------
    describe('skills list', () => {
      it('lists skill names', () => {
        const output = run(`node scripts/${AGENT_NAME}.js skills list`)
        expect(output).toContain('fd')
        expect(output).toContain('ship')
        expect(output).toContain('task')
      })
    })

    // ----------------------------------------------------------------
    // 5. Completion
    // ----------------------------------------------------------------
    describe('completion', () => {
      it('outputs bash completion script', () => {
        const output = run(`node scripts/${AGENT_NAME}.js completion bash`)
        expect(output.length).toBeGreaterThan(0)
        // Bash completions typically contain function definitions or complete commands
        expect(output).toContain(AGENT_NAME)
      })

      it('outputs zsh completion script', () => {
        const output = run(`node scripts/${AGENT_NAME}.js completion zsh`)
        expect(output.length).toBeGreaterThan(0)
        expect(output).toContain(AGENT_NAME)
      })
    })

    // ----------------------------------------------------------------
    // 6. Worktree --dry-run
    // ----------------------------------------------------------------
    describe('worktree --dry-run', () => {
      it('outputs the dry-run plan for a worktree', async () => {
        // Create a dummy git repo in repos/
        const repoPath = join(wsDir, 'repos', 'test-repo')
        await mkdir(repoPath, { recursive: true })
        execSync('git init --initial-branch=main', { cwd: repoPath, stdio: 'pipe' })
        execSync('git -c commit.gpgSign=false commit --allow-empty -m "init"', {
          cwd: repoPath,
          stdio: 'pipe',
          env: gitCommitEnv(),
        })

        const output = run(
          `node scripts/${AGENT_NAME}.js worktree test-repo alice/my-branch --dry-run`,
        )
        expect(output).toContain('Worktree path:')
        expect(output).toContain('Branch: alice/my-branch')
        expect(output).toContain('Command:')
      })
    })

    // ----------------------------------------------------------------
    // 7. Ship --dry-run
    // ----------------------------------------------------------------
    describe('ship --dry-run', () => {
      it('outputs a dry-run plan or expected error', async () => {
        // Create a worktree directory with a git repo to satisfy existence check
        const worktreePath = join(wsDir, 'workspaces', 'test-repo--alice--ship-test')
        await mkdir(worktreePath, { recursive: true })
        execSync('git init --initial-branch=main', { cwd: worktreePath, stdio: 'pipe' })
        execSync('git -c commit.gpgSign=false commit --allow-empty -m "init"', {
          cwd: worktreePath,
          stdio: 'pipe',
          env: gitCommitEnv(),
        })

        const result = runSafe(
          `node scripts/${AGENT_NAME}.js ship test-repo--alice--ship-test --dry-run`,
        )

        // Ship --dry-run should either show the plan or fail due to verify.sh missing context.
        // Either outcome is valid — the important thing is the CLI parsed and ran.
        const combined = result.stdout + result.stderr
        expect(combined).toMatch(/Would run|verify|Worktree|Branch/i)
      })
    })

    // ----------------------------------------------------------------
    // 8. Sync-branch --dry-run
    // ----------------------------------------------------------------
    describe('sync-branch --dry-run', () => {
      it('outputs a dry-run plan for sync-branch', async () => {
        // Reuse the worktree from ship test
        const worktreePath = join(wsDir, 'workspaces', 'test-repo--alice--ship-test')
        const worktreeExists = await exists(worktreePath)
        if (!worktreeExists) {
          await mkdir(worktreePath, { recursive: true })
          execSync('git init --initial-branch=main', { cwd: worktreePath, stdio: 'pipe' })
          execSync('git -c commit.gpgSign=false commit --allow-empty -m "init"', {
            cwd: worktreePath,
            stdio: 'pipe',
            env: gitCommitEnv(),
          })
        }

        const output = run(
          `node scripts/${AGENT_NAME}.js sync-branch test-repo--alice--ship-test --dry-run`,
        )
        expect(output).toContain('Would fetch origin')
        expect(output).toContain('Would rebase')
      })
    })

    // ----------------------------------------------------------------
    // 9. Task operations
    // ----------------------------------------------------------------
    describe('task operations', () => {
      it('creates a task via scripts/task', async () => {
        const output = run('bash scripts/task create "Smoke test task"')
        expect(output).toContain('Created TASK-001')

        const taskPath = join(wsDir, 'tasks', 'TASK-001.json')
        expect(await exists(taskPath)).toBe(true)

        const raw = await readFile(taskPath, 'utf-8')
        const task = JSON.parse(raw)
        expect(task.id).toBe('TASK-001')
        expect(task.title).toBe('Smoke test task')
        expect(task.status).toBe('backlog')
      })
    })

    // ----------------------------------------------------------------
    // 10. Session end
    // ----------------------------------------------------------------
    describe('session-end', () => {
      it('runs session-end.sh without hard-crashing', async () => {
        // session-end expects a log entry for today on active tasks.
        // Add a log entry to the task we created.
        run('bash scripts/task log TASK-001 "Smoke test log entry"')

        // Commit workspace changes so auto-commit in session-end doesn't fail weirdly
        execSync('git add -A && git -c commit.gpgSign=false commit -m "pre session-end" --allow-empty', {
          cwd: wsDir,
          stdio: 'pipe',
          env: gitCommitEnv(),
        })

        const result = runSafe('bash scripts/session-end.sh')
        const combined = result.stdout + result.stderr

        // Session-end may fail validation checks (e.g., missing memory content)
        // but should not hard-crash (segfault, syntax error, etc.)
        // It should always produce recognizable output from its phases.
        expect(combined).toContain('Session End')
        expect(combined).toMatch(/Auto-committing|Validating task|Checking task|Checking memory/i)
      })
    })
  },
  60_000,
)
