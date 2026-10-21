/**
 * Command rewrites applied before dispatch and before flag validation, shared by
 * the CLI dispatcher (cli/main.ts) and the docs command checker, so both read
 * the same command a user's argv names.
 * - `ask` is a natural-language alias for `query`.
 * - #7191: `search --exact "<phrase>"` is the exhaustive literal scan
 *   (`search-exact`), routed before any ranked-search flag is parsed; a
 *   `--exact` after a bare `--` is a positional and routes nothing.
 */
export function routeCommand(command: string, subArgs: string[]): { command: string; subArgs: string[] } {
  if (command === 'ask') return { command: 'query', subArgs };
  if (command !== 'search') return { command, subArgs };
  const at = subArgs.indexOf('--exact');
  const end = subArgs.indexOf('--');
  if (at < 0 || (end >= 0 && end < at)) return { command, subArgs };
  return { command: 'search-exact', subArgs: subArgs.filter((_, i) => i !== at) };
}
