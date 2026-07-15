import { access, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { type WorkspaceEntry, readWorkspaces } from '../config.js'

/**
 * Show health status of all registered Straper workspaces.
 */
export async function status(): Promise<void> {
  const registry = await readWorkspaces()

  if (registry.workspaces.length === 0) {
    console.log('No workspaces registered. Run `straper init <name>` to create one.')
    return
  }

  console.log('')
  console.log('Straper workspaces:')

  const nameWidth = Math.max(...registry.workspaces.map((w) => w.name.length))

  for (const workspace of registry.workspaces) {
    const checks = await checkWorkspace(workspace)
    printWorkspace(workspace, checks, nameWidth)
  }

  const count = registry.workspaces.length
  console.log(`${count} workspace${count === 1 ? '' : 's'} registered`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Workspace health checks
// ---------------------------------------------------------------------------

interface WorkspaceChecks {
  directoryExists: boolean
  activeTasks: number | null
  openDesigns: number | null
  activeWorktrees: number | null
}

async function checkWorkspace(workspace: WorkspaceEntry): Promise<WorkspaceChecks> {
  const dir = expandPath(workspace.path)

  const directoryExists = await directoryExistsAt(dir)

  if (!directoryExists) {
    return {
      directoryExists: false,
      activeTasks: null,
      openDesigns: null,
      activeWorktrees: null,
    }
  }

  const [activeTasks, openDesigns, activeWorktrees] = await Promise.all([
    countActiveTasks(dir),
    countOpenDesigns(dir),
    countActiveWorktrees(dir),
  ])

  return { directoryExists, activeTasks, openDesigns, activeWorktrees }
}

/**
 * Count task files with status != "done".
 * Reads tasks/TASK-*.json, parses each, checks the status field.
 */
async function countActiveTasks(workspaceDir: string): Promise<number> {
  const tasksDir = join(workspaceDir, 'tasks')

  let entries: string[]
  try {
    entries = await readdir(tasksDir)
  } catch {
    return 0
  }

  const taskFiles = entries.filter((e) => /^TASK-\d+\.json$/.test(e))
  let count = 0

  for (const file of taskFiles) {
    try {
      const raw = await readFile(join(tasksDir, file), 'utf-8')
      const task = JSON.parse(raw) as { status?: string }
      if (task.status && task.status !== 'done') {
        count++
      }
    } catch {
      // Malformed task file — skip
    }
  }

  return count
}

/**
 * Count open designs by counting FD-*.md files in designs/.
 */
async function countOpenDesigns(workspaceDir: string): Promise<number> {
  const designsDir = join(workspaceDir, 'designs')

  let entries: string[]
  try {
    entries = await readdir(designsDir)
  } catch {
    return 0
  }

  return entries.filter((e) => /^FD-\d+\.md$/.test(e)).length
}

/**
 * Count active worktrees by counting directories in workspaces/.
 */
async function countActiveWorktrees(workspaceDir: string): Promise<number> {
  const worktreesDir = join(workspaceDir, 'workspaces')

  let entries: string[]
  try {
    entries = await readdir(worktreesDir)
  } catch {
    return 0
  }

  let count = 0
  for (const entry of entries) {
    // Skip hidden files and .gitkeep
    if (entry.startsWith('.')) continue
    try {
      const info = await stat(join(worktreesDir, entry))
      if (info.isDirectory()) {
        count++
      }
    } catch {
      // Skip entries we can't stat
    }
  }

  return count
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printWorkspace(
  workspace: WorkspaceEntry,
  checks: WorkspaceChecks,
  nameWidth: number,
): void {
  const displayPath = collapsePath(workspace.path)
  const paddedName = workspace.name.padEnd(nameWidth)

  console.log('')
  console.log(`  ${paddedName}  ${displayPath}`)

  if (!checks.directoryExists) {
    console.log('    \u2717 Directory not found')
    return
  }

  console.log('    \u2713 Directory exists')
  console.log(`    \u2713 ${checks.activeTasks} active task${checks.activeTasks === 1 ? '' : 's'}`)
  console.log(
    `    \u2713 ${checks.openDesigns} open design${checks.openDesigns === 1 ? '' : 's'}`,
  )
  console.log(
    `    \u2713 ${checks.activeWorktrees} active worktree${checks.activeWorktrees === 1 ? '' : 's'}`,
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function directoryExistsAt(path: string): Promise<boolean> {
  try {
    await access(path)
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Expand ~ to the home directory.
 */
function expandPath(p: string): string {
  const home = homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

/**
 * Collapse the home directory prefix to ~ for display.
 */
function collapsePath(p: string): string {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1)
  return p
}
