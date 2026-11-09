import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { requireUser } from './access.server'
import { readThreadReview, readThreadReviewDiff, requestThreadCorrection,
  type ReviewSelection } from './thread-review.server'

const ID = /^[a-zA-Z0-9:_-]{1,128}$/
const SHA = /^[a-f0-9]{40}$/i
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

type ReviewRequest = { threadId: string; scope: ReviewSelection }
type DiffRequest = ReviewRequest & { path: string; currentSha: string }
type CorrectionRequest = DiffRequest & {
  headSha: string; id: string; annotation: string; hunkIndex: number | null
}
function validScope(scope: ReviewSelection) {
  return scope?.kind === 'cumulative' ||
    scope?.kind === 'turn' && typeof scope.turnId === 'string' && ID.test(scope.turnId)
}
function validPath(path: string) {
  return typeof path === 'string' && path.length <= 1024 && path.endsWith('.md') &&
    path.split('/').length >= 2 && path.split('/').every(part =>
      !!part && part !== '.' && part !== '..' && !part.startsWith('.') &&
      !part.includes('\\'))
}
function validate(input: ReviewRequest) {
  if (!input || !ID.test(input.threadId) || !validScope(input.scope))
    throw new Error('Invalid Thread review selection.')
  return input
}
function validateDiff(input: DiffRequest) {
  validate(input)
  if (!validPath(input.path) || !SHA.test(input.currentSha))
    throw new Error('Invalid verified review file.')
  return input
}
async function owner() {
  await database.assertReady()
  const user = await requireUser(auth, getRequestHeaders())
  if (!user) throw new Error('Sign in required.')
  return user.id
}

export const getThreadReview = createServerFn({ method: 'GET' })
  .validator(validate)
  .handler(async ({ data }) => readThreadReview(database, await owner(), data.threadId, data.scope))

export const getThreadReviewDiff = createServerFn({ method: 'GET' })
  .validator(validateDiff)
  .handler(async ({ data }) => readThreadReviewDiff(database, await owner(),
    data.threadId, data.scope, data.path, data.currentSha))

export const postThreadReviewCorrection = createServerFn({ method: 'POST' })
  .validator((input: CorrectionRequest) => {
    validateDiff(input)
    if (!SHA.test(input.headSha) || !UUID.test(input.id) ||
        typeof input.annotation !== 'string' || input.annotation.length > 1000 ||
        !input.annotation.trim() ||
        input.hunkIndex !== null && (!Number.isInteger(input.hunkIndex) ||
          input.hunkIndex < 0 || input.hunkIndex >= 200))
      throw new Error('Invalid correction request.')
    return input
  })
  .handler(async ({ data }) => requestThreadCorrection(database, await owner(),
    data.threadId, data.scope, data.path, data.hunkIndex, data.annotation,
    data.currentSha, data.headSha, data.id))
