import { describe, it, expect } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Ownership harness: every file under scaffold/ is the runtime baseline and must
// be classified in scaffold/OWNERSHIP.json. A new, unclassified scaffold file
// fails this test — it is unmergeable until someone justifies why the base
// workspace (not a skill module) should ship it.

const SCAFFOLD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scaffold')
const MANIFEST_PATH = join(SCAFFOLD_DIR, 'OWNERSHIP.json')

/** Recursively collect all file paths under a directory, relative to it (posix-style). */
async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(join(dir, entry.name), rel)))
    } else {
      files.push(rel)
    }
  }
  return files
}

interface OwnershipEntry {
  classification: string
  justification: string
}

interface OwnershipManifest {
  manifestVersion: number
  files: Record<string, OwnershipEntry>
}

describe('scaffold ownership manifest', () => {
  it('classifies every file under scaffold/', async () => {
    const manifest: OwnershipManifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf-8'))
    const onDisk = (await walkFiles(SCAFFOLD_DIR)).map((p) => p.split(sep).join('/'))

    const unclassified = onDisk.filter((p) => !(p in manifest.files))
    expect(
      unclassified,
      `Unclassified scaffold files (add to scaffold/OWNERSHIP.json or move to a skill module): ${unclassified.join(', ')}`,
    ).toEqual([])
  })

  it('has no stale manifest entries (every listed file exists)', async () => {
    const manifest: OwnershipManifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf-8'))
    const onDisk = new Set((await walkFiles(SCAFFOLD_DIR)).map((p) => p.split(sep).join('/')))

    const stale = Object.keys(manifest.files).filter((p) => !onDisk.has(p))
    expect(stale, `Manifest lists files that no longer exist: ${stale.join(', ')}`).toEqual([])
  })

  it('every entry is classified "baseline" with a justification', async () => {
    const manifest: OwnershipManifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf-8'))
    for (const [path, entry] of Object.entries(manifest.files)) {
      expect(entry.classification, `${path} must be classified "baseline"`).toBe('baseline')
      expect(
        entry.justification && entry.justification.trim().length,
        `${path} needs a non-empty justification`,
      ).toBeGreaterThan(0)
    }
  })

  it('does not leak skill-owned trees back into scaffold/', async () => {
    // These directories moved to their owning modules; they must never reappear
    // under scaffold/ (they would be silently re-baked into every workspace).
    const onDisk = (await walkFiles(SCAFFOLD_DIR)).map((p) => p.split(sep).join('/'))
    const forbidden = ['schemas/', 'designs/', 'prompts/', 'config/']
    for (const prefix of forbidden) {
      const leaked = onDisk.filter((p) => p.startsWith(prefix))
      expect(leaked, `Skill-owned tree "${prefix}" reappeared in scaffold/`).toEqual([])
    }
    // Individual skill-owned scripts that were extracted to modules.
    const forbiddenScripts = [
      'scripts/task',
      'scripts/validate-tasks.sh',
      'scripts/verify.sh',
      'scripts/worker.sh',
      'scripts/cleanup-workspaces.sh',
      'scripts/sync-pr-status.sh',
      'scripts/create-patch.sh',
      'scripts/lib/node-env.sh',
    ]
    for (const script of forbiddenScripts) {
      expect(onDisk, `Extracted script "${script}" reappeared in scaffold/`).not.toContain(script)
    }
  })
})
