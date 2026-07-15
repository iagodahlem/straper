import { readFile, writeFile, mkdir, readdir, stat, copyFile, constants } from 'node:fs/promises'
import { join, basename, dirname, relative } from 'node:path'

export interface TemplateVariables {
  agent_name: string
  agent_display_name: string
  user_name: string
  user_role: string
  project_name: string
  project_description: string
  workspace_dir: string
  year: string
}

const VARIABLE_RE = /\{\{(\w+)\}\}/g

const VALID_KEYS: ReadonlySet<string> = new Set<keyof TemplateVariables>([
  'agent_name',
  'agent_display_name',
  'user_name',
  'user_role',
  'project_name',
  'project_description',
  'workspace_dir',
  'year',
])

/**
 * Replace all {{variable}} placeholders in a string.
 * Throws if a placeholder references an unknown variable.
 */
export function renderTemplate(content: string, vars: TemplateVariables): string {
  return content.replace(VARIABLE_RE, (match, key: string) => {
    if (!VALID_KEYS.has(key)) {
      throw new Error(`Unknown template variable: {{${key}}}`)
    }
    return vars[key as keyof TemplateVariables]
  })
}

/**
 * Replace {{agent_name}} in a filename (not the full content rendering, just the name portion).
 */
function renameWithVars(filename: string, vars: TemplateVariables): string {
  return filename.replace(/\{\{agent_name\}\}/g, vars.agent_name)
}

/**
 * Process a single .tmpl file: read it, render variables, write output.
 * Output path = input path with .tmpl extension stripped.
 * e.g., "SOUL.md.tmpl" -> "SOUL.md"
 */
export async function processTemplate(
  templatePath: string,
  outputDir: string,
  vars: TemplateVariables,
): Promise<string> {
  const content = await readFile(templatePath, 'utf-8')
  const rendered = renderTemplate(content, vars)

  let outputName = basename(templatePath).replace(/\.tmpl$/, '')
  outputName = renameWithVars(outputName, vars)

  const outputPath = join(outputDir, outputName)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, rendered, 'utf-8')

  return outputPath
}

/**
 * Copy a file or directory from source to destination.
 * If a filename contains {{agent_name}}, replace it.
 * e.g., "{{agent_name}}.js" -> "nova.js"
 */
export async function copyWithRename(
  source: string,
  dest: string,
  vars: TemplateVariables,
): Promise<void> {
  const info = await stat(source)

  if (info.isDirectory()) {
    await mkdir(dest, { recursive: true })
    const entries = await readdir(source)
    for (const entry of entries) {
      const renamedEntry = renameWithVars(entry, vars)
      await copyWithRename(join(source, entry), join(dest, renamedEntry), vars)
    }
  } else {
    await mkdir(dirname(dest), { recursive: true })
    // COPYFILE_EXCL is not used so we allow overwrite; mode is preserved by copyFile
    await copyFile(source, dest, constants.COPYFILE_FICLONE)

    // Preserve permissions explicitly
    const { mode } = info
    const { chmod } = await import('node:fs/promises')
    await chmod(dest, mode)
  }
}

/**
 * Process an entire scaffold directory:
 * - .tmpl files -> render and write (strip .tmpl extension)
 * - Other files -> copy as-is (with filename variable substitution)
 * - Directories -> recurse
 * - Skip .gitkeep files
 */
export async function processScaffoldDir(
  scaffoldDir: string,
  outputDir: string,
  vars: TemplateVariables,
): Promise<string[]> {
  const created: string[] = []

  async function walk(srcDir: string, destDir: string): Promise<void> {
    await mkdir(destDir, { recursive: true })
    const entries = await readdir(srcDir)

    for (const entry of entries) {
      // Skip .gitkeep files
      if (entry === '.gitkeep') continue

      const srcPath = join(srcDir, entry)
      const info = await stat(srcPath)

      if (info.isDirectory()) {
        const renamedDir = renameWithVars(entry, vars)
        await walk(srcPath, join(destDir, renamedDir))
      } else if (entry.endsWith('.tmpl')) {
        const outputPath = await processTemplate(srcPath, destDir, vars)
        created.push(relative(outputDir, outputPath))
      } else {
        const renamedFile = renameWithVars(entry, vars)
        const destPath = join(destDir, renamedFile)
        await copyWithRename(srcPath, destPath, vars)
        created.push(relative(outputDir, destPath))
      }
    }
  }

  await walk(scaffoldDir, outputDir)
  return created.sort()
}
