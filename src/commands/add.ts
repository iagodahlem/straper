import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { installModuleHooks } from './hooks-install.js'
import {
  type LockFile,
  type LockFileRef,
  type ModuleManifest,
  agentsDirEnabled,
  baseDirFor,
  buildPointerContent,
  collectDirFiles,
  dedupe,
  deriveDescription,
  error,
  pointerTargets,
  readLock,
  readManifest,
  resolveRegistryRoot,
  sha256,
  toPosix,
  writeFiles,
  writeLock,
} from './registry-shared.js'

export interface AddArgs {
  modules: string[]
  dir?: string
  registry?: string
  noAgentsDir?: boolean
}

export { resolveRegistryRoot }

interface AddContext {
  workspaceDir: string
  registryRoot: string
  lock: LockFile
  installed: Map<string, ModuleManifest>
  agentsDir: boolean
}

/**
 * Vendor one or more registry modules into a workspace (copy + lockfile).
 */
export async function add(args: AddArgs): Promise<void> {
  const workspaceDir = resolve(args.dir ?? process.cwd())
  const registryRoot = resolveRegistryRoot({ registry: args.registry })

  const ctx: AddContext = {
    workspaceDir,
    registryRoot,
    lock: await readLock(workspaceDir),
    installed: new Map(),
    agentsDir: agentsDirEnabled(args.noAgentsDir),
  }

  const requested = dedupe(args.modules)

  for (const name of requested) {
    const newlyInstalled: string[] = []
    await installModule(name, ctx, [], newlyInstalled)
    const manifest = ctx.installed.get(name)
    if (!manifest) continue
    const depCount = newlyInstalled.filter((installed) => installed !== name).length
    console.log(`added ${name}@${manifest.version} (+${depCount} dep${depCount === 1 ? '' : 's'})`)
  }

  await writeLock(workspaceDir, ctx.lock)
}

async function installModule(
  name: string,
  ctx: AddContext,
  stack: string[],
  newlyInstalled: string[],
): Promise<void> {
  if (ctx.installed.has(name)) return
  if (stack.includes(name)) {
    error(`Dependency cycle detected: ${[...stack, name].join(' -> ')}`)
  }

  const manifest = await readManifest(ctx.registryRoot, name)

  if (manifest.type !== 'skill') {
    error(
      `Module "${name}" has type "${manifest.type}", which cannot be added yet. Only "skill" modules are supported.`,
    )
  }

  for (const dep of manifest.deps ?? []) {
    await installModule(dep, ctx, [...stack, name], newlyInstalled)
  }

  await vendorModule(ctx, name, manifest)
  ctx.installed.set(name, manifest)
  newlyInstalled.push(name)
}

async function vendorModule(
  ctx: AddContext,
  name: string,
  manifest: ModuleManifest,
): Promise<void> {
  const moduleDir = join(ctx.registryRoot, name)
  const skillDir = join(ctx.workspaceDir, 'skills', name)
  const baseDir = baseDirFor(ctx.workspaceDir, name)

  const moduleFiles = await collectDirFiles(moduleDir, { skipRootMeta: true })

  const files = await writeFiles(skillDir, ctx.workspaceDir, moduleFiles)

  // Pristine base store mirrors the published bytes — the merge baseline for `update`.
  await rm(baseDir, { recursive: true, force: true })
  await writeFiles(baseDir, ctx.workspaceDir, moduleFiles)

  const description = await deriveDescription(skillDir, name, manifest)
  const bytes = Buffer.from(buildPointerContent(name, description), 'utf-8')
  for (const pointerPath of pointerTargets(ctx.workspaceDir, name, { agentsDir: ctx.agentsDir })) {
    files.push(await emitSkillPointer(ctx.workspaceDir, pointerPath, bytes))
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  // Splice any module-contributed hooks (skills/<name>/hooks.json) into the
  // workspace's .claude/settings.json; record them in the lock for update/doctor.
  const hooks = await installModuleHooks(ctx.workspaceDir, skillDir, name)

  ctx.lock.modules[name] = {
    version: manifest.version,
    source_commit: manifest.source_commit ?? '',
    type: manifest.type,
    files,
    ...(hooks.length > 0 ? { hooks } : {}),
  }
}

/**
 * Emit a consumer skill pointer (SKILL.md) so the consuming agent surfaces the
 * skill; a bare copy under skills/ does not register. Callers fan this out to the
 * Claude pointer and the universal .agents pointer with identical bytes.
 */
async function emitSkillPointer(
  workspaceDir: string,
  pointerPath: string,
  bytes: Buffer,
): Promise<LockFileRef> {
  await mkdir(dirname(pointerPath), { recursive: true })
  await writeFile(pointerPath, bytes)
  return { path: toPosix(relative(workspaceDir, pointerPath)), sha256: sha256(bytes) }
}
