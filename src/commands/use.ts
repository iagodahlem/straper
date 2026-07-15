import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectDirFiles,
  error as exitWithError,
  isNodeError,
  readManifest,
  resolveRegistryRoot,
  writeFiles,
} from './registry-shared.js'

export interface UseArgs {
  module: string
  dir?: string
  registry?: string
}

/** Failure that must unwind through the temp-cleanup finally block (not process.exit). */
class UseError extends Error {}

function fail(message: string): never {
  throw new UseError(message)
}

/**
 * Materialize a registry skill (and its transitive deps) into a disposable temp
 * dir and print a ready-to-pipe prompt. Nothing is installed: no lock, no
 * pointers, no writes into any workspace.
 */
export async function use(args: UseArgs): Promise<void> {
  try {
    await usePipeline(args)
  } catch (err) {
    // Temp cleanup (finally) has already run; only now convert to exit(1).
    if (err instanceof UseError) exitWithError(err.message)
    throw err
  }
}

async function usePipeline(args: UseArgs): Promise<void> {
  const registryRoot = resolveRegistryRoot({ registry: args.registry })

  // Resolve the whole closure before creating any temp dir so a missing module,
  // bad type, or cycle fails with nothing to clean up.
  const order = await resolveModuleOrder(registryRoot, args.module)
  const deps = order.filter((name) => name !== args.module)

  const tempDir = await mkdtemp(join(tmpdir(), `straper-use-${args.module}-`))
  let kept = false
  try {
    for (const name of order) {
      const files = await collectDirFiles(join(registryRoot, name), { skipRootMeta: true })
      await writeFiles(join(tempDir, name), tempDir, files)
    }

    let mainMd: string
    try {
      mainMd = await readFile(join(tempDir, args.module, `${args.module}.md`), 'utf-8')
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        fail(`Module "${args.module}" has no ${args.module}.md — cannot use it.`)
      }
      throw err
    }

    console.log(buildPrompt(args.module, mainMd, tempDir, deps, isAgentSession()))
    kept = true
  } finally {
    if (!kept) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** Topologically ordered closure (deps first, module last) with cycle + type guards. */
async function resolveModuleOrder(registryRoot: string, module: string): Promise<string[]> {
  const order: string[] = []
  const done = new Set<string>()

  const visit = async (name: string, stack: string[]): Promise<void> => {
    if (done.has(name)) return
    if (stack.includes(name)) {
      fail(`Dependency cycle detected: ${[...stack, name].join(' -> ')}`)
    }
    const manifest = await readManifest(registryRoot, name)
    if (manifest.type !== 'skill') {
      fail(
        `Module "${name}" has type "${manifest.type}", which cannot be used. Only "skill" modules are supported.`,
      )
    }
    for (const dep of manifest.deps ?? []) {
      await visit(dep, [...stack, name])
    }
    done.add(name)
    order.push(name)
  }

  await visit(module, [])
  return order
}

/**
 * Claude Code sets these; when present, emit banner-free output for clean
 * programmatic consumption. straper has no interactive prompts, so there is
 * nothing else to suppress.
 */
function isAgentSession(): boolean {
  return Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT)
}

function buildPrompt(
  module: string,
  mainMd: string,
  tempDir: string,
  deps: string[],
  plain: boolean,
): string {
  const out: string[] = []
  if (!plain) {
    out.push(`straper use — ephemeral trial of ${module} (nothing installed)`)
    out.push('')
  }
  out.push(`You have the following skill available for this session: ${module}.`)
  out.push('')
  out.push(mainMd.trimEnd())
  out.push('')
  out.push(`Supporting files for ${module} live under: ${join(tempDir, module)}`)
  if (deps.length > 0) {
    const list = deps.map((dep) => `${dep} (${join(tempDir, dep)})`).join(', ')
    out.push(`Its dependencies are also available: ${list}`)
  }
  out.push('')
  out.push(
    'This directory is disposable — it lives in the OS temp dir and nothing was installed into your workspace; remove it anytime.',
  )
  return out.join('\n')
}
