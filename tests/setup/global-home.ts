import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSetupContext } from 'vitest/node'

declare module 'vitest' {
  interface ProvidedContext {
    fakeHome: string
  }
}

// Creates one throwaway HOME for the whole suite so no test can read the real
// user config or write symlinks into the real ~/.local/bin. The path is handed
// to every worker via `provide`, and the per-worker setup file (fake-home.ts)
// points process.env.HOME/XDG_* at it before any test code runs.
export default async function ({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), 'straper-test-home-'))
  await mkdir(join(home, '.local', 'bin'), { recursive: true })
  await mkdir(join(home, '.config'), { recursive: true })
  await mkdir(join(home, '.local', 'state'), { recursive: true })

  provide('fakeHome', home)

  return async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
  }
}
