import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderFoundation, type FoundationDraft } from '../../../src/foundation-record'
import { parseStoryPlanning } from '../../../src/story-planning'

export class StoryBootstrapError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 12_000 || value.includes('\0')) {
    throw new StoryBootstrapError(400, `Provide valid, nonempty onboarding ${field} (maximum 12,000 characters).`)
  }
  return value.trim()
}
export function candidate(value: unknown): { file: string; title: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoryBootstrapError(400, 'Supply canonical Creative Direction onboarding fields.')
  }
  const input = value as Record<string, unknown>
  const fields = ['id', 'title', 'premise', 'central_conflict', 'genre', 'tone',
    'player_experience', 'scope', 'body']
  const withDecisions = Object.hasOwn(input, 'decisions')
  const expected = [...fields, withDecisions ? 'decisions' : 'decision',
    ...(Object.hasOwn(input, 'planning') ? ['planning'] : [])]
  if (Object.keys(input).length !== expected.length || expected.some(field => !Object.hasOwn(input, field))) {
    throw new StoryBootstrapError(400, 'Only the documented Creative Direction onboarding fields are accepted.')
  }
  const values = {
    id: text(input.id, 'id'), title: text(input.title, 'title'),
    premise: text(input.premise, 'premise'),
    central_conflict: text(input.central_conflict, 'central_conflict'),
    genre: text(input.genre, 'genre'), tone: text(input.tone, 'tone'),
    player_experience: text(input.player_experience, 'player_experience'),
    scope: text(input.scope, 'scope'), body: text(input.body, 'body'),
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(values.id) || values.id.length > 100) {
    throw new StoryBootstrapError(400, 'Creative Direction ID must be a lowercase slug.')
  }
  // The human supplied this opening decision; never misattribute it to an
  // autonomous agent or grant the agent authority over it.
  let decisions: FoundationDraft['decisions']
  if (withDecisions) {
    // Preserve every independently sourced author and Studio decision.
    // Validate the entries, not an arbitrary cardinality; the enclosing
    // transport and native validator still bound the actual payload.
    if (!Array.isArray(input.decisions) || input.decisions.length < 1 ||
        input.decisions.some(d => !d || typeof d !== 'object' || Array.isArray(d) ||
          Object.keys(d).sort().join(',') !== 'authority,id,origin,statement' ||
          typeof d.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(d.id) ||
          typeof d.statement !== 'string' || !d.statement.trim() || d.statement.length > 4000 ||
          !['user', 'agent'].includes(d.origin) ||
          !['user-protected', 'delegated'].includes(d.authority) ||
          (d.origin === 'user' && d.authority !== 'user-protected'))) {
      throw new StoryBootstrapError(400, 'Invalid Creative Direction decision provenance.')
    }
    decisions = input.decisions as FoundationDraft['decisions']
    if (new Set(decisions.map(d => d.id)).size !== decisions.length)
      throw new StoryBootstrapError(400, 'Duplicate Creative Direction decision IDs.')
  } else {
    decisions = [{ id: 'initial-direction', statement: text(input.decision, 'decision'),
      origin: 'user', authority: 'user-protected' }]
  }
  let planning: FoundationDraft['planning']
  if (Object.hasOwn(input, 'planning')) {
    try { planning = parseStoryPlanning(input.planning) }
    catch { throw new StoryBootstrapError(400, 'Invalid canonical Story interaction or production planning metadata.') }
  }
  const record: FoundationDraft = { ...values, decisions, ...(planning ? { planning } : {}) }
  return { file: renderFoundation(record), title: record.title }
}
export async function validateNewStory(file: string) {
  const binary = process.env.NT_NATIVE_CLI || 'noveltea'
  const root = await mkdtemp(join(tmpdir(), 'noveltea-story-bootstrap-'))
  try {
    await mkdir(join(root, 'creative-direction'))
    await writeFile(join(root, 'creative-direction', 'foundation.md'), file, { flag: 'wx', mode: 0o600 })
    let output: string
    try {
      output = execFileSync(binary, ['--json', 'narrative', 'validate', root], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new StoryBootstrapError(503, 'Canonical NovelTea validator is unavailable. Configure NT_NATIVE_CLI before creating a Story.')
      }
      throw new StoryBootstrapError(422, 'Canonical NovelTea Story validation failed. Review the onboarding fields; no Story commit was created.')
    }
    let result: unknown
    try { result = JSON.parse(output) } catch {
      throw new StoryBootstrapError(503, 'Canonical NovelTea validator did not return a valid report.')
    }
    // A successful process is not sufficient if the canonical report rejects
    // the Story. Do not assume a demo/rendered file is verified by itself.
    if (!result || typeof result !== 'object') {
      throw new StoryBootstrapError(503, 'Canonical NovelTea validator returned an unsupported report.')
    }
    const verdict = result as Record<string, unknown>
    const catalog = verdict.catalog as Record<string, unknown> | undefined
    const records = catalog?.records
    const errors = (diagnostics: unknown) => !Array.isArray(diagnostics) ||
      diagnostics.some(d => d && typeof d === 'object' && 'severity' in d &&
        (d as { severity: unknown }).severity === 'error')
    // Match the native NovelTea CLI's structured envelope, not an ad-hoc
    // "validation succeeded" string. Structural/catalog validation only;
    // no author approval or narrative quality is inferred from success.
    if (verdict.success !== true || verdict.exitCode !== 0 || errors(verdict.diagnostics) ||
        errors(catalog?.diagnostics) || !Array.isArray(records) || records.length !== 1 ||
        records[0]?.path !== 'creative-direction/foundation.md' ||
        records[0]?.metadata?.schema !== '0.1' ||
        records[0]?.metadata?.type !== 'creative-direction' ||
        records[0]?.metadata?.status !== 'draft') {
      throw new StoryBootstrapError(422, 'Canonical NovelTea Story validation rejected the onboarding draft.')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
