import { join } from 'node:path'
import { inject } from 'vitest'

// Runs in every test worker before any test file. os.homedir() honors $HOME on
// POSIX, and children spawned with { ...process.env } inherit these, so pointing
// HOME/XDG at the shared temp home isolates config reads and CLI-install writes.
const fakeHome = inject('fakeHome')

process.env.HOME = fakeHome
process.env.XDG_CONFIG_HOME = join(fakeHome, '.config')
process.env.XDG_STATE_HOME = join(fakeHome, '.local', 'state')
process.env.STRAPER_SKIP_CLI_INSTALL = '1'
