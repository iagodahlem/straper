import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { LEDGER_NAME, hashModuleAtHead, readLedgerModules } from './publish.js'

export interface DriftArgs {
  dir?: string
  quiet?: boolean
}

export interface DriftResult {
  drifted: string[]
  neverPublished: string[]
  missing: string[]
}

async function moduleExists(skillsDir: string, module: string): Promise<boolean> {
  try {
    return (await stat(join(skillsDir, module, `${module}.md`))).isFile()
  } catch {
    return false
  }
}

/** Per-skill module names: skills/<name>/ containing <name>.md, sorted. */
async function listSkillModules(skillsDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await moduleExists(skillsDir, entry.name)) names.push(entry.name)
  }
  return names.sort()
}

/**
 * Compare the publish ledger against the workspace at HEAD:
 *   - drifted:        published module whose HEAD content hash no longer matches
 *                     the ledger hash (needs a re-publish).
 *   - neverPublished: a skills/<name>/ module with no ledger entry.
 *   - missing:        a ledgered module whose skills/<name>/ dir is gone.
 * Empty across the board when nothing has been published (no ledger).
 */
export async function computeDrift(workspaceDir: string): Promise<DriftResult> {
  const result: DriftResult = { drifted: [], neverPublished: [], missing: [] }
  const ledgerModules = await readLedgerModules(workspaceDir)
  if (!ledgerModules) return result

  const skillsDir = join(workspaceDir, 'skills')
  const published = new Set(Object.keys(ledgerModules))

  for (const [module, record] of Object.entries(ledgerModules)) {
    if (!(await moduleExists(skillsDir, module))) {
      result.missing.push(module)
      continue
    }
    const ledgerHash = record?.content_hash
    if (!ledgerHash) continue // ledger entry without a hash — nothing to compare
    let currentHash: string
    try {
      currentHash = await hashModuleAtHead(workspaceDir, module)
    } catch {
      continue // uncommitted / unstageable — can't trust a drift signal
    }
    if (currentHash !== ledgerHash) result.drifted.push(module)
  }

  for (const module of await listSkillModules(skillsDir)) {
    if (!published.has(module)) result.neverPublished.push(module)
  }

  result.drifted.sort()
  result.neverPublished.sort()
  result.missing.sort()
  return result
}

/**
 * `straper drift` — compare skills/<module>/ at HEAD against the publish ledger.
 * Exit 0 when there is no ACTIONABLE drift (drifted / missing); a never-published
 * skill alone is a count, not an error. `--quiet` mirrors the upstream boot
 * reminder: silent when clean, one warning line on drift.
 */
export async function drift(args: DriftArgs): Promise<void> {
  const workspaceDir = resolve(args.dir ?? process.cwd())
  const { drifted, neverPublished, missing } = await computeDrift(workspaceDir)
  const actionable = drifted.length > 0 || missing.length > 0

  if (args.quiet) {
    if (!actionable) return // clean → silent (never-published alone is not drift)
    const parts: string[] = []
    if (drifted.length > 0) parts.push(`unpublished: ${drifted.join(', ')}`)
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
    if (neverPublished.length > 0) parts.push(`never published: ${neverPublished.length} skill(s)`)
    process.stdout.write(`⚠ straper publish drift — ${parts.join(' · ')}\n`)
    process.exit(1)
  }

  console.log('')
  console.log('straper drift')
  console.log('')

  const ledgerModules = await readLedgerModules(workspaceDir)
  if (ledgerModules === null) {
    console.log(
      `  no publish ledger (${LEDGER_NAME}) — nothing published from this workspace yet.`,
    )
    console.log('')
    return
  }

  if (!actionable) {
    const count = Object.keys(ledgerModules).length
    console.log(`  ✓ no drift — ${count} published module(s) match the ledger.`)
    if (neverPublished.length > 0) {
      console.log(`  · ${neverPublished.length} never-published skill(s) (not an error).`)
    }
    console.log('')
    return
  }

  for (const module of drifted) {
    console.log(
      `  ✗ ${module} drifted — skills/${module}/ changed since last publish (re-publish needed)`,
    )
  }
  for (const module of missing) {
    console.log(`  ✗ ${module} missing — ledgered but skills/${module}/ is gone`)
  }
  if (neverPublished.length > 0) {
    console.log(`  · ${neverPublished.length} never-published skill(s) (not an error).`)
  }
  console.log('')
  console.log(`${drifted.length + missing.length} drift issue(s) found.`)
  process.exit(1)
}
