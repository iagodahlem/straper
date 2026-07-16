import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeDrift, drift } from '../../src/commands/drift.js'
import { hashModuleAtHead } from '../../src/commands/publish.js'

let ws: string

function git(args: string[]): void {
  execFileSync('git', ['-C', ws, ...args], { stdio: 'pipe' })
}

function commit(message: string): void {
  git(['add', '-A'])
  execFileSync(
    'git',
    [
      '-C',
      ws,
      '-c',
      'user.email=test@straper.dev',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      message,
    ],
    { stdio: 'pipe' },
  )
}

async function writeSkill(name: string, body: string): Promise<void> {
  const dir = join(ws, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`)
}

interface LedgerRecord {
  version: string
  source_commit: string
  content_hash: string
  published_at: string
}

async function writeLedger(modules: Record<string, LedgerRecord>): Promise<void> {
  await writeFile(join(ws, '.straper-publish.json'), JSON.stringify({ modules }, null, 2) + '\n')
}

async function ledgerRecordFor(name: string): Promise<LedgerRecord> {
  return {
    version: '0.1.0',
    source_commit: 'deadbeef',
    content_hash: await hashModuleAtHead(ws, name),
    published_at: '2026-01-01T00:00:00.000Z',
  }
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'straper-drift-'))
  git(['init'])
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 3 })
  vi.restoreAllMocks()
})

describe('computeDrift', () => {
  it('returns empty when there is no ledger (nothing published)', async () => {
    await writeSkill('foo', 'v1')
    commit('add foo')
    expect(await computeDrift(ws)).toEqual({ drifted: [], neverPublished: [], missing: [] })
  })

  it('reports a clean ledger and lists never-published skills as a count source', async () => {
    await writeSkill('foo', 'v1')
    await writeSkill('bar', 'v1')
    commit('add foo + bar')
    await writeLedger({ foo: await ledgerRecordFor('foo') })

    const result = await computeDrift(ws)
    expect(result.drifted).toEqual([])
    expect(result.missing).toEqual([])
    // bar is committed but never published — surfaced as never-published.
    expect(result.neverPublished).toEqual(['bar'])
  })

  it('detects a published module that changed at HEAD (drifted)', async () => {
    await writeSkill('foo', 'v1')
    commit('add foo')
    await writeLedger({ foo: await ledgerRecordFor('foo') })

    // Change foo and commit — its HEAD content hash no longer matches the ledger.
    await writeSkill('foo', 'v2 changed body')
    commit('change foo')

    const result = await computeDrift(ws)
    expect(result.drifted).toEqual(['foo'])
  })

  it('does not flag a published module with uncommitted-only changes', async () => {
    await writeSkill('foo', 'v1')
    commit('add foo')
    await writeLedger({ foo: await ledgerRecordFor('foo') })

    // Dirty working tree only (not committed) — HEAD hash is unchanged.
    await writeSkill('foo', 'v2 uncommitted')

    expect((await computeDrift(ws)).drifted).toEqual([])
  })

  it('reports a ledgered module whose skill dir is gone (missing)', async () => {
    await writeSkill('foo', 'v1')
    commit('add foo')
    const record = await ledgerRecordFor('foo')
    await writeLedger({ foo: record, gone: { ...record } })

    const result = await computeDrift(ws)
    expect(result.missing).toEqual(['gone'])
    expect(result.drifted).toEqual([])
  })
})

describe('drift command (--quiet)', () => {
  it('is silent and does not exit when clean', async () => {
    await writeSkill('foo', 'v1')
    commit('add foo')
    await writeLedger({ foo: await ledgerRecordFor('foo') })

    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await drift({ dir: ws, quiet: true })
    expect(out).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('prints one warning line and exits non-zero on real drift', async () => {
    await writeSkill('foo', 'v1')
    commit('add foo')
    await writeLedger({ foo: await ledgerRecordFor('foo') })
    await writeSkill('foo', 'v2 changed')
    commit('change foo')

    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await drift({ dir: ws, quiet: true })

    expect(written.join('')).toContain('straper publish drift')
    expect(written.join('')).toContain('unpublished: foo')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
