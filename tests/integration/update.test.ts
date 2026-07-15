import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { add } from '../../src/commands/add.js'
import { adoptWorkspace } from '../../src/commands/adopt.js'
import { doctor } from '../../src/commands/doctor.js'
import { update } from '../../src/commands/update.js'

let tmpDir: string
let registryDir: string
let wsDir: string

const origRegistryEnv = process.env.STRAPER_REGISTRY_DIR

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-update-test-'))
  registryDir = join(tmpDir, 'registry')
  wsDir = join(tmpDir, 'workspace')
  await mkdir(registryDir, { recursive: true })
  await mkdir(wsDir, { recursive: true })
  delete process.env.STRAPER_REGISTRY_DIR
})

afterEach(async () => {
  if (origRegistryEnv === undefined) {
    delete process.env.STRAPER_REGISTRY_DIR
  } else {
    process.env.STRAPER_REGISTRY_DIR = origRegistryEnv
  }
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 })
  vi.restoreAllMocks()
})

interface ModuleOpts {
  version?: string
  main?: string
  extra?: Record<string, string>
}

function defaultMain(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} does a thing\nversion: 1\n---\n\n# ${name}\n\nBody.\n`
}

async function writeModule(name: string, opts: ModuleOpts = {}): Promise<void> {
  const dir = join(registryDir, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    type: 'skill',
    version: opts.version ?? '1.0.0',
    deps: [],
    config_keys: [],
    source_commit: `commit-${opts.version ?? '1.0.0'}`,
    published_at: '2026-01-01T00:00:00.000Z',
  }
  await writeFile(join(dir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await writeFile(join(dir, 'CHANGELOG.md'), `# ${name} changelog\n`, 'utf-8')
  await writeFile(join(dir, `${name}.md`), opts.main ?? defaultMain(name), 'utf-8')
  for (const [rel, content] of Object.entries(opts.extra ?? {})) {
    const p = join(dir, rel)
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(p, content, 'utf-8')
  }
}

async function readWorking(name: string, rel: string): Promise<string> {
  return readFile(join(wsDir, 'skills', name, rel), 'utf-8')
}

async function editWorking(name: string, rel: string, content: string): Promise<void> {
  await writeFile(join(wsDir, 'skills', name, rel), content, 'utf-8')
}

async function readLock(): Promise<{
  lockfileVersion: number
  modules: Record<
    string,
    { version: string; files: Array<{ path: string; sha256: string }> }
  >
}> {
  return JSON.parse(await readFile(join(wsDir, 'straper.lock'), 'utf-8'))
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

function captureLog(): { lines: () => string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  })
  return { lines: () => lines, restore: () => spy.mockRestore() }
}

/** Run fn expecting a clean process.exit(1); returns captured stderr text. */
async function expectExit(fn: () => Promise<void>): Promise<string> {
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`)
  })
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await expect(fn()).rejects.toThrow('process.exit(1)')
    return errSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
  } finally {
    exitSpy.mockRestore()
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
}

async function install(name: string): Promise<void> {
  const log = captureLog()
  await add({ modules: [name], dir: wsDir, registry: registryDir })
  log.restore()
}

function mainWith(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nversion: 1\n---\n\n# ${name}\n\nBody.\n`
}

function pointerPath(name: string): string {
  return join(wsDir, '.claude', 'skills', name, 'SKILL.md')
}

async function readPointer(name: string): Promise<string> {
  return readFile(pointerPath(name), 'utf-8')
}

async function writePointer(name: string, content: string): Promise<void> {
  await mkdir(join(wsDir, '.claude', 'skills', name), { recursive: true })
  await writeFile(pointerPath(name), content, 'utf-8')
}

/** Copy registry source into skills/<name>/ byte-exact (minus metadata). */
async function materializeSkill(name: string): Promise<void> {
  const src = join(registryDir, name)
  const dest = join(wsDir, 'skills', name)
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (['module.json', 'CHANGELOG.md', 'SKILL.md'].includes(entry.name)) continue
    await writeFile(join(dest, entry.name), await readFile(join(src, entry.name)))
  }
}

// ---------------------------------------------------------------------------

describe('update — no-op when unchanged', () => {
  it('reports up to date and leaves the lock version untouched', async () => {
    await writeModule('alpha', { version: '1.0.0' })
    await install('alpha')

    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(log.lines().some((l) => l.includes('up to date'))).toBe(true)
    expect((await readLock()).modules['alpha'].version).toBe('1.0.0')
  })
})

describe('update — registry advanced, clean local', () => {
  it('takes the new registry bytes and bumps the lock version', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'v1\n' } })
    await install('alpha')

    await writeModule('alpha', { version: '2.0.0', extra: { 'logic.js': 'v2\n' } })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await readWorking('alpha', 'logic.js')).toBe('v2\n')
    expect((await readLock()).modules['alpha'].version).toBe('2.0.0')
  })
})

describe('update — local edit, registry unchanged for that file', () => {
  it('preserves the local edit while advancing the version', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'v1\n' } })
    await install('alpha')
    await editWorking('alpha', 'logic.js', 'my local edit\n')

    // Bump version by changing only the main md; logic.js stays identical upstream.
    await writeModule('alpha', {
      version: '2.0.0',
      main: defaultMain('alpha') + '\nExtra line.\n',
      extra: { 'logic.js': 'v1\n' },
    })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await readWorking('alpha', 'logic.js')).toBe('my local edit\n')
    expect((await readLock()).modules['alpha'].version).toBe('2.0.0')
  })
})

describe('update — clean 3-way merge', () => {
  it('merges non-overlapping local and registry edits without conflict', async () => {
    const base = 'line1\nline2\nline3\nline4\nline5\n'
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': base } })
    await install('alpha')
    await editWorking('alpha', 'logic.js', 'LOCAL1\nline2\nline3\nline4\nline5\n')

    await writeModule('alpha', {
      version: '2.0.0',
      extra: { 'logic.js': 'line1\nline2\nline3\nline4\nREG5\n' },
    })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    const merged = await readWorking('alpha', 'logic.js')
    expect(merged).toContain('LOCAL1')
    expect(merged).toContain('REG5')
    expect(merged).not.toContain('<<<<<<<')
  })
})

describe('update — true conflict', () => {
  it('writes conflict markers and exits non-zero', async () => {
    const base = 'top\nMIDDLE\nbottom\n'
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': base } })
    await install('alpha')
    await editWorking('alpha', 'logic.js', 'top\nLOCAL-MIDDLE\nbottom\n')

    await writeModule('alpha', {
      version: '2.0.0',
      extra: { 'logic.js': 'top\nREGISTRY-MIDDLE\nbottom\n' },
    })

    await expectExit(() => update({ modules: ['alpha'], dir: wsDir, registry: registryDir }))

    const conflicted = await readWorking('alpha', 'logic.js')
    expect(conflicted).toContain('<<<<<<< local')
    expect(conflicted).toContain('>>>>>>> registry')
    // The lock still advances so re-running is idempotent.
    expect((await readLock()).modules['alpha'].version).toBe('2.0.0')
  })
})

describe('update — files added and removed upstream', () => {
  it('adds a new upstream file into the working tree and lock', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'a.js': 'a\n' } })
    await install('alpha')

    await writeModule('alpha', { version: '2.0.0', extra: { 'a.js': 'a\n', 'b.js': 'b\n' } })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await readWorking('alpha', 'b.js')).toBe('b\n')
    const paths = (await readLock()).modules['alpha'].files.map((f) => f.path)
    expect(paths).toContain('skills/alpha/b.js')
  })

  it('removes an unmodified file dropped upstream from the working tree and lock', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'a.js': 'a\n', 'b.js': 'b\n' } })
    await install('alpha')

    await writeModule('alpha', { version: '2.0.0', extra: { 'a.js': 'a\n' } })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await exists(join(wsDir, 'skills', 'alpha', 'b.js'))).toBe(false)
    const paths = (await readLock()).modules['alpha'].files.map((f) => f.path)
    expect(paths).not.toContain('skills/alpha/b.js')
  })

  it('keeps a locally-edited file dropped upstream and prints a notice', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'a.js': 'a\n', 'b.js': 'b\n' } })
    await install('alpha')
    await editWorking('alpha', 'b.js', 'my edits\n')

    await writeModule('alpha', { version: '2.0.0', extra: { 'a.js': 'a\n' } })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await readWorking('alpha', 'b.js')).toBe('my edits\n')
    expect(
      log.lines().some((l) => l.includes('kept locally-edited file removed upstream')),
    ).toBe(true)
  })
})

describe('update — missing base store (pre-base-store install)', () => {
  it('skips with an error when working files differ from the registry', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'v1\n' } })
    await install('alpha')
    await editWorking('alpha', 'logic.js', 'my local edit\n')
    await rm(join(wsDir, '.straper', 'base', 'alpha'), { recursive: true, force: true })

    await writeModule('alpha', { version: '2.0.0', extra: { 'logic.js': 'v2\n' } })
    const stderr = await expectExit(() =>
      update({ modules: ['alpha'], dir: wsDir, registry: registryDir }),
    )

    expect(stderr).toContain('no base store')
    // Local edit is untouched and the lock does not advance.
    expect(await readWorking('alpha', 'logic.js')).toBe('my local edit\n')
    expect((await readLock()).modules['alpha'].version).toBe('1.0.0')
  })

  it('heals the base store when working files match the registry', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'v1\n' } })
    await install('alpha')
    await rm(join(wsDir, '.straper', 'base', 'alpha'), { recursive: true, force: true })

    // Version-only bump: file bytes unchanged, so the working tree matches the registry.
    await writeModule('alpha', { version: '2.0.0', extra: { 'logic.js': 'v1\n' } })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect((await readLock()).modules['alpha'].version).toBe('2.0.0')
    expect(await exists(join(wsDir, '.straper', 'base', 'alpha', 'logic.js'))).toBe(true)
  })
})

describe('update — multi-module', () => {
  it('updates every locked module when no names are given', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'a1\n' } })
    await writeModule('beta', { version: '1.0.0', extra: { 'logic.js': 'b1\n' } })
    await install('alpha')
    await install('beta')

    await writeModule('alpha', { version: '2.0.0', extra: { 'logic.js': 'a2\n' } })
    await writeModule('beta', { version: '2.0.0', extra: { 'logic.js': 'b2\n' } })
    const log = captureLog()
    await update({ modules: [], dir: wsDir, registry: registryDir })
    log.restore()

    const lock = await readLock()
    expect(lock.modules['alpha'].version).toBe('2.0.0')
    expect(lock.modules['beta'].version).toBe('2.0.0')
    expect(await readWorking('alpha', 'logic.js')).toBe('a2\n')
    expect(await readWorking('beta', 'logic.js')).toBe('b2\n')
  })
})

describe('update — error handling', () => {
  it('errors and exits non-zero for a module missing from the registry', async () => {
    await writeModule('alpha', { version: '1.0.0' })
    await install('alpha')
    await rm(join(registryDir, 'alpha'), { recursive: true, force: true })

    const stderr = await expectExit(() =>
      update({ modules: ['alpha'], dir: wsDir, registry: registryDir }),
    )
    expect(stderr).toContain('missing from the registry')
  })

  it('errors and exits non-zero when asked to update a module that is not installed', async () => {
    await writeModule('alpha', { version: '1.0.0' })

    const stderr = await expectExit(() =>
      update({ modules: ['alpha'], dir: wsDir, registry: registryDir }),
    )
    expect(stderr).toContain('not installed')
  })
})

describe('update — consumer pointer', () => {
  it('regenerates an unmodified canonical pointer when the description changes upstream', async () => {
    await writeModule('alpha', { version: '1.0.0', main: mainWith('alpha', 'old description') })
    await install('alpha')
    expect(await readPointer('alpha')).toContain('description: old description')

    await writeModule('alpha', { version: '2.0.0', main: mainWith('alpha', 'new description') })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    const pointer = await readPointer('alpha')
    expect(pointer).toContain('description: new description')
    expect(pointer).not.toContain('old description')
    const ref = (await readLock()).modules['alpha'].files.find(
      (f) => f.path === '.claude/skills/alpha/SKILL.md',
    )
    expect(ref?.sha256).toBe(
      createHash('sha256').update(Buffer.from(pointer, 'utf-8')).digest('hex'),
    )
  })

  it('preserves a customized pointer, prints a notice, records its bytes, and doctor stays healthy', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'v1\n' } })
    await install('alpha')
    await writePointer('alpha', 'CUSTOM POINTER\n')

    await writeModule('alpha', { version: '2.0.0', extra: { 'logic.js': 'v2\n' } })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await readPointer('alpha')).toBe('CUSTOM POINTER\n')
    expect(log.lines().some((l) => l.includes('kept customized pointer'))).toBe(true)
    const ref = (await readLock()).modules['alpha'].files.find(
      (f) => f.path === '.claude/skills/alpha/SKILL.md',
    )
    expect(ref?.sha256).toBe(
      createHash('sha256').update(Buffer.from('CUSTOM POINTER\n', 'utf-8')).digest('hex'),
    )

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    const doctorLog = captureLog()
    try {
      await doctor({ dir: wsDir })
    } finally {
      doctorLog.restore()
      exitSpy.mockRestore()
    }
    expect(doctorLog.lines().some((l) => l.includes('All vendored modules healthy'))).toBe(true)
  })

  it('keeps an adopted custom pointer custom across a subsequent update', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'v1\n' } })
    await materializeSkill('alpha')
    await writePointer('alpha', 'ADOPTED CUSTOM\n')

    const adoptLog = captureLog()
    await adoptWorkspace({ dir: wsDir, registry: registryDir })
    adoptLog.restore()
    expect(await readPointer('alpha')).toBe('ADOPTED CUSTOM\n')

    await writeModule('alpha', { version: '2.0.0', extra: { 'logic.js': 'v2\n' } })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await readPointer('alpha')).toBe('ADOPTED CUSTOM\n')
    expect(log.lines().some((l) => l.includes('kept customized pointer'))).toBe(true)
    expect((await readLock()).modules['alpha'].version).toBe('2.0.0')
  })

  it('recreates the canonical pointer when it is missing at update time', async () => {
    await writeModule('alpha', { version: '1.0.0', main: mainWith('alpha', 'a thing') })
    await install('alpha')
    await rm(pointerPath('alpha'), { force: true })

    await writeModule('alpha', { version: '2.0.0', main: mainWith('alpha', 'a thing') })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    const pointer = await readPointer('alpha')
    expect(pointer).toContain('description: a thing')
    expect(pointer).toContain('skills/alpha/alpha.md')
    expect(log.lines().some((l) => l.includes('kept customized pointer'))).toBe(false)
  })

  it('regenerates an unmodified canonical .agents pointer when the description changes', async () => {
    await writeModule('alpha', { version: '1.0.0', main: mainWith('alpha', 'old description') })
    await install('alpha')
    const agentsPointer = join(wsDir, '.agents', 'skills', 'alpha', 'SKILL.md')
    expect(await readFile(agentsPointer, 'utf-8')).toContain('description: old description')

    await writeModule('alpha', { version: '2.0.0', main: mainWith('alpha', 'new description') })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    const pointer = await readFile(agentsPointer, 'utf-8')
    expect(pointer).toContain('description: new description')
    expect(pointer).not.toContain('old description')
    const ref = (await readLock()).modules['alpha'].files.find(
      (f) => f.path === '.agents/skills/alpha/SKILL.md',
    )
    expect(ref?.sha256).toBe(
      createHash('sha256').update(Buffer.from(pointer, 'utf-8')).digest('hex'),
    )
  })

  it('preserves a customized .agents pointer, records its bytes, and doctor stays healthy', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'v1\n' } })
    await install('alpha')
    const agentsPointer = join(wsDir, '.agents', 'skills', 'alpha', 'SKILL.md')
    await mkdir(join(wsDir, '.agents', 'skills', 'alpha'), { recursive: true })
    await writeFile(agentsPointer, 'CUSTOM AGENTS POINTER\n', 'utf-8')

    await writeModule('alpha', { version: '2.0.0', extra: { 'logic.js': 'v2\n' } })
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await readFile(agentsPointer, 'utf-8')).toBe('CUSTOM AGENTS POINTER\n')
    expect(log.lines().some((l) => l.includes('kept customized pointer'))).toBe(true)
    const ref = (await readLock()).modules['alpha'].files.find(
      (f) => f.path === '.agents/skills/alpha/SKILL.md',
    )
    expect(ref?.sha256).toBe(
      createHash('sha256').update(Buffer.from('CUSTOM AGENTS POINTER\n', 'utf-8')).digest('hex'),
    )

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    const doctorLog = captureLog()
    try {
      await doctor({ dir: wsDir })
    } finally {
      doctorLog.restore()
      exitSpy.mockRestore()
    }
    expect(doctorLog.lines().some((l) => l.includes('All vendored modules healthy'))).toBe(true)
  })

  it('ignores registry SKILL.md metadata on update — never vendored or locked', async () => {
    await writeModule('alpha', { version: '1.0.0' })
    await install('alpha')

    await writeModule('alpha', { version: '2.0.0' })
    await writeFile(
      join(registryDir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: alpha does a thing\n---\n\nSkill.\n',
      'utf-8',
    )
    const log = captureLog()
    await update({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await exists(join(wsDir, 'skills', 'alpha', 'SKILL.md'))).toBe(false)
    const paths = (await readLock()).modules['alpha'].files.map((f) => f.path)
    expect(paths).not.toContain('skills/alpha/SKILL.md')
  })
})
