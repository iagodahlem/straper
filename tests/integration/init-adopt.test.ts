import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { add } from '../../src/commands/add.js'
import { adoptWorkspace } from '../../src/commands/adopt.js'
import { doctor } from '../../src/commands/doctor.js'
import { init } from '../../src/commands/init.js'
import { update } from '../../src/commands/update.js'
import { main } from '../../src/cli.js'

let tmpDir: string
let registryDir: string
let wsDir: string

const origRegistryEnv = process.env.STRAPER_REGISTRY_DIR

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-adopt-test-'))
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
  sourceCommit?: string
  extra?: Record<string, string>
}

/** Write a fixture module (flat file layout) into the temp registry. */
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
    source_commit: opts.sourceCommit ?? 'deadbeefcafe',
    published_at: '2026-01-01T00:00:00.000Z',
  }
  await writeFile(join(dir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await writeFile(join(dir, 'CHANGELOG.md'), `# ${name} changelog\n`, 'utf-8')
  await writeFile(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} does a thing\nversion: 1\n---\n\n# ${name}\n\nBody.\n`,
    'utf-8',
  )
  for (const [rel, content] of Object.entries(opts.extra ?? {})) {
    await writeFile(join(dir, rel), content, 'utf-8')
  }
}

/** Materialize skills/<name>/ from the registry source (byte-exact, minus metadata). */
async function materializeSkill(name: string): Promise<void> {
  const src = join(registryDir, name)
  const dest = join(wsDir, 'skills', name)
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (['module.json', 'CHANGELOG.md', 'SKILL.md'].includes(entry.name)) continue
    await writeFile(join(dest, entry.name), await readFile(join(src, entry.name)))
  }
}

async function readLock(dir = wsDir): Promise<{
  lockfileVersion: number
  modules: Record<
    string,
    {
      version: string
      source_commit: string
      type: string
      files: Array<{ path: string; sha256: string }>
    }
  >
}> {
  return JSON.parse(await readFile(join(dir, 'straper.lock'), 'utf-8'))
}

function sha256File(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
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

function captureLog(): { lines: () => string[]; text: () => string; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  })
  return { lines: () => lines, text: () => lines.join('\n'), restore: () => spy.mockRestore() }
}

async function silently(fn: () => Promise<void>): Promise<string> {
  const log = captureLog()
  try {
    await fn()
    return log.text()
  } finally {
    log.restore()
  }
}

async function installReal(name: string): Promise<void> {
  await silently(() => add({ modules: [name], dir: wsDir, registry: registryDir }))
}

// ---------------------------------------------------------------------------

describe('init --adopt — exact-match adoption', () => {
  it('writes a lock entry with the same shape as add', async () => {
    await writeModule('alpha', { version: '1.2.0', sourceCommit: 'abc123', extra: { 'logic.js': 'v1\n' } })
    await materializeSkill('alpha')

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    const lock = await readLock()
    expect(lock.lockfileVersion).toBe(1)
    const entry = lock.modules['alpha']
    expect(entry.version).toBe('1.2.0')
    expect(entry.type).toBe('skill')
    expect(entry.source_commit).toBe('abc123')

    const paths = entry.files.map((f) => f.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toContain('.claude/skills/alpha/SKILL.md')
    expect(paths).toContain('skills/alpha/alpha.md')
    expect(paths).toContain('skills/alpha/logic.js')

    for (const ref of entry.files) {
      expect(ref.sha256).toBe(sha256File(await readFile(join(wsDir, ref.path))))
    }
  })

  it('ignores registry SKILL.md metadata and still byte-matches the workspace', async () => {
    await writeModule('alpha', { version: '1.0.0' })
    await writeFile(
      join(registryDir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: alpha does a thing\n---\n\nSkill.\n',
      'utf-8',
    )
    await materializeSkill('alpha') // workspace has no SKILL.md

    const text = await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))
    expect(text).toContain('adopted alpha')

    const lock = await readLock()
    const paths = lock.modules['alpha'].files.map((f) => f.path)
    expect(paths).not.toContain('skills/alpha/SKILL.md')
  })

  it('writes the pristine base store bytes', async () => {
    await writeModule('alpha', { extra: { 'logic.js': 'v1\n' } })
    await materializeSkill('alpha')

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    expect(await readFile(join(wsDir, '.straper', 'base', 'alpha', 'logic.js'), 'utf-8')).toBe('v1\n')
    expect(await readFile(join(wsDir, '.straper', 'base', 'alpha', 'alpha.md'), 'utf-8')).toBe(
      await readFile(join(registryDir, 'alpha', 'alpha.md'), 'utf-8'),
    )
  })

  it('emits the consumer pointer when it is missing', async () => {
    await writeModule('alpha')
    await materializeSkill('alpha')

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    const pointerPath = join(wsDir, '.claude', 'skills', 'alpha', 'SKILL.md')
    const content = await readFile(pointerPath, 'utf-8')
    expect(content).toContain('name: alpha')
    expect(content).toContain('description: alpha does a thing')
    expect(content).toContain('skills/alpha/alpha.md')
  })

  it('never overwrites an existing pointer, and records its actual bytes', async () => {
    await writeModule('alpha')
    await materializeSkill('alpha')
    const pointerPath = join(wsDir, '.claude', 'skills', 'alpha', 'SKILL.md')
    await mkdir(join(wsDir, '.claude', 'skills', 'alpha'), { recursive: true })
    await writeFile(pointerPath, 'CUSTOM POINTER\n', 'utf-8')

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    expect(await readFile(pointerPath, 'utf-8')).toBe('CUSTOM POINTER\n')
    const ref = (await readLock()).modules['alpha'].files.find(
      (f) => f.path === '.claude/skills/alpha/SKILL.md',
    )
    expect(ref?.sha256).toBe(sha256File(Buffer.from('CUSTOM POINTER\n', 'utf-8')))
  })

  it('emits the universal .agents pointer when it is missing', async () => {
    await writeModule('alpha')
    await materializeSkill('alpha')

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    const content = await readFile(join(wsDir, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf-8')
    expect(content).toContain('name: alpha')
    expect(content).toContain('description: alpha does a thing')
    expect(content).toContain('skills/alpha/alpha.md')
    const paths = (await readLock()).modules['alpha'].files.map((f) => f.path)
    expect(paths).toContain('.agents/skills/alpha/SKILL.md')
  })

  it('never overwrites an existing .agents pointer, and records its actual bytes', async () => {
    await writeModule('alpha')
    await materializeSkill('alpha')
    const agentsPointer = join(wsDir, '.agents', 'skills', 'alpha', 'SKILL.md')
    await mkdir(join(wsDir, '.agents', 'skills', 'alpha'), { recursive: true })
    await writeFile(agentsPointer, 'CUSTOM AGENTS\n', 'utf-8')

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    expect(await readFile(agentsPointer, 'utf-8')).toBe('CUSTOM AGENTS\n')
    const ref = (await readLock()).modules['alpha'].files.find(
      (f) => f.path === '.agents/skills/alpha/SKILL.md',
    )
    expect(ref?.sha256).toBe(sha256File(Buffer.from('CUSTOM AGENTS\n', 'utf-8')))
  })

  it('reports the adoption in the summary', async () => {
    await writeModule('alpha', { version: '1.2.0' })
    await materializeSkill('alpha')

    const out = await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('adopted alpha@1.2.0')
    expect(out).toContain('adopted 1, differing 0, unmanaged 0, already managed 0')
  })
})

describe('init --adopt — content differs', () => {
  it('does not adopt and reports the divergence', async () => {
    await writeModule('alpha', { version: '2.0.0', extra: { 'logic.js': 'v1\n' } })
    await materializeSkill('alpha')
    // Local edit makes the working tree diverge from the registry.
    await writeFile(join(wsDir, 'skills', 'alpha', 'logic.js'), 'LOCAL EDIT\n', 'utf-8')

    const out = await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    expect(out).toContain('differs from registry v2.0.0 — not adopted')
    expect(out).toContain('straper add alpha')
    const lock = await readLock()
    expect(lock.modules['alpha']).toBeUndefined()
    expect(await dirExists(join(wsDir, '.straper', 'base', 'alpha'))).toBe(false)
  })

  it('treats an extra local file as a difference', async () => {
    await writeModule('alpha')
    await materializeSkill('alpha')
    await writeFile(join(wsDir, 'skills', 'alpha', 'extra.js'), 'stray\n', 'utf-8')

    const out = await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('differs from registry')
    expect((await readLock()).modules['alpha']).toBeUndefined()
  })
})

describe('init --adopt — unmanaged and already-managed', () => {
  it('reports a workspace skill matching no registry module', async () => {
    await mkdir(join(wsDir, 'skills', 'homegrown'), { recursive: true })
    await writeFile(join(wsDir, 'skills', 'homegrown', 'homegrown.md'), 'mine\n', 'utf-8')

    const out = await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    expect(out).toContain('homegrown unmanaged')
    expect(out).toContain('unmanaged 1')
  })

  it('skips a module already tracked in the lock', async () => {
    await writeModule('alpha', { extra: { 'logic.js': 'v1\n' } })
    await installReal('alpha')

    const out = await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    expect(out).toContain('alpha already managed')
    expect(out).toContain('already managed 1')
    // The pre-existing entry is preserved untouched.
    expect((await readLock()).modules['alpha'].version).toBe('1.0.0')
  })

  it('preserves existing lock entries while adopting new ones', async () => {
    await writeModule('alpha', { extra: { 'logic.js': 'a\n' } })
    await writeModule('beta', { extra: { 'logic.js': 'b\n' } })
    await installReal('alpha')
    await materializeSkill('beta')

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    const lock = await readLock()
    expect(Object.keys(lock.modules).sort()).toEqual(['alpha', 'beta'])
  })
})

describe('init --adopt — lockfile bootstrapping', () => {
  it('creates a fresh v1 lock when none exists', async () => {
    await writeModule('alpha')
    await materializeSkill('alpha')
    expect(await exists(join(wsDir, 'straper.lock'))).toBe(false)

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    const lock = await readLock()
    expect(lock.lockfileVersion).toBe(1)
    expect(lock.modules['alpha']).toBeDefined()
  })

  it('creates a lock even when there is nothing to adopt', async () => {
    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))
    expect(await readLock()).toEqual({ lockfileVersion: 1, modules: {} })
  })
})

describe('init --adopt — performs no scaffolding', () => {
  it('touches nothing but the lock, base store, and pointer', async () => {
    await writeModule('alpha', { extra: { 'logic.js': 'v1\n' } })
    await materializeSkill('alpha')
    const before = await readFile(join(wsDir, 'skills', 'alpha', 'logic.js'), 'utf-8')

    await silently(() => init({ name: '', adopt: true, dir: wsDir, registry: registryDir }))

    // No scaffold artifacts of any kind.
    for (const artifact of ['AGENTS.md', 'SOUL.md', 'preferences.json', '.git', 'tasks', 'prompts']) {
      expect(await exists(join(wsDir, artifact))).toBe(false)
    }
    // Working files are byte-identical.
    expect(await readFile(join(wsDir, 'skills', 'alpha', 'logic.js'), 'utf-8')).toBe(before)
    // Only the management surface was created.
    expect(await exists(join(wsDir, 'straper.lock'))).toBe(true)
    expect(await dirExists(join(wsDir, '.straper', 'base', 'alpha'))).toBe(true)
    expect(await exists(join(wsDir, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true)
  })
})

describe('init --adopt — router and help', () => {
  it('runs adoption via the CLI router without requiring a <name>', async () => {
    await writeModule('alpha')
    await materializeSkill('alpha')

    const out = await silently(() => main(['init', '--adopt', '--dir', wsDir, '--registry', registryDir]))

    expect(out).toContain('adopted alpha@1.0.0')
    expect((await readLock()).modules['alpha']).toBeDefined()
  })

  it('documents --adopt in the help text', async () => {
    const out = await silently(() => main(['--help']))
    expect(out).toContain('--adopt')
  })
})

describe('init --adopt — end-to-end health', () => {
  it('adopt -> doctor is healthy -> update is a no-op', async () => {
    await writeModule('alpha', { version: '1.0.0', extra: { 'logic.js': 'v1\n' } })
    await materializeSkill('alpha')

    await silently(() => adoptWorkspace({ dir: wsDir, registry: registryDir }))

    // doctor exits 0 (never calls process.exit) and reports healthy.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    const doctorOut = await silently(() => doctor({ dir: wsDir }))
    expect(doctorOut).toContain('All vendored modules healthy')
    exitSpy.mockRestore()

    const updateOut = await silently(() => update({ modules: [], dir: wsDir, registry: registryDir }))
    expect(updateOut).toContain('up to date')
    expect((await readLock()).modules['alpha'].version).toBe('1.0.0')
  })
})
