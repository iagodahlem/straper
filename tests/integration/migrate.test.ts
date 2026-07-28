import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { doctor } from '../../src/commands/doctor.js'
import { migrate } from '../../src/commands/migrate.js'
import { update } from '../../src/commands/update.js'
import { main } from '../../src/cli.js'

let tmpDir: string
let registryDir: string
let wsDir: string

const origRegistryEnv = process.env.STRAPER_REGISTRY_DIR

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-migrate-test-'))
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ModuleOpts {
  version?: string
  sourceCommit?: string
  deps?: string[]
  extra?: Record<string, string>
}

/** Write a fixture registry module (flat file layout). */
async function writeModule(name: string, opts: ModuleOpts = {}): Promise<void> {
  const dir = join(registryDir, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    type: 'skill',
    version: opts.version ?? '1.0.0',
    deps: opts.deps ?? [],
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

/** Bake skills/<name>/ into the workspace, byte-exact with the registry source. */
async function bakeSkillExact(name: string): Promise<void> {
  const src = join(registryDir, name)
  const dest = join(wsDir, 'skills', name)
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (['module.json', 'CHANGELOG.md', 'SKILL.md'].includes(entry.name)) continue
    await writeFile(join(dest, entry.name), await readFile(join(src, entry.name)))
  }
}

/** Bake a legacy skills/<name>/ whose content predates (differs from) the registry copy. */
async function bakeSkillStale(name: string, content: string): Promise<void> {
  const dest = join(wsDir, 'skills', name)
  await mkdir(dest, { recursive: true })
  await writeFile(join(dest, `${name}.md`), content, 'utf-8')
}

async function readLock(): Promise<{
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
  return JSON.parse(await readFile(join(wsDir, 'straper.lock'), 'utf-8'))
}

function sha256File(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
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

// ---------------------------------------------------------------------------
// Legacy workspace with matching modules migrates cleanly
// ---------------------------------------------------------------------------

describe('migrate — legacy workspace with matching modules', () => {
  it('vendors a name-matched skill through the same path add uses', async () => {
    await writeModule('fd', { version: '1.2.0', sourceCommit: 'abc123', extra: { 'lib.js': 'v2\n' } })
    // Baked in from an old scaffold — stale content, not byte-matching the registry.
    await bakeSkillStale('fd', '# fd (old baked-in copy)\n')

    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('migrated fd@1.2.0')

    const lock = await readLock()
    const entry = lock.modules['fd']
    expect(entry.version).toBe('1.2.0')
    expect(entry.source_commit).toBe('abc123')

    // The old content was replaced with the published bytes.
    expect(await readFile(join(wsDir, 'skills', 'fd', 'fd.md'), 'utf-8')).toContain('# fd\n')
    expect(await readFile(join(wsDir, 'skills', 'fd', 'lib.js'), 'utf-8')).toBe('v2\n')

    for (const ref of entry.files) {
      expect(ref.sha256).toBe(sha256File(await readFile(join(wsDir, ref.path))))
    }
  })

  it('writes the pristine base store from the registry, not the old baked-in bytes', async () => {
    await writeModule('fd', { extra: { 'lib.js': 'v2\n' } })
    await bakeSkillStale('fd', '# fd (old)\n')

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))

    expect(await readFile(join(wsDir, '.straper', 'base', 'fd', 'lib.js'), 'utf-8')).toBe('v2\n')
    expect(await readFile(join(wsDir, '.straper', 'base', 'fd', 'fd.md'), 'utf-8')).toBe(
      await readFile(join(registryDir, 'fd', 'fd.md'), 'utf-8'),
    )
  })

  it('emits consumer pointers for a migrated skill', async () => {
    await writeModule('fd')
    await bakeSkillStale('fd', '# fd (old)\n')

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))

    const pointer = await readFile(join(wsDir, '.claude', 'skills', 'fd', 'SKILL.md'), 'utf-8')
    expect(pointer).toContain('name: fd')
    expect(pointer).toContain('skills/fd/fd.md')
    expect(await exists(join(wsDir, '.agents', 'skills', 'fd', 'SKILL.md'))).toBe(true)
  })

  it('vendors a byte-exact match too (still goes through the vendoring path, not adopt)', async () => {
    await writeModule('fd', { version: '1.0.0' })
    await bakeSkillExact('fd')

    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('migrated fd@1.0.0')
    expect((await readLock()).modules['fd']).toBeDefined()
  })

  it('pulls in a transitive registry dependency not present locally', async () => {
    await writeModule('memory', { version: '2.0.0' })
    await writeModule('session', { version: '1.5.0', deps: ['memory'] })
    await bakeSkillStale('session', '# session (old)\n')

    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('migrated session@1.5.0 (+1 dep)')

    const lock = await readLock()
    expect(Object.keys(lock.modules).sort()).toEqual(['memory', 'session'])
    expect(lock.modules['memory'].version).toBe('2.0.0')
    expect(await exists(join(wsDir, 'skills', 'memory', 'memory.md'))).toBe(true)
  })

  it('migrates several matching skills in one run and reports each', async () => {
    await writeModule('fd', { version: '1.0.0' })
    await writeModule('task', { version: '1.1.0' })
    await bakeSkillStale('fd', '# fd (old)\n')
    await bakeSkillStale('task', '# task (old)\n')

    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('migrated fd@1.0.0')
    expect(out).toContain('migrated task@1.1.0')
    expect(out).toContain('migrated 2, unmatched 0, already managed 0')
  })
})

// ---------------------------------------------------------------------------
// Custom skills preserved
// ---------------------------------------------------------------------------

describe('migrate — custom skills preserved', () => {
  it('leaves a skill with no matching registry module untouched and reports it', async () => {
    await mkdir(join(wsDir, 'skills', 'homegrown'), { recursive: true })
    await writeFile(join(wsDir, 'skills', 'homegrown', 'homegrown.md'), 'mine, custom\n', 'utf-8')

    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('homegrown no matching registry module')
    expect(out).toContain('unmatched 1')

    expect(await readFile(join(wsDir, 'skills', 'homegrown', 'homegrown.md'), 'utf-8')).toBe(
      'mine, custom\n',
    )
    const lock = await readLock()
    expect(lock.modules['homegrown']).toBeUndefined()
    expect(await dirExists(join(wsDir, '.straper', 'base', 'homegrown'))).toBe(false)
  })

  it('migrates matched skills while leaving custom ones alone in the same run', async () => {
    await writeModule('fd', { version: '1.0.0' })
    await bakeSkillStale('fd', '# fd (old)\n')
    await mkdir(join(wsDir, 'skills', 'homegrown'), { recursive: true })
    await writeFile(join(wsDir, 'skills', 'homegrown', 'homegrown.md'), 'mine\n', 'utf-8')

    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('migrated fd@1.0.0')
    expect(out).toContain('homegrown no matching registry module')

    const lock = await readLock()
    expect(Object.keys(lock.modules)).toEqual(['fd'])
    expect(await readFile(join(wsDir, 'skills', 'homegrown', 'homegrown.md'), 'utf-8')).toBe('mine\n')
  })
})

// ---------------------------------------------------------------------------
// Already-migrated workspace handled (idempotent-safe)
// ---------------------------------------------------------------------------

describe('migrate — already-migrated workspace', () => {
  it('no-ops when there is no skills/ directory at all', async () => {
    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('nothing to migrate')
    expect(await exists(join(wsDir, 'straper.lock'))).toBe(false)
  })

  it('re-running skips already-migrated modules instead of re-vendoring them', async () => {
    await writeModule('fd', { version: '1.0.0' })
    await bakeSkillStale('fd', '# fd (old)\n')

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    const afterFirst = await readFile(join(wsDir, 'skills', 'fd', 'fd.md'), 'utf-8')

    // Publish a new version — a second run must NOT silently update an already-managed module.
    await writeModule('fd', { version: '2.0.0' })

    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    expect(out).toContain('fd already managed')
    expect(out).toContain('migrated 0, unmatched 0, already managed 1')

    const lock = await readLock()
    expect(lock.modules['fd'].version).toBe('1.0.0')
    expect(await readFile(join(wsDir, 'skills', 'fd', 'fd.md'), 'utf-8')).toBe(afterFirst)
  })

  it('does not corrupt the lock when re-run on a fully migrated workspace', async () => {
    await writeModule('fd', { version: '1.0.0' })
    await bakeSkillStale('fd', '# fd (old)\n')

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    const lockAfterFirst = await readLock()

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))
    const lockAfterSecond = await readLock()

    expect(lockAfterSecond).toEqual(lockAfterFirst)
  })
})

// ---------------------------------------------------------------------------
// Lockfile / base correctness
// ---------------------------------------------------------------------------

describe('migrate — lockfile and base correctness', () => {
  it('writes a lock entry shaped like add', async () => {
    await writeModule('fd', { version: '1.2.0', sourceCommit: 'abc123', extra: { 'lib.js': 'v2\n' } })
    await bakeSkillStale('fd', '# fd (old)\n')

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))

    const lock = await readLock()
    expect(lock.lockfileVersion).toBe(1)
    const paths = lock.modules['fd'].files.map((f) => f.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toContain('.claude/skills/fd/SKILL.md')
    expect(paths).toContain('skills/fd/fd.md')
    expect(paths).toContain('skills/fd/lib.js')
  })

  it('creates a fresh v1 lock when none exists', async () => {
    await writeModule('fd')
    await bakeSkillStale('fd', '# fd (old)\n')
    expect(await exists(join(wsDir, 'straper.lock'))).toBe(false)

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))

    const lock = await readLock()
    expect(lock.lockfileVersion).toBe(1)
  })

  it('does not touch scaffold-owned baseline files outside skills/', async () => {
    await writeModule('fd')
    await bakeSkillStale('fd', '# fd (old)\n')
    await writeFile(join(wsDir, 'TOOLS.md'), '# Tools\n\nbaseline content\n', 'utf-8')
    await writeFile(join(wsDir, 'BOOT.md'), '# Boot\n\nbaseline content\n', 'utf-8')
    await mkdir(join(wsDir, 'scripts'), { recursive: true })
    await writeFile(join(wsDir, 'scripts', 'session-start.sh'), '#!/usr/bin/env bash\necho hi\n', 'utf-8')

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))

    expect(await readFile(join(wsDir, 'TOOLS.md'), 'utf-8')).toBe('# Tools\n\nbaseline content\n')
    expect(await readFile(join(wsDir, 'BOOT.md'), 'utf-8')).toBe('# Boot\n\nbaseline content\n')
    expect(await readFile(join(wsDir, 'scripts', 'session-start.sh'), 'utf-8')).toBe(
      '#!/usr/bin/env bash\necho hi\n',
    )
  })
})

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('migrate — dry run', () => {
  it('reports the plan without writing any files', async () => {
    await writeModule('fd', { version: '1.0.0' })
    await bakeSkillStale('fd', '# fd (old)\n')
    await mkdir(join(wsDir, 'skills', 'homegrown'), { recursive: true })
    await writeFile(join(wsDir, 'skills', 'homegrown', 'homegrown.md'), 'mine\n', 'utf-8')

    const out = await silently(() => migrate({ dir: wsDir, registry: registryDir, dryRun: true }))

    expect(out).toContain('would migrate fd to registry v1.0.0')
    expect(out).toContain('homegrown no matching registry module')
    expect(out).toContain('No files were modified')

    expect(await exists(join(wsDir, 'straper.lock'))).toBe(false)
    expect(await readFile(join(wsDir, 'skills', 'fd', 'fd.md'), 'utf-8')).toBe('# fd (old)\n')
  })
})

// ---------------------------------------------------------------------------
// CLI router
// ---------------------------------------------------------------------------

describe('migrate — router and help', () => {
  it('runs migration via the CLI router', async () => {
    await writeModule('fd', { version: '1.0.0' })
    await bakeSkillStale('fd', '# fd (old)\n')

    const out = await silently(() =>
      main(['migrate', '--dir', wsDir, '--registry', registryDir]),
    )
    expect(out).toContain('migrated fd@1.0.0')
    expect((await readLock()).modules['fd']).toBeDefined()
  })

  it('documents migrate without the reworked caveat', async () => {
    const out = await silently(() => main(['--help']))
    expect(out).toContain('straper migrate')
    expect(out.toLowerCase()).not.toContain('being reworked')
  })
})

// ---------------------------------------------------------------------------
// End-to-end health: migrate is compatible with doctor and update
// ---------------------------------------------------------------------------

describe('migrate — end-to-end health', () => {
  it('migrate -> doctor is healthy -> update is a no-op', async () => {
    await writeModule('fd', { version: '1.0.0', extra: { 'lib.js': 'v1\n' } })
    await bakeSkillStale('fd', '# fd (old)\n')

    await silently(() => migrate({ dir: wsDir, registry: registryDir }))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    const doctorOut = await silently(() => doctor({ dir: wsDir }))
    expect(doctorOut).toContain('All vendored modules healthy')
    exitSpy.mockRestore()

    const updateOut = await silently(() => update({ modules: [], dir: wsDir, registry: registryDir }))
    expect(updateOut).toContain('up to date')
    expect((await readLock()).modules['fd'].version).toBe('1.0.0')
  })
})
