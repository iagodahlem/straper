import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const VERSION = '0.1.0'
export const PACKAGE_ROOT = resolve(__dirname, '..')
export const SCAFFOLD_DIR = resolve(PACKAGE_ROOT, 'scaffold')
export const REGISTRY_DIR = resolve(PACKAGE_ROOT, 'registry')
export const CONFIG_DIR_NAME = 'straper'
export const DEFAULT_CLI_INSTALL_TARGET = '~/.local/bin'
