import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { add } from '../../src/commands/add.js'
import { doctor } from '../../src/commands/doctor.js'
import { update } from '../../src/commands/update.js'

const REPO_REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'registry')

let tmpDir: string
let registryDir: string
let wsDir: string

const origRegistryEnv = process.env.STRAPER_REGISTRY_DIR

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-hooks-'))
  registryDir = join(tmpDir, 'registry')
  wsDir = join(tmpDir, 'workspace')
  await mkdir(registryDir, { recursive: true })
  await mkdir(wsDir, { recursive: true })
  delete process.env.STRAPER_REGISTRY_DIR
})

afterEach(async () => {
  if (origRegistryEnv === undefined) delete process.env.STRAPER_REGISTRY_DIR
  else process.env.STRAPER_REGISTRY_DIR = origRegistryEnv
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 })
  vi.restoreAllMocks()
})

interface HookDecl {
  event: string
  matcher?: string
  command: string
}

/** Write a fixture skill module, optionally shipping a hooks.json. */
async function writeModule(
  name: string,
  opts: { version?: string; hooks?: HookDecl[] } = {},
): Promise<void> {
  const dir = join(registryDir, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    type: 'skill',
    version: opts.version ?? '1.0.0',
    deps: [],
    config_keys: [],
    source_commit: 'deadbeef',
    published_at: '2026-01-01T00:00:00.000Z',
  }
  await writeFile(join(dir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(dir, 'CHANGELOG.md'), `# ${name} changelog\n`)
  await writeFile(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\n# ${name}\n`,
  )
  if (opts.hooks) {
    await writeFile(join(dir, 'hooks.json'), JSON.stringify({ hooks: opts.hooks }, null, 2) + '\n')
  }
}

interface HookEntry {
  type?: string
  command?: string
}
interface HookGroup {
  matcher?: string
  hooks?: HookEntry[]
}
interface Settings {
  hooks?: Record<string, HookGroup[]>
}
interface LockEntry {
  version: string
  hooks?: { event: string; matcher: string; command: string }[]
}
interface Lock {
  modules: Record<string, LockEntry>
}

function settingsPath(): string {
  return join(wsDir, '.claude', 'settings.json')
}

async function readSettings(): Promise<Settings> {
  return JSON.parse(await readFile(settingsPath(), 'utf-8')) as Settings
}

async function readLock(): Promise<Lock> {
  return JSON.parse(await readFile(join(wsDir, 'straper.lock'), 'utf-8')) as Lock
}

/** Count command entries under an event/matcher group matching command. */
function countHook(settings: Settings, event: string, matcher: string, command: string): number {
  const groups = settings.hooks?.[event] ?? []
  let n = 0
  for (const g of groups) {
    if ((g.matcher ?? '') !== matcher) continue
    for (const e of g.hooks ?? []) {
      if (e.type === 'command' && e.command === command) n++
    }
  }
  return n
}

function silence(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {})
}

describe('module-contributed hooks — add', () => {
  it('splices a module hooks.json into .claude/settings.json and records it in the lock', async () => {
    await writeModule('hooky', {
      hooks: [
        { event: 'PostToolUse', matcher: 'Edit|Write', command: 'skills/hooky/run.sh' },
        { event: 'SessionEnd', command: 'skills/hooky/run.sh' },
      ],
    })
    silence()
    await add({ modules: ['hooky'], dir: wsDir, registry: registryDir })

    const settings = await readSettings()
    expect(countHook(settings, 'PostToolUse', 'Edit|Write', 'skills/hooky/run.sh')).toBe(1)
    expect(countHook(settings, 'SessionEnd', '', 'skills/hooky/run.sh')).toBe(1)

    const entry = (await readLock()).modules['hooky']
    expect(entry.hooks).toEqual([
      { event: 'PostToolUse', matcher: 'Edit|Write', command: 'skills/hooky/run.sh' },
      { event: 'SessionEnd', matcher: '', command: 'skills/hooky/run.sh' },
    ])
  })

  it('does not touch settings and records no hooks for a module without hooks.json', async () => {
    await writeModule('plain')
    silence()
    await add({ modules: ['plain'], dir: wsDir, registry: registryDir })

    const entry = (await readLock()).modules['plain']
    expect(entry.hooks).toBeUndefined()
    // No hooks.json → no settings.json created.
    await expect(readFile(settingsPath(), 'utf-8')).rejects.toThrow()
  })

  it('is idempotent on re-add (no duplicate hook entries)', async () => {
    await writeModule('hooky', {
      hooks: [{ event: 'PostToolUse', matcher: 'Edit|Write', command: 'skills/hooky/run.sh' }],
    })
    silence()
    await add({ modules: ['hooky'], dir: wsDir, registry: registryDir })
    await add({ modules: ['hooky'], dir: wsDir, registry: registryDir })

    const settings = await readSettings()
    expect(countHook(settings, 'PostToolUse', 'Edit|Write', 'skills/hooky/run.sh')).toBe(1)
  })

  it('preserves pre-existing user hooks when merging into an existing settings.json', async () => {
    // A workspace that already has a baseline SessionEnd hook.
    await mkdir(join(wsDir, '.claude'), { recursive: true })
    await writeFile(
      settingsPath(),
      JSON.stringify(
        { hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: './scripts/session-end.sh' }] }] } },
        null,
        2,
      ),
    )
    await writeModule('hooky', {
      hooks: [{ event: 'SessionEnd', command: 'skills/hooky/run.sh' }],
    })
    silence()
    await add({ modules: ['hooky'], dir: wsDir, registry: registryDir })

    const settings = await readSettings()
    // Both the baseline and the module command coexist in the same matcher group.
    expect(countHook(settings, 'SessionEnd', '', './scripts/session-end.sh')).toBe(1)
    expect(countHook(settings, 'SessionEnd', '', 'skills/hooky/run.sh')).toBe(1)
  })
})

describe('module-contributed hooks — update replaces', () => {
  it('removes the old hook command and installs the new one on a version bump', async () => {
    await writeModule('hooky', {
      version: '1.0.0',
      hooks: [{ event: 'PostToolUse', matcher: 'Edit|Write', command: 'skills/hooky/old.sh' }],
    })
    silence()
    await add({ modules: ['hooky'], dir: wsDir, registry: registryDir })

    // Publish a new version whose hook command changed.
    await writeModule('hooky', {
      version: '1.1.0',
      hooks: [{ event: 'PostToolUse', matcher: 'Edit|Write', command: 'skills/hooky/new.sh' }],
    })
    await update({ modules: ['hooky'], dir: wsDir, registry: registryDir })

    const settings = await readSettings()
    expect(countHook(settings, 'PostToolUse', 'Edit|Write', 'skills/hooky/old.sh')).toBe(0)
    expect(countHook(settings, 'PostToolUse', 'Edit|Write', 'skills/hooky/new.sh')).toBe(1)

    const entry = (await readLock()).modules['hooky']
    expect(entry.hooks).toEqual([
      { event: 'PostToolUse', matcher: 'Edit|Write', command: 'skills/hooky/new.sh' },
    ])
  })
})

describe('module-contributed hooks — doctor', () => {
  it('flags a lock-recorded hook that is missing from settings.json', async () => {
    await writeModule('hooky', {
      hooks: [{ event: 'PostToolUse', matcher: 'Edit|Write', command: 'skills/hooky/run.sh' }],
    })
    silence()
    await add({ modules: ['hooky'], dir: wsDir, registry: registryDir })

    // Hand-remove the hook from settings.json (simulating drift/clobber).
    await writeFile(settingsPath(), JSON.stringify({ hooks: {} }, null, 2))

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await doctor({ dir: wsDir })

    expect(logs.join('\n')).toContain('hook not installed')
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('module-contributed hooks — real auto-commit module', () => {
  it('wires the auto-commit hook into settings.json idempotently', async () => {
    silence()
    await add({ modules: ['auto-commit'], dir: wsDir, registry: REPO_REGISTRY })
    await add({ modules: ['auto-commit'], dir: wsDir, registry: REPO_REGISTRY })

    const settings = await readSettings()
    expect(
      countHook(settings, 'PostToolUse', 'Edit|Write', 'skills/auto-commit/auto-commit.sh'),
    ).toBe(1)
    expect(countHook(settings, 'SessionEnd', '', 'skills/auto-commit/auto-commit.sh')).toBe(1)

    const entry = (await readLock()).modules['auto-commit']
    expect(Array.isArray(entry.hooks)).toBe(true)
    expect(entry.hooks?.length).toBe(2)
  })
})
