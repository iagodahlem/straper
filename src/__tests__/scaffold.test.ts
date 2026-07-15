import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  renderTemplate,
  processTemplate,
  copyWithRename,
  processScaffoldDir,
  type TemplateVariables,
} from '../scaffold.js'

const vars: TemplateVariables = {
  agent_name: 'nova',
  agent_display_name: 'Nova',
  user_name: 'Alice Smith',
  user_role: 'Software Engineer',
  project_name: 'Acme Support',
  project_description: 'Customer support agent',
  workspace_dir: '/home/user/nova',
  year: '2026',
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'scaffold-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------
describe('renderTemplate', () => {
  it('replaces a single variable', () => {
    expect(renderTemplate('Hello {{agent_name}}', vars)).toBe('Hello nova')
  })

  it('replaces multiple different variables', () => {
    const input = '{{agent_display_name}} by {{user_name}} ({{year}})'
    expect(renderTemplate(input, vars)).toBe('Nova by Alice Smith (2026)')
  })

  it('replaces the same variable appearing multiple times', () => {
    const input = '{{agent_name}} and {{agent_name}} again'
    expect(renderTemplate(input, vars)).toBe('nova and nova again')
  })

  it('throws on unknown variable {{foo}}', () => {
    expect(() => renderTemplate('Hello {{foo}}', vars)).toThrow(
      'Unknown template variable: {{foo}}',
    )
  })

  it('handles content with no placeholders (passthrough)', () => {
    const plain = 'No variables here, just text.'
    expect(renderTemplate(plain, vars)).toBe(plain)
  })

  it('handles empty string', () => {
    expect(renderTemplate('', vars)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// processTemplate
// ---------------------------------------------------------------------------
describe('processTemplate', () => {
  it('reads .tmpl file, renders, writes output without .tmpl extension', async () => {
    const tmplPath = join(tmpDir, 'SOUL.md.tmpl')
    await writeFile(tmplPath, '# {{agent_display_name}}\nBy {{user_name}}', 'utf-8')

    const outputDir = join(tmpDir, 'out')
    await mkdir(outputDir, { recursive: true })

    const outputPath = await processTemplate(tmplPath, outputDir, vars)

    expect(outputPath).toBe(join(outputDir, 'SOUL.md'))
    const content = await readFile(outputPath, 'utf-8')
    expect(content).toBe('# Nova\nBy Alice Smith')
  })

  it('output content has all variables substituted', async () => {
    const tmplPath = join(tmpDir, 'config.yml.tmpl')
    await writeFile(
      tmplPath,
      'name: {{agent_name}}\ndisplay: {{agent_display_name}}\nproject: {{project_name}}\ndesc: {{project_description}}\ndir: {{workspace_dir}}\nyear: {{year}}',
      'utf-8',
    )

    const outputDir = join(tmpDir, 'out')
    await mkdir(outputDir, { recursive: true })

    const outputPath = await processTemplate(tmplPath, outputDir, vars)
    const content = await readFile(outputPath, 'utf-8')

    expect(content).not.toMatch(/\{\{/)
    expect(content).toContain('name: nova')
    expect(content).toContain('display: Nova')
    expect(content).toContain('project: Acme Support')
    expect(content).toContain('desc: Customer support agent')
    expect(content).toContain('dir: /home/user/nova')
    expect(content).toContain('year: 2026')
    expect(outputPath.endsWith('.yml')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// copyWithRename
// ---------------------------------------------------------------------------
describe('copyWithRename', () => {
  it('copies file preserving content', async () => {
    const src = join(tmpDir, 'hello.txt')
    await writeFile(src, 'hello world', 'utf-8')

    const dest = join(tmpDir, 'out', 'hello.txt')
    await copyWithRename(src, dest, vars)

    const content = await readFile(dest, 'utf-8')
    expect(content).toBe('hello world')
  })

  it('renames filename containing {{agent_name}}', async () => {
    const src = join(tmpDir, '{{agent_name}}.sh')
    await writeFile(src, '#!/bin/bash\necho hi', 'utf-8')

    const renamedDest = join(tmpDir, 'out', 'nova.sh')
    // The caller is responsible for renaming in the dest path; copyWithRename copies to dest as given.
    // So let's test through processScaffoldDir for the rename flow.
    // Here we test that copyWithRename copies content correctly to the given dest.
    await copyWithRename(src, renamedDest, vars)

    const content = await readFile(renamedDest, 'utf-8')
    expect(content).toBe('#!/bin/bash\necho hi')
  })

  it('preserves file permissions (executable scripts)', async () => {
    const src = join(tmpDir, 'run.sh')
    await writeFile(src, '#!/bin/bash\necho hello', 'utf-8')
    await chmod(src, 0o755)

    const dest = join(tmpDir, 'out', 'run.sh')
    await copyWithRename(src, dest, vars)

    const info = await stat(dest)
    // Check that executable bit is set (owner execute)
    expect(info.mode & 0o111).toBeGreaterThan(0)
  })

  it('copies a directory recursively', async () => {
    const srcDir = join(tmpDir, 'nested')
    await mkdir(join(srcDir, 'sub'), { recursive: true })
    await writeFile(join(srcDir, 'a.txt'), 'file a', 'utf-8')
    await writeFile(join(srcDir, 'sub', 'b.txt'), 'file b', 'utf-8')

    const destDir = join(tmpDir, 'out-dir')
    await copyWithRename(srcDir, destDir, vars)

    expect(await readFile(join(destDir, 'a.txt'), 'utf-8')).toBe('file a')
    expect(await readFile(join(destDir, 'sub', 'b.txt'), 'utf-8')).toBe('file b')
  })
})

// ---------------------------------------------------------------------------
// processScaffoldDir
// ---------------------------------------------------------------------------
describe('processScaffoldDir', () => {
  let scaffoldDir: string
  let outputDir: string

  beforeEach(async () => {
    scaffoldDir = join(tmpDir, 'scaffold')
    outputDir = join(tmpDir, 'workspace')
    await mkdir(scaffoldDir, { recursive: true })
  })

  it('processes nested directory structure', async () => {
    await mkdir(join(scaffoldDir, 'memory'), { recursive: true })
    await writeFile(join(scaffoldDir, 'README.md'), 'readme', 'utf-8')
    await writeFile(join(scaffoldDir, 'memory', 'notes.txt'), 'notes', 'utf-8')

    const created = await processScaffoldDir(scaffoldDir, outputDir, vars)

    expect(created).toContain('README.md')
    expect(created).toContain(join('memory', 'notes.txt'))
    expect(await readFile(join(outputDir, 'README.md'), 'utf-8')).toBe('readme')
    expect(await readFile(join(outputDir, 'memory', 'notes.txt'), 'utf-8')).toBe('notes')
  })

  it('.tmpl files are rendered and stripped of extension', async () => {
    await writeFile(
      join(scaffoldDir, 'SOUL.md.tmpl'),
      '# {{agent_display_name}}\nYear: {{year}}',
      'utf-8',
    )

    const created = await processScaffoldDir(scaffoldDir, outputDir, vars)

    expect(created).toContain('SOUL.md')
    const content = await readFile(join(outputDir, 'SOUL.md'), 'utf-8')
    expect(content).toBe('# Nova\nYear: 2026')
  })

  it('non-.tmpl files are copied as-is', async () => {
    await writeFile(join(scaffoldDir, 'static.txt'), 'I have {{agent_name}} in me', 'utf-8')

    const created = await processScaffoldDir(scaffoldDir, outputDir, vars)

    expect(created).toContain('static.txt')
    // Non-.tmpl files are copied raw, no variable substitution in content
    const content = await readFile(join(outputDir, 'static.txt'), 'utf-8')
    expect(content).toBe('I have {{agent_name}} in me')
  })

  it('filenames with {{agent_name}} are renamed', async () => {
    await writeFile(join(scaffoldDir, '{{agent_name}}.config.js'), 'module.exports = {}', 'utf-8')

    const created = await processScaffoldDir(scaffoldDir, outputDir, vars)

    expect(created).toContain('nova.config.js')
    const content = await readFile(join(outputDir, 'nova.config.js'), 'utf-8')
    expect(content).toBe('module.exports = {}')
  })

  it('.gitkeep files are skipped', async () => {
    await mkdir(join(scaffoldDir, 'empty-dir'), { recursive: true })
    await writeFile(join(scaffoldDir, 'empty-dir', '.gitkeep'), '', 'utf-8')
    await writeFile(join(scaffoldDir, 'keep.txt'), 'keep', 'utf-8')

    const created = await processScaffoldDir(scaffoldDir, outputDir, vars)

    expect(created).not.toContain(join('empty-dir', '.gitkeep'))
    expect(created).toContain('keep.txt')
  })

  it('returns list of all created files', async () => {
    await mkdir(join(scaffoldDir, 'scripts'), { recursive: true })
    await writeFile(join(scaffoldDir, 'AGENTS.md.tmpl'), '# {{agent_display_name}}', 'utf-8')
    await writeFile(join(scaffoldDir, 'scripts', 'run.sh'), '#!/bin/bash', 'utf-8')
    await writeFile(join(scaffoldDir, '{{agent_name}}.json'), '{}', 'utf-8')

    const created = await processScaffoldDir(scaffoldDir, outputDir, vars)

    expect(created).toEqual(
      ['AGENTS.md', join('scripts', 'run.sh'), 'nova.json'].sort(),
    )
  })
})
