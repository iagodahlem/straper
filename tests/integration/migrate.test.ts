import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrate } from '../../src/commands/migrate.js'

let tmpDir: string

const origXdg = process.env.XDG_CONFIG_HOME
const origAuthorName = process.env.GIT_AUTHOR_NAME
const origCommitterName = process.env.GIT_COMMITTER_NAME
const origEmail = process.env.GIT_AUTHOR_EMAIL
const origCommitterEmail = process.env.GIT_COMMITTER_EMAIL

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-migrate-test-'))
  process.env.XDG_CONFIG_HOME = join(tmpDir, 'xdg-config')
  process.env.GIT_AUTHOR_NAME = 'Test User'
  process.env.GIT_COMMITTER_NAME = 'Test User'
  process.env.GIT_AUTHOR_EMAIL = 'test@straper.dev'
  process.env.GIT_COMMITTER_EMAIL = 'test@straper.dev'
})

afterEach(async () => {
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
  vi.restoreAllMocks()
})

describe('straper migrate', () => {
  it('exits with a registry-model guard message instead of migrating', async () => {
    const workspaceDir = await createOldWorkspace('gaia')
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })

    await expect(migrate({ dir: workspaceDir, dryRun: true })).rejects.toThrow('process.exit(1)')

    const errOutput = errSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(errOutput).toContain('reworked for the registry model')
    expect(errOutput).toContain('straper init')

    // Guard fires before any migration side effects.
    expect(readCurrentBranch(workspaceDir)).toBe('main')
    expect(readGitStatus(workspaceDir)).toBe('')
    expect(await exists(join(workspaceDir, 'skills'))).toBe(false)

    const bootContent = await readFile(join(workspaceDir, 'BOOT.md'), 'utf-8')
    expect(bootContent).not.toContain('Validate skills')

    exitSpy.mockRestore()
  })
})

async function createOldWorkspace(agentName: string): Promise<string> {
  const workspaceDir = join(tmpDir, agentName)

  await mkdir(join(workspaceDir, 'scripts', 'lib'), { recursive: true })
  await mkdir(join(workspaceDir, '.claude', 'commands'), { recursive: true })

  const monolith = Array.from(
    { length: 550 },
    (_, index) => `function line${index}() { return ${index}; }`,
  ).join('\n')

  await writeFile(
    join(workspaceDir, 'preferences.json'),
    JSON.stringify({ agent_name: agentName, agent_display_name: 'Gaia' }, null, 2) + '\n',
    'utf-8',
  )
  await writeFile(join(workspaceDir, 'TOOLS.md'), oldTools(agentName), 'utf-8')
  await writeFile(join(workspaceDir, 'BOOT.md'), oldBoot(), 'utf-8')
  await writeFile(join(workspaceDir, 'scripts', `${agentName}.js`), `${monolith}\n`, 'utf-8')
  await writeFile(join(workspaceDir, 'scripts', 'auto-commit.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  await writeFile(join(workspaceDir, 'scripts', 'task.js'), 'console.log("task")\n', 'utf-8')
  await writeFile(
    join(workspaceDir, 'scripts', 'validate-tasks.js'),
    'console.log("validate")\n',
    'utf-8',
  )
  await writeFile(
    join(workspaceDir, 'scripts', 'session-start.sh'),
    '#!/usr/bin/env bash\necho old start\n',
    'utf-8',
  )
  await writeFile(
    join(workspaceDir, 'scripts', 'session-end.sh'),
    '#!/usr/bin/env bash\necho old end\n',
    'utf-8',
  )
  await writeFile(join(workspaceDir, 'scripts', 'task'), '#!/usr/bin/env bash\necho task\n', 'utf-8')
  await writeFile(
    join(workspaceDir, 'scripts', 'validate-tasks.sh'),
    '#!/usr/bin/env bash\necho validate\n',
    'utf-8',
  )
  await writeFile(
    join(workspaceDir, 'scripts', 'lib', 'designs.js'),
    'export function parseDesign() {}\n',
    'utf-8',
  )
  await writeFile(
    join(workspaceDir, '.claude', 'commands', 'fd.md'),
    '# Old command content\n\nThis is not a thin pointer.\n',
    'utf-8',
  )

  execSync('git init --initial-branch=main', { cwd: workspaceDir, stdio: 'pipe' })
  execSync('git add -A', { cwd: workspaceDir, stdio: 'pipe' })
  execSync('git -c commit.gpgSign=false commit -m "feat: old workspace"', {
    cwd: workspaceDir,
    stdio: 'pipe',
    env: process.env,
  })

  return workspaceDir
}

function oldTools(agentName: string): string {
  return `# Tools

## Workflow Skills

### CLI Commands

\`\`\`bash
./scripts/${agentName} fd-status
\`\`\`
`
}

function oldBoot(): string {
  return `# Boot

## 1. Load context

- Read MEMORY.md

## 2. Check workspace health

- Run cleanup

## 3. Greet

- Summarize status
`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function readCurrentBranch(workspaceDir: string): string {
  return execSync('git branch --show-current', {
    cwd: workspaceDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim()
}

function readGitStatus(workspaceDir: string): string {
  return execSync('git status --short', {
    cwd: workspaceDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim()
}
