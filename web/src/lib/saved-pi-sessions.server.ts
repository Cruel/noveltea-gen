import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { JobStartResult } from '../../../src/job'

export type SavedPiSession = {
  group: string
  sessionId: string
  model: string
  transcriptRetained: boolean
}

/** Read only server-owned Pi context receipts; never return private file paths,
 * prompts, transcript contents, auth data, or an unverified session as resumed.
 * The index is deliberately bounded and is not an execution authority. */
export async function inspectSavedPiSessions(job: Pick<JobStartResult, 'stateDir'>):
  Promise<SavedPiSession[]> {
  const directory = join(job.stateDir, 'pi-contexts')
  let entries: Dirent[]
  try {
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory())
      return []
    entries = await readdir(directory, { withFileTypes: true })
  } catch { return [] }

  const results: SavedPiSession[] = []
  for (const entry of entries
    .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 32)) {
    const path = join(directory, entry.name)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > 256_000 || await realpath(path) !== path) continue
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const value = parsed as Record<string, unknown>
      if (value.version !== 1 || typeof value.group !== 'string' ||
          !/^[\x20-\x7e]{1,160}$/.test(value.group) ||
          typeof value.sessionId !== 'string' ||
          !/^[a-z0-9-]{8,128}$/i.test(value.sessionId) ||
          typeof value.model !== 'string' || value.model.length > 200 ||
          typeof value.file !== 'string' || !isAbsolute(value.file) ||
          entry.name !== createHash('sha256').update(value.group).digest('hex') + '.json') continue

      const within = relative(job.stateDir, value.file)
      if (!within || within === '..' || within.startsWith('..' + sep) ||
          isAbsolute(within) || !within.includes('sessions' + sep)) continue
      let transcriptRetained = false
      try {
        transcriptRetained = (await lstat(value.file)).isFile() &&
          await realpath(value.file) === value.file
      } catch { /* A retained receipt may outlive a compacted transcript. */ }
      results.push({ group: value.group, sessionId: value.sessionId,
        model: value.model, transcriptRetained })
    } catch { /* Corrupt or unsafe receipts do not authorize or describe sessions. */ }
  }
  return results
}
