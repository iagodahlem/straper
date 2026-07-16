/**
 * Blessed runtime baseline (v1). A published skill may statically reference
 * these workspace files without declaring them as dependencies — they are the
 * shared runtime every generated workspace ships. Versioned: bump to v2 (new
 * const) when the runtime contract changes, never edit v1 in place.
 */
export const RUNTIME_BASELINE_V1: readonly string[] = [
  'scripts/lib/cli-utils.js',
  'scripts/lib/skills.sh',
]
