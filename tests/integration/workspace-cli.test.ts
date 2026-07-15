import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { cpSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { init } from '../../src/commands/init.js'

// The registry-driven workspace CLI (scripts/<agent>.js) discovers its commands
// from installed skills/*/commands.json and lazily loads handlers. These tests
// drive it with fixture modules (tests/fixtures/cli-modules) rather than the real
// registry, so routing/lazy-load/duplicate/zero-skill behavior is exercised
// independently of any module shipping commands.json.

const AGENT = 'clibot'
const CLI = `node scripts/${AGENT}.js`
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cli-modules')

let tmpDir: string
let wsDir: string

const origXdg = process.env.XDG_CONFIG_HOME
const origSkip = process.env.STRAPER_SKIP_CLI_INSTALL

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-cli-'))
  const configDir = join(tmpDir, 'xdg-config')
  await mkdir(configDir, { recursive: true })
  process.env.XDG_CONFIG_HOME = configDir
  process.env.STRAPER_SKIP_CLI_INSTALL = '1'
  process.env.GIT_AUTHOR_EMAIL = 'test@straper.dev'
  process.env.GIT_COMMITTER_EMAIL = 'test@straper.dev'

  wsDir = join(tmpDir, AGENT)
  await init({ name: AGENT, dir: wsDir, user: 'Test User', project: 'CliProject', description: 'CLI test' })
})

afterEach(async () => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = origXdg
  if (origSkip === undefined) delete process.env.STRAPER_SKIP_CLI_INSTALL
  else process.env.STRAPER_SKIP_CLI_INSTALL = origSkip
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 })
})

/** Copy a fixture module into the workspace's skills/ directory. */
function installFixture(name: string): void {
  cpSync(join(FIXTURES, name), join(wsDir, 'skills', name), { recursive: true })
}

/** Run a command in the workspace; return stdout (throws on non-zero exit). */
function run(command: string): string {
  return execSync(command, { cwd: wsDir, encoding: 'utf-8', stdio: 'pipe', timeout: 20_000 })
}

/** Run a command that may fail; capture stdout, stderr, and status. */
function runSafe(command: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(command, { cwd: wsDir, encoding: 'utf-8', stdio: 'pipe', timeout: 20_000 })
    return { stdout, stderr: '', status: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 }
  }
}

describe('workspace CLI — registry-driven dispatcher', () => {
  // ----------------------------------------------------------------------
  // Zero-skill boot — THE regression the audit demanded.
  // ----------------------------------------------------------------------
  describe('zero-skill workspace', () => {
    it('boots and the built-ins all work with no skills installed', () => {
      // No installFixture calls, and init ships no baked-in skills.
      const help = run(`${CLI} help`)
      expect(help).toContain(`${AGENT} — workspace CLI`)
      expect(help).toContain('help')
      expect(help).toContain('completion')

      const noArgs = run(CLI)
      expect(noArgs).toContain(`${AGENT} — workspace CLI`)

      const skills = runSafe(`${CLI} skills list`)
      expect(skills.status).toBe(0)
      expect(skills.stdout + skills.stderr).toContain('No skills found')

      const bash = run(`${CLI} completion bash`)
      expect(bash).toContain(`complete -F _${AGENT}_completion ${AGENT}`)

      const zsh = run(`${CLI} completion zsh`)
      expect(zsh).toContain(`#compdef ${AGENT}`)
    })
  })

  // ----------------------------------------------------------------------
  // Discovery + routing
  // ----------------------------------------------------------------------
  describe('discovery and routing', () => {
    it('discovers a fixture module and routes its command', () => {
      installFixture('alpha')
      const output = run(`${CLI} alpha world --loud`)
      expect(output).toContain('alpha ran with: world --loud')
    })

    it('lists the discovered command in the overview', () => {
      installFixture('alpha')
      const output = run(`${CLI} help`)
      expect(output).toContain('alpha')
      expect(output).toContain('Alpha fixture command.')
    })

    it('renders per-command help from the spec', () => {
      installFixture('alpha')
      const output = run(`${CLI} help alpha`)
      expect(output).toContain('alpha — Alpha fixture command.')
      expect(output).toContain('--loud')
    })
  })

  // ----------------------------------------------------------------------
  // Lazy loading — a broken module only fails when its command runs.
  // ----------------------------------------------------------------------
  describe('lazy handler loading', () => {
    it('does not load an unrelated module when running another command', () => {
      installFixture('alpha')
      installFixture('boom') // boom-commands.js throws at require time
      // alpha runs fine — proof that boom's handler was never required.
      const output = run(`${CLI} alpha hello`)
      expect(output).toContain('alpha ran with: hello')
    })

    it('surfaces the load error only when the failing command is invoked', () => {
      installFixture('boom')
      const result = runSafe(`${CLI} boom`)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('boom module was loaded')
    })
  })

  // ----------------------------------------------------------------------
  // Duplicate command names — deterministic first-wins + warning.
  // ----------------------------------------------------------------------
  describe('duplicate commands', () => {
    it('keeps the first module (sorted) and warns', () => {
      installFixture('dupe-one')
      installFixture('dupe-two')
      // 2>&1 so the stderr warning and the stdout handler output are both captured.
      const combined = run(`${CLI} dup 2>&1`)
      expect(combined).toContain('dupe-one handled dup')
      expect(combined).toContain("command 'dup'")
      expect(combined).toContain('dupe-one')
      expect(combined).not.toContain('dupe-two handled dup')
    })
  })

  // ----------------------------------------------------------------------
  // Unknown command UX
  // ----------------------------------------------------------------------
  describe('unknown command', () => {
    it('exits non-zero and lists available commands', () => {
      installFixture('alpha')
      const result = runSafe(`${CLI} nope`)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Unknown command: nope')
      expect(result.stderr).toContain('Available commands')
    })
  })

  // ----------------------------------------------------------------------
  // Completions rendered from discovered specs
  // ----------------------------------------------------------------------
  describe('completion rendering', () => {
    it('includes discovered commands, flags, and subcommands (bash)', () => {
      installFixture('flagged')
      const output = run(`${CLI} completion bash`)
      expect(output).toContain('flagged')
      expect(output).toContain('--mode')
      expect(output).toContain('--verbose')
      expect(output).toContain('go')
    })

    it('includes discovered commands and flags (zsh)', () => {
      installFixture('flagged')
      const output = run(`${CLI} completion zsh`)
      expect(output).toContain('flagged')
      expect(output).toContain('--mode')
    })
  })
})
