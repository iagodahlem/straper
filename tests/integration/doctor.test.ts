import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { add } from '../../src/commands/add.js'
import { doctor } from '../../src/commands/doctor.js'

let tmpDir: string
let registryDir: string
let wsDir: string

const origRegistryEnv = process.env.STRAPER_REGISTRY_DIR

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-doctor-test-'))
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

async function writeModule(name: string): Promise<void> {
  const dir = join(registryDir, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    type: 'skill',
    version: '1.0.0',
    deps: [],
    config_keys: [],
    source_commit: 'deadbeef',
    published_at: '2026-01-01T00:00:00.000Z',
  }
  await writeFile(join(dir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await writeFile(join(dir, 'CHANGELOG.md'), `# ${name} changelog\n`, 'utf-8')
  await writeFile(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} does a thing\nversion: 1\n---\n\n# ${name}\n\nBody.\n`,
    'utf-8',
  )
  await writeFile(join(dir, 'logic.js'), 'v1\n', 'utf-8')
}

function captureLog(): { text: () => string; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  })
  return { text: () => lines.join('\n'), restore: () => spy.mockRestore() }
}

/** Run doctor expecting process.exit(1); returns captured stdout text. */
async function expectExit(fn: () => Promise<void>): Promise<string> {
  const log = captureLog()
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`)
  })
  try {
    await expect(fn()).rejects.toThrow('process.exit(1)')
    return log.text()
  } finally {
    exitSpy.mockRestore()
    log.restore()
  }
}

async function install(name: string): Promise<void> {
  const log = captureLog()
  await add({ modules: [name], dir: wsDir, registry: registryDir })
  log.restore()
}

// ---------------------------------------------------------------------------

describe('doctor — clean workspace', () => {
  it('reports all healthy and does not exit non-zero', async () => {
    await writeModule('alpha')
    await install('alpha')

    const log = captureLog()
    await doctor({ dir: wsDir })
    log.restore()

    expect(log.text()).toContain('alpha')
    expect(log.text()).toContain('All vendored modules healthy')
  })
})

describe('doctor — locally modified is informational', () => {
  it('flags the modified file but exits zero', async () => {
    await writeModule('alpha')
    await install('alpha')
    await writeFile(join(wsDir, 'skills', 'alpha', 'logic.js'), 'edited\n', 'utf-8')

    const log = captureLog()
    await doctor({ dir: wsDir })
    log.restore()

    expect(log.text()).toContain('locally modified')
    expect(log.text()).toContain('All vendored modules healthy')
  })
})

describe('doctor — missing file', () => {
  it('reports a missing tracked file and exits non-zero', async () => {
    await writeModule('alpha')
    await install('alpha')
    await rm(join(wsDir, 'skills', 'alpha', 'logic.js'), { force: true })

    const out = await expectExit(() => doctor({ dir: wsDir }))
    expect(out).toContain('missing file')
    expect(out).toContain('problem(s) found')
  })
})

describe('doctor — unresolved conflict markers', () => {
  it('reports conflict markers and exits non-zero', async () => {
    await writeModule('alpha')
    await install('alpha')
    await writeFile(
      join(wsDir, 'skills', 'alpha', 'logic.js'),
      '<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> registry\n',
      'utf-8',
    )

    const out = await expectExit(() => doctor({ dir: wsDir }))
    expect(out).toContain('unresolved conflict markers')
  })
})

describe('doctor — universal .agents pointer', () => {
  it('flags a missing lock-recorded .agents pointer as a problem', async () => {
    await writeModule('alpha')
    await install('alpha')
    await rm(join(wsDir, '.agents', 'skills', 'alpha', 'SKILL.md'), { force: true })

    const out = await expectExit(() => doctor({ dir: wsDir }))
    expect(out).toContain('missing file')
    expect(out).toContain('.agents/skills/alpha/SKILL.md')
    expect(out).toContain('problem(s) found')
  })

  it('stays healthy when --no-agents-dir opted out (pointer never recorded)', async () => {
    await writeModule('alpha')
    const addLog = captureLog()
    await add({ modules: ['alpha'], dir: wsDir, registry: registryDir, noAgentsDir: true })
    addLog.restore()

    const log = captureLog()
    await doctor({ dir: wsDir })
    log.restore()

    expect(log.text()).toContain('All vendored modules healthy')
  })
})

describe('doctor — orphan vendored dir is informational', () => {
  it('reports an unmanaged skills/ dir but exits zero', async () => {
    await writeModule('alpha')
    await install('alpha')
    await mkdir(join(wsDir, 'skills', 'ghost'), { recursive: true })
    await writeFile(join(wsDir, 'skills', 'ghost', 'ghost.md'), 'stray\n', 'utf-8')

    const log = captureLog()
    await doctor({ dir: wsDir })
    log.restore()

    expect(log.text()).toContain('ghost')
    expect(log.text()).toContain('unmanaged')
    expect(log.text()).toContain('All vendored modules healthy')
  })
})
