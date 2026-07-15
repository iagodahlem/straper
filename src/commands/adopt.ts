import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import {
  type LockFile,
  type LockFileRef,
  type ModuleManifest,
  agentsDirEnabled,
  baseDirFor,
  buildPointerContent,
  collectDirFiles,
  deriveDescription,
  pointerTargets,
  readLock,
  readManifest,
  resolveRegistryRoot,
  sha256,
  toPosix,
  writeFiles,
  writeLock,
} from './registry-shared.js'

export interface AdoptArgs {
  dir?: string
  registry?: string
}

interface AdoptContext {
  workspaceDir: string
  registryRoot: string
  lock: LockFile
}

interface AdoptSummary {
  adopted: string[]
  differing: string[]
  unmanaged: string[]
  alreadyManaged: string[]
}

/**
 * Onboard an existing workspace into vendored-module management without
 * scaffolding: adopt only skills/<name>/ trees that byte-match a registry module.
 */
export async function adoptWorkspace(args: AdoptArgs): Promise<void> {
  const workspaceDir = resolve(args.dir ?? process.cwd())
  const registryRoot = resolveRegistryRoot({ registry: args.registry })
  const ctx: AdoptContext = { workspaceDir, registryRoot, lock: await readLock(workspaceDir) }

  const summary: AdoptSummary = { adopted: [], differing: [], unmanaged: [], alreadyManaged: [] }
  const registryNames = await listRegistryModules(registryRoot)
  const claimed = new Set<string>(registryNames)
  for (const name of Object.keys(ctx.lock.modules)) claimed.add(name)

  console.log('')
  console.log('straper init --adopt')
  console.log('')

  for (const name of registryNames) {
    if (name in ctx.lock.modules) {
      summary.alreadyManaged.push(name)
      console.log(`  · ${name} already managed`)
      continue
    }

    const skillDir = join(workspaceDir, 'skills', name)
    if (!(await dirExists(skillDir))) continue

    const manifest = await readManifest(registryRoot, name)
    if (manifest.type !== 'skill') continue

    const registryFiles = await collectDirFiles(join(registryRoot, name), { skipRootMeta: true })
    const workingFiles = await collectDirFiles(skillDir)

    if (mapsEqual(registryFiles, workingFiles)) {
      await adoptModule(ctx, name, manifest, skillDir, registryFiles)
      summary.adopted.push(name)
      console.log(`  ✓ adopted ${name}@${manifest.version}`)
    } else {
      summary.differing.push(name)
      console.log(
        `  ~ ${name} differs from registry v${manifest.version} — not adopted ` +
          `(use \`straper add ${name}\` to reinstall or reconcile manually)`,
      )
    }
  }

  for (const name of await listSkillDirs(workspaceDir)) {
    if (claimed.has(name)) continue
    summary.unmanaged.push(name)
    console.log(`  ? ${name} unmanaged (no matching registry module)`)
  }

  await writeLock(workspaceDir, ctx.lock)

  console.log('')
  console.log(
    `adopted ${summary.adopted.length}, differing ${summary.differing.length}, ` +
      `unmanaged ${summary.unmanaged.length}, already managed ${summary.alreadyManaged.length}`,
  )
  console.log('')
}

async function adoptModule(
  ctx: AdoptContext,
  name: string,
  manifest: ModuleManifest,
  skillDir: string,
  registryFiles: Map<string, Buffer>,
): Promise<void> {
  const baseDir = baseDirFor(ctx.workspaceDir, name)
  await rm(baseDir, { recursive: true, force: true })
  await writeFiles(baseDir, ctx.workspaceDir, registryFiles)

  const skillRefs: LockFileRef[] = [...registryFiles.keys()].sort().map((rel) => {
    const destPath = join(skillDir, ...rel.split('/'))
    return {
      path: toPosix(relative(ctx.workspaceDir, destPath)),
      sha256: sha256(registryFiles.get(rel) as Buffer),
    }
  })

  const pointerRefs: LockFileRef[] = []
  for (const pointerPath of pointerTargets(ctx.workspaceDir, name, { agentsDir: agentsDirEnabled() })) {
    pointerRefs.push(await adoptPointer(ctx.workspaceDir, skillDir, pointerPath, name, manifest))
  }

  ctx.lock.modules[name] = {
    version: manifest.version,
    source_commit: manifest.source_commit ?? '',
    type: manifest.type,
    files: [...skillRefs, ...pointerRefs].sort((a, b) => a.path.localeCompare(b.path)),
  }
}

/**
 * Write the consumer pointer only when absent; a workspace may already manage its
 * own. Either way the lock records the bytes actually on disk.
 */
async function adoptPointer(
  workspaceDir: string,
  skillDir: string,
  pointerPath: string,
  name: string,
  manifest: ModuleManifest,
): Promise<LockFileRef> {
  const ref = (bytes: Buffer): LockFileRef => ({
    path: toPosix(relative(workspaceDir, pointerPath)),
    sha256: sha256(bytes),
  })

  const existing = await readFileMaybe(pointerPath)
  if (existing) return ref(existing)

  const bytes = Buffer.from(buildPointerContent(name, await deriveDescription(skillDir, name, manifest)), 'utf-8')
  await mkdir(dirname(pointerPath), { recursive: true })
  await writeFile(pointerPath, bytes)
  return ref(bytes)
}

async function listRegistryModules(registryRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(registryRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (await fileExists(join(registryRoot, entry.name, 'module.json'))) names.push(entry.name)
  }
  return names.sort()
}

async function listSkillDirs(workspaceDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(workspaceDir, 'skills'), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

function mapsEqual(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    const other = b.get(key)
    if (!other || other.length !== value.length || !other.equals(value)) return false
  }
  return true
}

async function readFileMaybe(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch {
    return undefined
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
