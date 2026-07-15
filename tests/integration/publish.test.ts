import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { publish, type PublishResult } from '../../src/commands/publish.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string
let wsDir: string
let registryRepo: string
const createdWorktrees: string[] = []

const origRegistryRepoEnv = process.env.STRAPER_REGISTRY_REPO

const GATE_STUB = `#!/usr/bin/env bash
# Test stub gate honoring: scrub.sh --profile publish <files...>
# Exit 1 with a FAIL line if any file contains the marker; else exit 0.
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) shift 2 ;;
    -*) shift ;;
    *) files+=("$1"); shift ;;
  esac
done
rc=0
for f in "\${files[@]}"; do
  if grep -q 'PUBLISH_GATE_FAIL' "$f" 2>/dev/null; then
    echo "$f:1: [FAIL] identity: gate marker present"
    rc=1
  fi
done
exit $rc
`

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

async function makeWorkspaceGated(): Promise<void> {
  await mkdir(join(wsDir, 'skills', 'scrub'), { recursive: true })
  await writeFile(join(wsDir, 'skills', 'scrub', 'scrub.sh'), GATE_STUB, 'utf-8')
  await chmod(join(wsDir, 'skills', 'scrub', 'scrub.sh'), 0o755)
  await mkdir(join(wsDir, 'config'), { recursive: true })
  await writeFile(join(wsDir, 'config', 'publish-gate.conf'), '# test gate config\n', 'utf-8')
}

interface SkillOpts {
  dependsOn?: string[]
  commandsJs?: string
  mdBody?: string
}

async function writeSkill(name: string, opts: SkillOpts = {}): Promise<void> {
  const dir = join(wsDir, 'skills', name)
  await mkdir(dir, { recursive: true })
  const dependsOn = opts.dependsOn ?? []
  const dependsBlock =
    dependsOn.length > 0
      ? `depends_on:\n${dependsOn.map((d) => `  - ${d}`).join('\n')}\n`
      : 'depends_on: []\n'
  const md = `---\nname: ${name}\ndescription: ${name} does a thing\nversion: 1\nvisibility: user\ntriggers:\n  - /${name}\n${dependsBlock}---\n\n# ${name}\n\n${opts.mdBody ?? 'Body.'}\n`
  await writeFile(join(dir, `${name}.md`), md, 'utf-8')
  if (opts.commandsJs !== undefined) {
    await writeFile(join(dir, `${name}-commands.js`), opts.commandsJs, 'utf-8')
  }
}

async function initWorkspaceGit(): Promise<void> {
  git(wsDir, ['init', '-q'])
  git(wsDir, ['config', 'user.email', 'ws@localhost'])
  git(wsDir, ['config', 'user.name', 'ws'])
  git(wsDir, ['add', '-A'])
  git(wsDir, ['commit', '-q', '-m', 'workspace fixture'])
}

async function initRegistryRepo(): Promise<void> {
  await mkdir(join(registryRepo, 'registry'), { recursive: true })
  await writeFile(join(registryRepo, 'registry', 'README.md'), '# Registry\n', 'utf-8')
  git(registryRepo, ['init', '-q'])
  git(registryRepo, ['config', 'user.email', 'reg@localhost'])
  git(registryRepo, ['config', 'user.name', 'reg'])
  git(registryRepo, ['add', '-A'])
  git(registryRepo, ['commit', '-q', '-m', 'initial'])
}

async function runPublish(name: string): Promise<PublishResult> {
  const result = await publish({ module: name, dir: wsDir, registryRepo })
  createdWorktrees.push(result.worktreePath)
  return result
}

/** Read a committed file from the publish branch of the registry repo. */
function showOnBranch(branch: string, path: string): string {
  return execFileSync('git', ['-C', registryRepo, 'show', `${branch}:${path}`], {
    encoding: 'utf-8',
  })
}

function captureLog(): { restore: () => void } {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  return { restore: () => spy.mockRestore() }
}

/** Run fn expecting a clean process.exit(1); returns captured stderr text. */
async function expectExit(fn: () => Promise<unknown>): Promise<string> {
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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'straper-publish-test-'))
  wsDir = join(tmpDir, 'workspace')
  registryRepo = join(tmpDir, 'registry-repo')
  await mkdir(wsDir, { recursive: true })
  await mkdir(registryRepo, { recursive: true })
  delete process.env.STRAPER_REGISTRY_REPO
})

afterEach(async () => {
  if (origRegistryRepoEnv === undefined) delete process.env.STRAPER_REGISTRY_REPO
  else process.env.STRAPER_REGISTRY_REPO = origRegistryRepoEnv
  for (const wt of createdWorktrees.splice(0)) {
    await rm(join(wt, '..'), { recursive: true, force: true, maxRetries: 3 })
  }
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Environmental privilege
// ---------------------------------------------------------------------------

describe('publish — environmental privilege', () => {
  it('refuses when the gate engine is missing', async () => {
    await writeSkill('demo')
    await mkdir(join(wsDir, 'config'), { recursive: true })
    await writeFile(join(wsDir, 'config', 'publish-gate.conf'), '# cfg\n', 'utf-8')
    await initRegistryRepo()

    const stderr = await expectExit(() => publish({ module: 'demo', dir: wsDir, registryRepo }))
    expect(stderr).toContain('skills/scrub/scrub.sh')
  })

  it('refuses when the gate config is missing', async () => {
    await mkdir(join(wsDir, 'skills', 'scrub'), { recursive: true })
    await writeFile(join(wsDir, 'skills', 'scrub', 'scrub.sh'), GATE_STUB, 'utf-8')
    await writeSkill('demo')
    await initRegistryRepo()

    const stderr = await expectExit(() => publish({ module: 'demo', dir: wsDir, registryRepo }))
    expect(stderr).toContain('config/publish-gate.conf')
  })

  it('errors when no registry repo is given (no flag, no env)', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo')
    const stderr = await expectExit(() => publish({ module: 'demo', dir: wsDir }))
    expect(stderr).toContain('registry repo')
  })
})

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('publish — gate', () => {
  it('aborts on a gate FAIL and surfaces the scrub output', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { mdBody: 'This body has a PUBLISH_GATE_FAIL marker.' })
    await initRegistryRepo()

    const stderr = await expectExit(() => publish({ module: 'demo', dir: wsDir, registryRepo }))
    expect(stderr).toContain('gate FAILED')
    expect(stderr).toContain('[FAIL]')
  })

  it('removes the staged HEAD copy before exiting on a gate FAIL', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { mdBody: 'This body has a PUBLISH_GATE_FAIL marker.' })
    await initWorkspaceGit()
    await initRegistryRepo()

    // Point os.tmpdir() at a per-test dir so leaked staging dirs are observable.
    const testTmp = join(tmpDir, 'observed-tmp')
    await mkdir(testTmp, { recursive: true })
    const origTmpdir = process.env.TMPDIR
    process.env.TMPDIR = testTmp

    // Capture the temp-dir listing at the exact moment process.exit fires —
    // cleanup must have already happened by then (exit skips finally blocks).
    let stageDirsAtExit: string[] | undefined
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      stageDirsAtExit = readdirSync(testTmp).filter((name) => name.startsWith('straper-stage-'))
      throw new Error(`process.exit(${code})`)
    })
    try {
      await expect(publish({ module: 'demo', dir: wsDir, registryRepo })).rejects.toThrow(
        'process.exit(1)',
      )
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
      if (origTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = origTmpdir
    }
    expect(stageDirsAtExit).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Deps capture / self-containment
// ---------------------------------------------------------------------------

describe('publish — deps capture', () => {
  it('captures declared depends_on even when unreached', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { dependsOn: ['task', 'memory'] })
    await initRegistryRepo()

    const log = captureLog()
    const result = await runPublish('demo')
    log.restore()

    expect(result.deps).toEqual(['memory', 'task'])
    const manifest = JSON.parse(showOnBranch(result.branch, 'registry/demo/module.json'))
    expect(manifest.deps).toEqual(['memory', 'task'])
  })

  it('fails on a static reach into an undeclared skill', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', {
      dependsOn: [],
      commandsJs: "const x = require('../other/helper.js')\n",
    })
    await initRegistryRepo()

    const stderr = await expectExit(() => publish({ module: 'demo', dir: wsDir, registryRepo }))
    expect(stderr).toContain('other')
    expect(stderr).toContain('depends_on')
  })

  it('allows a reach into the runtime baseline without a dep', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', {
      dependsOn: [],
      commandsJs: "const u = require('../../scripts/lib/cli-utils.js')\n",
    })
    await initRegistryRepo()

    const log = captureLog()
    const result = await runPublish('demo')
    log.restore()

    expect(result.deps).toEqual([])
  })

  it('fails on a non-baseline reach outside the skill', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', {
      dependsOn: [],
      commandsJs: "const s = require('../../secrets/keys.js')\n",
    })
    await initRegistryRepo()

    const stderr = await expectExit(() => publish({ module: 'demo', dir: wsDir, registryRepo }))
    expect(stderr).toContain('secrets/keys.js')
    expect(stderr).toContain('runtime baseline')
  })
})

// ---------------------------------------------------------------------------
// Successful publish
// ---------------------------------------------------------------------------

describe('publish — successful publish', () => {
  it('writes module.json, CHANGELOG, ledger, and commits on a fresh branch', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { dependsOn: ['task'], commandsJs: "console.log('hi')\n" })
    await initWorkspaceGit()
    await initRegistryRepo()

    const log = captureLog()
    const result = await runPublish('demo')
    log.restore()

    expect(result.version).toBe('0.1.0')
    expect(result.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    // module.json shape.
    const manifest = JSON.parse(showOnBranch(result.branch, 'registry/demo/module.json'))
    expect(manifest).toMatchObject({
      name: 'demo',
      type: 'skill',
      version: '0.1.0',
      deps: ['task'],
      config_keys: [],
      source_commit: result.sourceCommit,
    })
    expect(typeof manifest.published_at).toBe('string')

    // Source files copied; workspace-only metadata is not synthesized into source.
    expect(showOnBranch(result.branch, 'registry/demo/demo.md')).toContain('name: demo')
    expect(showOnBranch(result.branch, 'registry/demo/demo-commands.js')).toContain('hi')

    // CHANGELOG line.
    expect(showOnBranch(result.branch, 'registry/demo/CHANGELOG.md')).toContain('## 0.1.0 —')

    // Commit is real and on the branch.
    const subject = execFileSync(
      'git',
      ['-C', registryRepo, 'log', '-1', '--format=%s', result.branch],
      { encoding: 'utf-8' },
    ).trim()
    expect(subject).toBe('feat(registry): publish demo module v0.1.0')

    // Ledger written in the workspace with the same content hash.
    const ledger = JSON.parse(await readFile(join(wsDir, '.straper-publish.json'), 'utf-8'))
    expect(ledger.modules.demo.content_hash).toBe(result.contentHash)
    expect(ledger.modules.demo.version).toBe('0.1.0')
  })

  it('reproduces the same content hash for identical module source', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { commandsJs: "console.log('stable')\n" })
    await initRegistryRepo()

    const log = captureLog()
    const result = await runPublish('demo')
    log.restore()

    // Recompute independently over the module dir using the documented contract.
    const moduleDir = join(wsDir, 'skills', 'demo')
    const rels = ['demo-commands.js', 'demo.md'].sort()
    const hash = createHash('sha256')
    for (const rel of rels) {
      hash.update(rel, 'utf8')
      hash.update('\0')
      hash.update(await readFile(join(moduleDir, rel)))
      hash.update('\0')
    }
    expect(result.contentHash).toBe(`sha256:${hash.digest('hex')}`)
  })

  it('resolves the registry repo from STRAPER_REGISTRY_REPO when no flag is given', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo')
    await initRegistryRepo()
    process.env.STRAPER_REGISTRY_REPO = registryRepo

    const log = captureLog()
    const result = await publish({ module: 'demo', dir: wsDir })
    createdWorktrees.push(result.worktreePath)
    log.restore()

    expect(result.registryRepo).toBe(registryRepo)
    expect(result.version).toBe('0.1.0')
    // Non-git workspace: fallback publishes working-dir bytes with no provenance.
    expect(result.sourceCommit).toBe('')
  })
})

// ---------------------------------------------------------------------------
// HEAD staging — publishes tracked content at HEAD, not the working tree
// ---------------------------------------------------------------------------

describe('publish — HEAD staging in a git workspace', () => {
  it('publishes HEAD bytes when the module has uncommitted edits, with a warning', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { commandsJs: "console.log('committed-v1')\n" })
    await initWorkspaceGit()
    await initRegistryRepo()

    const log1 = captureLog()
    const clean = await runPublish('demo')
    log1.restore()

    // Dirty the module after HEAD.
    await writeFile(
      join(wsDir, 'skills', 'demo', 'demo-commands.js'),
      "console.log('DIRTY-EDIT')\n",
      'utf-8',
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log2 = captureLog()
    const dirty = await runPublish('demo')
    log2.restore()

    expect(dirty.contentHash).toBe(clean.contentHash)
    expect(dirty.sourceCommit).toBe(clean.sourceCommit)
    expect(showOnBranch(dirty.branch, 'registry/demo/demo-commands.js')).toContain('committed-v1')
    expect(showOnBranch(dirty.branch, 'registry/demo/demo-commands.js')).not.toContain('DIRTY-EDIT')
    expect(warnSpy.mock.calls.map((args) => args.join(' ')).join('\n')).toContain(
      'NOT being published',
    )
  })

  it('does not publish untracked files in the module dir', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { commandsJs: "console.log('tracked')\n" })
    await initWorkspaceGit()
    await initRegistryRepo()

    await writeFile(join(wsDir, 'skills', 'demo', 'untracked-note.md'), 'scratch\n', 'utf-8')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = captureLog()
    const result = await runPublish('demo')
    log.restore()

    expect(showOnBranch(result.branch, 'registry/demo/demo-commands.js')).toContain('tracked')
    expect(() => showOnBranch(result.branch, 'registry/demo/untracked-note.md')).toThrow()
    expect(warnSpy.mock.calls.map((args) => args.join(' ')).join('\n')).toContain(
      'uncommitted changes',
    )
  })
})

// ---------------------------------------------------------------------------
// Version bump on republish
// ---------------------------------------------------------------------------

describe('publish — version bump on republish', () => {
  it('patch-bumps when the module already exists on the registry base branch', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo')
    await initRegistryRepo()

    const log1 = captureLog()
    const first = await runPublish('demo')
    log1.restore()
    expect(first.version).toBe('0.1.0')

    // Simulate the PR landing: fast-forward the base branch to the publish branch.
    const baseBranch = execFileSync(
      'git',
      ['-C', registryRepo, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf-8' },
    ).trim()
    git(registryRepo, ['merge', '--ff-only', first.branch])
    expect(
      execFileSync('git', ['-C', registryRepo, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf-8',
      }).trim(),
    ).toBe(baseBranch)

    const log2 = captureLog()
    const second = await runPublish('demo')
    log2.restore()
    expect(second.version).toBe('0.1.1')
  })
})

// ---------------------------------------------------------------------------
// SKILL.md registry metadata (Agent Skills spec interop)
// ---------------------------------------------------------------------------

describe('publish — SKILL.md metadata', () => {
  it('generates a spec-compliant SKILL.md carrying name + description and the body', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { mdBody: 'The real skill body.' })
    await initRegistryRepo()

    const log = captureLog()
    const result = await runPublish('demo')
    log.restore()

    const skillMd = showOnBranch(result.branch, 'registry/demo/SKILL.md')
    expect(skillMd.startsWith('---\n')).toBe(true)
    expect(skillMd).toContain('name: demo')
    expect(skillMd).toContain('description: demo does a thing')
    expect(skillMd).toContain('The real skill body.')
  })

  it('excludes SKILL.md from the module content hash (source files only)', async () => {
    await makeWorkspaceGated()
    await writeSkill('demo', { commandsJs: "console.log('stable')\n" })
    await initRegistryRepo()

    const log = captureLog()
    const result = await runPublish('demo')
    log.restore()

    // SKILL.md IS committed to the registry surface...
    expect(() => showOnBranch(result.branch, 'registry/demo/SKILL.md')).not.toThrow()

    // ...yet the content hash covers only the source skill files, so its presence
    // never perturbs the ledger/drift contract.
    const moduleDir = join(wsDir, 'skills', 'demo')
    const hash = createHash('sha256')
    for (const rel of ['demo-commands.js', 'demo.md'].sort()) {
      hash.update(rel, 'utf8')
      hash.update('\0')
      hash.update(await readFile(join(moduleDir, rel)))
      hash.update('\0')
    }
    expect(result.contentHash).toBe(`sha256:${hash.digest('hex')}`)
  })

  it('fails when no description can be derived for SKILL.md', async () => {
    await makeWorkspaceGated()
    const dir = join(wsDir, 'skills', 'demo')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'demo.md'),
      '---\nname: demo\nversion: 1\n---\n\n# demo\n\nBody.\n',
      'utf-8',
    )
    await initRegistryRepo()

    const stderr = await expectExit(() => publish({ module: 'demo', dir: wsDir, registryRepo }))
    expect(stderr).toContain('description')
  })
})
