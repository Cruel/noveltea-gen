import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobStartResult } from '../../../src/job'
import { parseQuestionDrafts, specialistQuestionSet, type QuestionDraft } from '../../../src/author-question-set'
export { specialistQuestionSet } from '../../../src/author-question-set'
import type { SpecialistChoiceReceipt } from '../../../src/specialist-choice'

type Snapshot = { revision: number; drafts: Record<string, QuestionDraft> }
type RecordOnDisk = Snapshot & {
  version: 1; owner: string; id: string; proposalSha256: string
}
const EMPTY: Snapshot = { revision: 1, drafts: {} }

const directory = (job: JobStartResult) => join(job.stateDir, 'author-question-drafts')
const location = (job: JobStartResult, choice: SpecialistChoiceReceipt) =>
  join(directory(job), choice.id + '.json')

/** Do not follow a forged sidecar directory symlink into Story files or an
 * unrelated state tree; the trusted Job root owns the only writable location. */
async function checkDirectory(job: JobStartResult, create: boolean): Promise<boolean> {
  const dir = directory(job)
  try {
    const stat = await lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('Unsafe specialist question draft directory.')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (!create) return false
    await mkdir(dir, { recursive: false, mode: 0o700 })
    return checkDirectory(job, false)
  }
}

/** Read-only, exact author/receipt binding. A missing file means no input was
 * saved, never an authorization to submit the provisional default. */
export async function readSpecialistQuestionDraft(job: JobStartResult,
  choice: SpecialistChoiceReceipt, owner: string): Promise<Snapshot> {
  if (!await checkDirectory(job, false)) return EMPTY
  const path = location(job, choice)
  let stat
  try { stat = await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000)
    throw Error('Unsafe specialist question draft.')
  const stored: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    throw Error('Invalid specialist question draft.')
  const record = stored as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'drafts,id,owner,proposalSha256,revision,version' ||
      record.version !== 1 || record.owner !== owner || record.id !== choice.id ||
      record.proposalSha256 !== choice.proposalSha256 ||
      !Number.isSafeInteger(record.revision) || (record.revision as number) < 2)
    throw Error('Specialist draft is not bound to this owner and question.')
  const drafts = parseQuestionDrafts(specialistQuestionSet(choice), record.drafts)
  return { revision: record.revision as number, drafts }
}

/** Caller holds the Job writer lock; atomic rename makes refresh/restart safe.
 * A competing browser must supply the exact previous revision. */
export async function saveSpecialistQuestionDraft(job: JobStartResult,
  choice: SpecialistChoiceReceipt, owner: string, expectedRevision: number,
  input: unknown): Promise<Snapshot> {
  const drafts = parseQuestionDrafts(specialistQuestionSet(choice), input)
  const previous = await readSpecialistQuestionDraft(job, choice, owner)
  if (previous.revision !== expectedRevision)
    throw Error('Specialist question draft changed in another browser.')
  if (JSON.stringify(previous.drafts) === JSON.stringify(drafts)) return previous
  const next: RecordOnDisk = { version: 1, owner, id: choice.id,
    proposalSha256: choice.proposalSha256, revision: previous.revision + 1, drafts }
  const path = location(job, choice)
  await checkDirectory(job, true)
  const temp = path + '.' + randomUUID() + '.tmp'
  await writeFile(temp, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temp, path)
  return { revision: next.revision, drafts }
}
