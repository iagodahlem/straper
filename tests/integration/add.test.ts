import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { add, resolveRegistryRoot } from '../../src/commands/add.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'registry')

let tmpDir: string
let registryDir: string
let wsDir: string

const origRegistryEnv = process.env.STRAPER_REGISTRY_DIR

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-add-test-'))
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
  type?: string
  version?: string
  deps?: string[]
  sourceCommit?: string
  description?: string
  extraFile?: string
}

/** Write a fixture module into the temp registry. */
async function writeModule(name: string, opts: ModuleOpts = {}): Promise<void> {
  const dir = join(registryDir, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    type: opts.type ?? 'skill',
    version: opts.version ?? '1.0.0',
    deps: opts.deps ?? [],
    config_keys: [],
    source_commit: opts.sourceCommit ?? 'deadbeefcafe',
    published_at: '2026-01-01T00:00:00.000Z',
  }
  await writeFile(join(dir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await writeFile(join(dir, 'CHANGELOG.md'), `# ${name} changelog\n`, 'utf-8')
  const description = opts.description ?? `${name} does a thing`
  await writeFile(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nversion: 1\nvisibility: user\ntriggers:\n  - /${name}\n---\n\n# ${name}\n\nBody.\n`,
    'utf-8',
  )
  if (opts.extraFile) {
    await writeFile(join(dir, opts.extraFile), `// ${name} extra file\n`, 'utf-8')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
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

// Expectations for the real bundled module are derived from the registry at test
// time — republishing a module must never break these tests.
interface BundledManifest {
  version: string
  source_commit: string
  deps?: string[]
}

async function readBundledManifest(name: string): Promise<BundledManifest> {
  return JSON.parse(await readFile(join(REPO_REGISTRY, name, 'module.json'), 'utf-8'))
}

/** Transitive dep closure of a bundled module (module included), sorted. */
async function bundledClosure(name: string): Promise<string[]> {
  const seen = new Set<string>()
  const visit = async (mod: string): Promise<void> => {
    if (seen.has(mod)) return
    seen.add(mod)
    for (const dep of (await readBundledManifest(mod)).deps ?? []) {
      await visit(dep)
    }
  }
  await visit(name)
  return [...seen].sort()
}

/** Silence and capture console.log for summary-line assertions. */
function captureLog(): { lines: () => string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  })
  return {
    lines: () => lines,
    restore: () => spy.mockRestore(),
  }
}

/** Run add() expecting a clean process.exit(1); returns stderr text. */
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
// resolveRegistryRoot
// ---------------------------------------------------------------------------

describe('resolveRegistryRoot', () => {
  it('prefers the --registry flag over the env var', () => {
    process.env.STRAPER_REGISTRY_DIR = '/env/registry'
    expect(resolveRegistryRoot({ registry: registryDir })).toBe(registryDir)
  })

  it('falls back to STRAPER_REGISTRY_DIR when no flag is given', () => {
    process.env.STRAPER_REGISTRY_DIR = registryDir
    expect(resolveRegistryRoot({})).toBe(registryDir)
  })

  it('falls back to the bundled registry when neither flag nor env is set', () => {
    expect(resolveRegistryRoot({})).toBe(REPO_REGISTRY)
  })
})

// ---------------------------------------------------------------------------
// Vendoring the real published module
// ---------------------------------------------------------------------------

describe('add — vendors the published session-review module', () => {
  it('copies source files but not registry metadata', async () => {
    const log = captureLog()
    await add({ modules: ['session-review'], dir: wsDir, registry: REPO_REGISTRY })
    log.restore()

    expect(await exists(join(wsDir, 'skills', 'session-review', 'session-review.md'))).toBe(true)
    expect(
      await exists(join(wsDir, 'skills', 'session-review', 'session-review-commands.js')),
    ).toBe(true)
    // Registry metadata must not be vendored.
    expect(await exists(join(wsDir, 'skills', 'session-review', 'module.json'))).toBe(false)
    expect(await exists(join(wsDir, 'skills', 'session-review', 'CHANGELOG.md'))).toBe(false)
    expect(await exists(join(wsDir, 'skills', 'session-review', 'SKILL.md'))).toBe(false)
  })

  it('emits a consumer SKILL.md pointer with name + description frontmatter', async () => {
    const log = captureLog()
    await add({ modules: ['session-review'], dir: wsDir, registry: REPO_REGISTRY })
    log.restore()

    const pointerPath = join(wsDir, '.claude', 'skills', 'session-review', 'SKILL.md')
    expect(await exists(pointerPath)).toBe(true)
    const content = await readFile(pointerPath, 'utf-8')
    expect(content.startsWith('---\n')).toBe(true)
    expect(content).toContain('name: session-review')
    // Description is derived from the skill .md frontmatter, not module.json.
    expect(content).toContain(
      'description: End-of-session review — summarize progress, update tracking, flag loose ends',
    )
    expect(content).toContain('skills/session-review/session-review.md')
  })

  it('writes a lockfile entry with metadata and per-file sha256 of the written bytes', async () => {
    const log = captureLog()
    await add({ modules: ['session-review'], dir: wsDir, registry: REPO_REGISTRY })
    log.restore()

    const manifest = await readBundledManifest('session-review')
    const lock = await readLock()
    expect(lock.lockfileVersion).toBe(1)
    const entry = lock.modules['session-review']
    expect(entry.version).toBe(manifest.version)
    expect(entry.type).toBe('skill')
    expect(entry.source_commit).toBe(manifest.source_commit)

    // File list is sorted and includes the pointer.
    const paths = entry.files.map((f) => f.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toContain('.claude/skills/session-review/SKILL.md')
    expect(paths).toContain('skills/session-review/session-review.md')
    // Registry-surface SKILL.md is metadata, never locked as a vendored file.
    expect(paths).not.toContain('skills/session-review/SKILL.md')

    // Every recorded hash matches the actual bytes on disk.
    for (const ref of entry.files) {
      const bytes = await readFile(join(wsDir, ref.path))
      expect(ref.sha256).toBe(sha256File(bytes))
    }
  })

  it('prints a concise summary line', async () => {
    const log = captureLog()
    await add({ modules: ['session-review'], dir: wsDir, registry: REPO_REGISTRY })
    log.restore()

    const manifest = await readBundledManifest('session-review')
    const depCount = (await bundledClosure('session-review')).length - 1
    expect(log.lines()).toContain(
      `added session-review@${manifest.version} (+${depCount} dep${depCount === 1 ? '' : 's'})`,
    )
  })

  it('creates straper.lock when absent (no prior init)', async () => {
    const bareDir = join(tmpDir, 'bare')
    await mkdir(bareDir, { recursive: true })
    const log = captureLog()
    await add({ modules: ['session-review'], dir: bareDir, registry: REPO_REGISTRY })
    log.restore()
    expect(await exists(join(bareDir, 'straper.lock'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Universal .agents pointer
// ---------------------------------------------------------------------------

describe('add — universal .agents pointer', () => {
  it('emits a spec-compliant .agents/skills pointer and records it in the lock', async () => {
    await writeModule('alpha')
    const log = captureLog()
    await add({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    const pointerPath = join(wsDir, '.agents', 'skills', 'alpha', 'SKILL.md')
    expect(await exists(pointerPath)).toBe(true)
    const content = await readFile(pointerPath, 'utf-8')
    expect(content.startsWith('---\n')).toBe(true)
    expect(content).toContain('name: alpha')
    expect(content).toContain('description: alpha does a thing')
    expect(content).toContain('skills/alpha/alpha.md')

    const entry = (await readLock()).modules['alpha']
    const paths = entry.files.map((f) => f.path)
    expect(paths).toContain('.agents/skills/alpha/SKILL.md')
    expect(paths).toContain('.claude/skills/alpha/SKILL.md')
    const ref = entry.files.find((f) => f.path === '.agents/skills/alpha/SKILL.md')
    expect(ref?.sha256).toBe(sha256File(Buffer.from(content, 'utf-8')))
  })

  it('skips the .agents pointer with --no-agents-dir and never locks it', async () => {
    await writeModule('alpha')
    const log = captureLog()
    await add({ modules: ['alpha'], dir: wsDir, registry: registryDir, noAgentsDir: true })
    log.restore()

    expect(await exists(join(wsDir, '.agents', 'skills', 'alpha', 'SKILL.md'))).toBe(false)
    // The Claude pointer is unaffected.
    expect(await exists(join(wsDir, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true)
    const paths = (await readLock()).modules['alpha'].files.map((f) => f.path)
    expect(paths).not.toContain('.agents/skills/alpha/SKILL.md')
    expect(paths).toContain('.claude/skills/alpha/SKILL.md')
  })

  it('skips the .agents pointer when STRAPER_NO_AGENTS_DIR=1', async () => {
    process.env.STRAPER_NO_AGENTS_DIR = '1'
    try {
      await writeModule('alpha')
      const log = captureLog()
      await add({ modules: ['alpha'], dir: wsDir, registry: registryDir })
      log.restore()
    } finally {
      delete process.env.STRAPER_NO_AGENTS_DIR
    }

    expect(await exists(join(wsDir, '.agents', 'skills', 'alpha', 'SKILL.md'))).toBe(false)
    const paths = (await readLock()).modules['alpha'].files.map((f) => f.path)
    expect(paths).not.toContain('.agents/skills/alpha/SKILL.md')
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('add — idempotent re-add', () => {
  it('re-vendors without duplicating files or lock entries', async () => {
    const first = captureLog()
    await add({ modules: ['session-review'], dir: wsDir, registry: REPO_REGISTRY })
    first.restore()
    const lockA = await readLock()

    const second = captureLog()
    await add({ modules: ['session-review'], dir: wsDir, registry: REPO_REGISTRY })
    second.restore()
    const lockB = await readLock()

    // The lock holds exactly session-review plus its transitive dep closure.
    expect(Object.keys(lockB.modules).sort()).toEqual(await bundledClosure('session-review'))
    expect(lockB.modules['session-review'].files.map((f) => f.path)).toEqual(
      lockA.modules['session-review'].files.map((f) => f.path),
    )
  })
})

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

describe('add — transitive dependency resolution', () => {
  it('installs declared deps transitively and reports the dep count', async () => {
    await writeModule('beta', { version: '2.0.0' })
    await writeModule('alpha', { version: '1.0.0', deps: ['beta'], extraFile: 'alpha-extra.js' })

    const log = captureLog()
    await add({ modules: ['alpha'], dir: wsDir, registry: registryDir })
    log.restore()

    expect(await exists(join(wsDir, 'skills', 'alpha', 'alpha.md'))).toBe(true)
    expect(await exists(join(wsDir, 'skills', 'alpha', 'alpha-extra.js'))).toBe(true)
    expect(await exists(join(wsDir, 'skills', 'beta', 'beta.md'))).toBe(true)

    const lock = await readLock()
    expect(Object.keys(lock.modules).sort()).toEqual(['alpha', 'beta'])
    expect(lock.modules['beta'].version).toBe('2.0.0')

    expect(log.lines()).toContain('added alpha@1.0.0 (+1 dep)')
  })

  it('dedupes a shared dependency across multiple requested modules', async () => {
    await writeModule('shared', { version: '3.0.0' })
    await writeModule('one', { deps: ['shared'] })
    await writeModule('two', { deps: ['shared'] })

    const log = captureLog()
    await add({ modules: ['one', 'two'], dir: wsDir, registry: registryDir })
    log.restore()

    const lock = await readLock()
    expect(Object.keys(lock.modules).sort()).toEqual(['one', 'shared', 'two'])
    // "shared" is vendored once; the second requester sees it already installed.
    expect(log.lines()).toContain('added two@1.0.0 (+0 deps)')
  })

  it('errors on a dependency cycle instead of looping forever', async () => {
    await writeModule('cyclic-a', { deps: ['cyclic-b'] })
    await writeModule('cyclic-b', { deps: ['cyclic-a'] })

    const stderr = await expectExit(() =>
      add({ modules: ['cyclic-a'], dir: wsDir, registry: registryDir }),
    )
    expect(stderr).toContain('Dependency cycle detected')
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('add — error handling', () => {
  it('errors clearly when a module is missing from the registry', async () => {
    const stderr = await expectExit(() =>
      add({ modules: ['does-not-exist'], dir: wsDir, registry: registryDir }),
    )
    expect(stderr).toContain('does-not-exist')
    expect(stderr).toContain('not found in registry')
  })

  it('rejects modules whose type is not "skill"', async () => {
    await writeModule('widget', { type: 'agent' })
    const stderr = await expectExit(() =>
      add({ modules: ['widget'], dir: wsDir, registry: registryDir }),
    )
    expect(stderr).toContain('widget')
    expect(stderr).toContain('skill')
  })
})
