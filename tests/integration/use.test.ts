import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { use } from '../../src/commands/use.js'

let tmpDir: string
let registryDir: string
let wsDir: string
const createdTemps: string[] = []

const origRegistryEnv = process.env.STRAPER_REGISTRY_DIR
const origClaudecode = process.env.CLAUDECODE
const origEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-use-test-'))
  registryDir = join(tmpDir, 'registry')
  wsDir = join(tmpDir, 'workspace')
  await mkdir(registryDir, { recursive: true })
  await mkdir(wsDir, { recursive: true })
  delete process.env.STRAPER_REGISTRY_DIR
  delete process.env.CLAUDECODE
  delete process.env.CLAUDE_CODE_ENTRYPOINT
})

afterEach(async () => {
  restoreEnv('STRAPER_REGISTRY_DIR', origRegistryEnv)
  restoreEnv('CLAUDECODE', origClaudecode)
  restoreEnv('CLAUDE_CODE_ENTRYPOINT', origEntrypoint)
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 })
  for (const dir of createdTemps.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
  vi.restoreAllMocks()
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function writeModule(name: string, opts: { deps?: string[]; extra?: Record<string, string> } = {}): Promise<void> {
  const dir = join(registryDir, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    type: 'skill',
    version: '1.0.0',
    deps: opts.deps ?? [],
    config_keys: [],
    source_commit: 'deadbeef',
    published_at: '2026-01-01T00:00:00.000Z',
  }
  await writeFile(join(dir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await writeFile(join(dir, 'CHANGELOG.md'), `# ${name} changelog\n`, 'utf-8')
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} meta\n---\n\nMeta.\n`, 'utf-8')
  await writeFile(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\n# ${name}\n\nBODY-OF-${name}\n`,
    'utf-8',
  )
  for (const [rel, content] of Object.entries(opts.extra ?? {})) {
    await writeFile(join(dir, rel), content, 'utf-8')
  }
}

function captureLog(): { text: () => string; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  })
  return { text: () => lines.join('\n'), restore: () => spy.mockRestore() }
}

/** Pull the materialized temp dir out of the printed "live under:" line and track it for cleanup. */
function tempDirFromOutput(output: string): string {
  const match = /live under:\s*(.+)$/m.exec(output)
  if (!match) throw new Error(`no temp path in output:\n${output}`)
  const tempDir = dirname(match[1].trim())
  createdTemps.push(tempDir)
  return tempDir
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await readdir(path)
    return true
  } catch {
    return false
  }
}

async function expectExit(fn: () => Promise<void>): Promise<string> {
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`)
  })
  try {
    await expect(fn()).rejects.toThrow('process.exit(1)')
    return errSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
  } finally {
    exitSpy.mockRestore()
    errSpy.mockRestore()
  }
}

// ---------------------------------------------------------------------------

describe('use — materializes and prints', () => {
  it('prints a prompt with the skill content and the temp path', async () => {
    await writeModule('alpha')
    const log = captureLog()
    await use({ module: 'alpha', dir: wsDir, registry: registryDir })
    log.restore()

    const output = log.text()
    expect(output).toContain('You have the following skill available for this session: alpha')
    expect(output).toContain('BODY-OF-alpha')

    const tempDir = tempDirFromOutput(output)
    expect(await exists(join(tempDir, 'alpha', 'alpha.md'))).toBe(true)
  })

  it('materializes transitive deps alongside and mentions them', async () => {
    await writeModule('beta')
    await writeModule('alpha', { deps: ['beta'] })
    const log = captureLog()
    await use({ module: 'alpha', dir: wsDir, registry: registryDir })
    log.restore()

    const output = log.text()
    expect(output).toContain('dependencies are also available')
    expect(output).toContain('beta')

    const tempDir = tempDirFromOutput(output)
    expect(await exists(join(tempDir, 'alpha', 'alpha.md'))).toBe(true)
    expect(await exists(join(tempDir, 'beta', 'beta.md'))).toBe(true)
  })

  it('excludes registry metadata files from the materialized temp', async () => {
    await writeModule('alpha', { extra: { 'logic.js': 'v1\n' } })
    const log = captureLog()
    await use({ module: 'alpha', dir: wsDir, registry: registryDir })
    log.restore()

    const tempDir = tempDirFromOutput(log.text())
    const moduleDir = join(tempDir, 'alpha')
    expect(await exists(join(moduleDir, 'logic.js'))).toBe(true)
    expect(await exists(join(moduleDir, 'module.json'))).toBe(false)
    expect(await exists(join(moduleDir, 'CHANGELOG.md'))).toBe(false)
    expect(await exists(join(moduleDir, 'SKILL.md'))).toBe(false)
  })

  it('installs nothing: no lock, pointers, or skills dir in the workspace', async () => {
    await writeModule('alpha')
    const log = captureLog()
    await use({ module: 'alpha', dir: wsDir, registry: registryDir })
    log.restore()
    tempDirFromOutput(log.text())

    expect(await exists(join(wsDir, 'straper.lock'))).toBe(false)
    expect(await dirExists(join(wsDir, '.claude'))).toBe(false)
    expect(await dirExists(join(wsDir, '.agents'))).toBe(false)
    expect(await dirExists(join(wsDir, 'skills'))).toBe(false)
  })
})

describe('use — agent detection', () => {
  it('omits the decorative banner when CLAUDECODE is set', async () => {
    await writeModule('alpha')
    process.env.CLAUDECODE = '1'
    const log = captureLog()
    await use({ module: 'alpha', dir: wsDir, registry: registryDir })
    log.restore()

    const output = log.text()
    expect(output).not.toContain('ephemeral trial')
    // Content is still emitted for programmatic consumption.
    expect(output).toContain('BODY-OF-alpha')
    tempDirFromOutput(output)
  })

  it('includes the banner in a plain terminal session', async () => {
    await writeModule('alpha')
    const log = captureLog()
    await use({ module: 'alpha', dir: wsDir, registry: registryDir })
    log.restore()

    expect(log.text()).toContain('ephemeral trial')
    tempDirFromOutput(log.text())
  })
})

describe('use — error handling', () => {
  it('errors cleanly on a missing module and leaves no temp dir behind', async () => {
    const stderr = await expectExit(() => use({ module: 'ghost', dir: wsDir, registry: registryDir }))
    expect(stderr).toContain('not found in registry')

    const leaked = (await listUseTemps()).filter((n) => n.startsWith('straper-use-ghost-'))
    expect(leaked).toEqual([])
  })

  it('errors on a dependency cycle', async () => {
    await writeModule('cyclic-a', { deps: ['cyclic-b'] })
    await writeModule('cyclic-b', { deps: ['cyclic-a'] })

    const stderr = await expectExit(() =>
      use({ module: 'cyclic-a', dir: wsDir, registry: registryDir }),
    )
    expect(stderr).toContain('Dependency cycle detected')
  })
})

async function listUseTemps(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) => n.startsWith('straper-use-')).sort()
}
