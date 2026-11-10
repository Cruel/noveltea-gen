import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** The Studio DB path never falls back to a project or job checkpoint path. */
export function defaultStudioPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NT_STUDIO_DB_PATH) {
    if (!isAbsolute(env.NT_STUDIO_DB_PATH)) throw new Error('NT_STUDIO_DB_PATH must be absolute')
    return env.NT_STUDIO_DB_PATH
  }
  const state = env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  if (!isAbsolute(state)) throw new Error('XDG_STATE_HOME must be absolute')
  return join(state, 'noveltea-gen', 'studio.sqlite')
}
