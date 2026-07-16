import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { InstalledHook } from './registry-shared.js'

// ---------------------------------------------------------------------------
// Module-contributed hooks installer.
//
// A skill module may ship a `hooks.json` (see registry/auto-commit/hooks.json)
// declaring hook entries it wants wired into the consuming workspace's harness
// config. `add`/`update` splice those entries into `.claude/settings.json` with
// a surgical JSON merge that preserves everything the user already has there.
//
// Ownership is tracked in the lock (the module's `hooks` array), not by mutating
// the settings schema with markers — so re-add is idempotent, `update` can
// replace prior entries, and `doctor` can flag a lock-recorded hook that has
// gone missing. A hook signature is (event, matcher, command).
// ---------------------------------------------------------------------------

interface HookDecl {
  event?: unknown
  matcher?: unknown
  command?: unknown
}

interface HooksJson {
  hooks?: HookDecl[]
}

interface CommandHookEntry {
  type?: string
  command?: string
  [k: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks?: CommandHookEntry[]
  [k: string]: unknown
}

interface Settings {
  hooks?: Record<string, HookGroup[]>
  [k: string]: unknown
}

function settingsPath(workspaceDir: string): string {
  return join(workspaceDir, '.claude', 'settings.json')
}

/** Declared hook entries from a module's hooks.json (empty when absent/invalid). */
async function readHookDecls(skillDir: string, name: string): Promise<InstalledHook[]> {
  let raw: string
  try {
    raw = await readFile(join(skillDir, 'hooks.json'), 'utf-8')
  } catch {
    return [] // no hooks.json — nothing to install
  }
  let parsed: HooksJson
  try {
    parsed = JSON.parse(raw) as HooksJson
  } catch {
    process.stderr.write(`Warning: skills/${name}/hooks.json is not valid JSON — skipping hooks.\n`)
    return []
  }
  const decls: InstalledHook[] = []
  for (const h of parsed.hooks ?? []) {
    if (typeof h.event !== 'string' || typeof h.command !== 'string') continue
    decls.push({
      event: h.event,
      matcher: typeof h.matcher === 'string' ? h.matcher : '',
      command: h.command,
    })
  }
  return decls
}

async function readSettings(workspaceDir: string): Promise<{ settings: Settings; existed: boolean }> {
  try {
    const raw = await readFile(settingsPath(workspaceDir), 'utf-8')
    return { settings: JSON.parse(raw) as Settings, existed: true }
  } catch {
    return { settings: {}, existed: false }
  }
}

async function writeSettings(workspaceDir: string, settings: Settings): Promise<void> {
  const path = settingsPath(workspaceDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}

function groupMatcher(group: HookGroup): string {
  return typeof group.matcher === 'string' ? group.matcher : ''
}

/** Splice one hook into settings, creating the event list / matcher group as
 *  needed. No-op when an identical (type=command, command) entry already sits
 *  under the same matcher — that is what keeps re-add idempotent. */
function mergeHook(settings: Settings, hook: InstalledHook): void {
  if (!settings.hooks) settings.hooks = {}
  const list = settings.hooks[hook.event] ?? (settings.hooks[hook.event] = [])
  let group = list.find((g) => groupMatcher(g) === hook.matcher)
  if (!group) {
    group = { matcher: hook.matcher, hooks: [] }
    list.push(group)
  }
  if (!group.hooks) group.hooks = []
  const present = group.hooks.some((e) => e.type === 'command' && e.command === hook.command)
  if (!present) group.hooks.push({ type: 'command', command: hook.command })
}

/** Remove one previously-installed hook. Only the module's command entry is
 *  stripped — a group shared with baseline/user commands is preserved; a group
 *  we leave empty is dropped so settings does not accrete dead scaffolding. */
function removeHook(settings: Settings, hook: InstalledHook): void {
  const list = settings.hooks?.[hook.event]
  if (!list) return
  for (let i = list.length - 1; i >= 0; i--) {
    const group = list[i]
    if (groupMatcher(group) !== hook.matcher) continue
    if (!Array.isArray(group.hooks)) continue
    group.hooks = group.hooks.filter((e) => !(e.type === 'command' && e.command === hook.command))
    if (group.hooks.length === 0) list.splice(i, 1)
  }
  if (list.length === 0 && settings.hooks) delete settings.hooks[hook.event]
}

function hookPresent(settings: Settings, hook: InstalledHook): boolean {
  const list = settings.hooks?.[hook.event]
  if (!list) return false
  return list.some(
    (g) =>
      groupMatcher(g) === hook.matcher &&
      Array.isArray(g.hooks) &&
      g.hooks.some((e) => e.type === 'command' && e.command === hook.command),
  )
}

/**
 * Install a module's declared hooks into `.claude/settings.json` (idempotent).
 * Returns the installed signatures for the caller to record in the lock. When
 * the module ships no hooks.json, this is a no-op and returns [].
 */
export async function installModuleHooks(
  workspaceDir: string,
  skillDir: string,
  name: string,
): Promise<InstalledHook[]> {
  const decls = await readHookDecls(skillDir, name)
  if (decls.length === 0) return []
  const { settings } = await readSettings(workspaceDir)
  for (const hook of decls) mergeHook(settings, hook)
  await writeSettings(workspaceDir, settings)
  return decls
}

/**
 * Replace a module's hooks: strip the previously-installed signatures (from the
 * lock), then splice the module's current declarations. Used by `update`, whose
 * new hooks.json may have changed the command/matcher of an entry.
 */
export async function replaceModuleHooks(
  workspaceDir: string,
  skillDir: string,
  name: string,
  previous: InstalledHook[],
): Promise<InstalledHook[]> {
  const decls = await readHookDecls(skillDir, name)
  if (previous.length === 0 && decls.length === 0) return []
  const { settings } = await readSettings(workspaceDir)
  for (const hook of previous) removeHook(settings, hook)
  for (const hook of decls) mergeHook(settings, hook)
  await writeSettings(workspaceDir, settings)
  return decls
}

/**
 * Lock-recorded hooks that are no longer present in settings.json — a signal
 * that the wiring was hand-removed or clobbered. Read-only; used by `doctor`.
 */
export async function findMissingHooks(
  workspaceDir: string,
  hooks: InstalledHook[] | undefined,
): Promise<InstalledHook[]> {
  if (!hooks || hooks.length === 0) return []
  const { settings } = await readSettings(workspaceDir)
  return hooks.filter((hook) => !hookPresent(settings, hook))
}
