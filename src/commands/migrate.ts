import { resolve } from 'node:path'

import { type AddContext, installModule } from './add.js'
import {
  agentsDirEnabled,
  listRegistryModules,
  listSkillDirs,
  readLock,
  readManifest,
  resolveRegistryRoot,
  writeLock,
} from './registry-shared.js'

export interface MigrateArgs {
  dir?: string
  registry?: string
  dryRun?: boolean
}

interface MigrateSummary {
  migrated: string[]
  unmatched: string[]
  alreadyManaged: string[]
}

/**
 * Migrate a pre-registry workspace onto the registry model.
 *
 * A pre-registry workspace has baked-in `skills/<name>/` trees with no
 * `straper.lock` and no `.straper/base/` — they were copied in whole at
 * scaffold time, not vendored. For each such tree whose name matches a
 * published registry module, migrate vendors it through the exact install
 * path `straper add` uses (`installModule`): fresh registry bytes replace the
 * old baked-in copy, transitive registry dependencies are pulled in, a
 * pristine `.straper/base/<name>/` baseline is written, consumer pointers are
 * emitted, and the module is recorded in `straper.lock`. A local skill with no
 * same-named registry module is custom — it is left completely untouched and
 * reported, never deleted or merged. A skill already present in the lock is
 * treated as already migrated and skipped, which is what makes re-running
 * migrate on a workspace safe: nothing outside `skills/`, `straper.lock`,
 * `.straper/base/`, and the consumer pointers is ever touched, so the
 * baseline scaffold surface tracked in `scaffold/OWNERSHIP.json` (AGENTS.md,
 * TOOLS.md, scripts/, etc.) is never a concern here.
 */
export async function migrate(args: MigrateArgs): Promise<void> {
  const workspaceDir = resolve(args.dir ?? process.cwd())
  const registryRoot = resolveRegistryRoot({ registry: args.registry })
  const dryRun = args.dryRun ?? false
  const lock = await readLock(workspaceDir)

  console.log('')
  console.log('straper migrate')
  console.log('')

  const skillNames = await listSkillDirs(workspaceDir)
  if (skillNames.length === 0) {
    console.log('  no skills/ directory found — nothing to migrate')
    console.log('')
    return
  }

  const registryNames = new Set(await listRegistryModules(registryRoot))
  const summary: MigrateSummary = { migrated: [], unmatched: [], alreadyManaged: [] }
  const toMigrate: string[] = []

  for (const name of skillNames) {
    if (name in lock.modules) {
      summary.alreadyManaged.push(name)
      console.log(`  · ${name} already managed`)
      continue
    }
    if (!registryNames.has(name)) {
      summary.unmatched.push(name)
      console.log(`  ? ${name} no matching registry module — left untouched`)
      continue
    }
    toMigrate.push(name)
  }

  if (dryRun) {
    for (const name of toMigrate) {
      const manifest = await readManifest(registryRoot, name)
      const depCount = (manifest.deps ?? []).length
      const depNote = depCount > 0 ? ` (+${depCount} dep${depCount === 1 ? '' : 's'})` : ''
      console.log(`  → would migrate ${name} to registry v${manifest.version}${depNote}`)
    }
    console.log('')
    console.log(
      `would migrate ${toMigrate.length}, unmatched ${summary.unmatched.length}, ` +
        `already managed ${summary.alreadyManaged.length}`,
    )
    console.log('')
    console.log('No files were modified. Run without --dry-run to perform the migration.')
    console.log('')
    return
  }

  const ctx: AddContext = {
    workspaceDir,
    registryRoot,
    lock,
    installed: new Map(),
    agentsDir: agentsDirEnabled(),
  }

  for (const name of toMigrate) {
    if (ctx.installed.has(name)) {
      // Already vendored earlier in this run, as a dependency of a prior match.
      const manifest = ctx.installed.get(name)
      if (!manifest) continue
      summary.migrated.push(name)
      console.log(`  ✓ migrated ${name}@${manifest.version} (installed as a dependency)`)
      continue
    }

    const newlyInstalled: string[] = []
    await installModule(name, ctx, [], newlyInstalled)
    const manifest = ctx.installed.get(name)
    if (!manifest) continue
    summary.migrated.push(name)
    const depCount = newlyInstalled.filter((installed) => installed !== name).length
    const depNote = depCount > 0 ? ` (+${depCount} dep${depCount === 1 ? '' : 's'})` : ''
    console.log(`  ✓ migrated ${name}@${manifest.version}${depNote}`)
  }

  await writeLock(workspaceDir, ctx.lock)

  console.log('')
  console.log(
    `migrated ${summary.migrated.length}, unmatched ${summary.unmatched.length}, ` +
      `already managed ${summary.alreadyManaged.length}`,
  )
  console.log('')
}
