/** The revision integration tests exercise the real planner, dependency tool,
 * specialist and independent Review, with only model transport substituted. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scriptedReadCalls, scriptedStoryRuntime, scriptedText } from '../../../test/c03-scripted-story-helpers'
import { requiredOrchestratorSkillReads } from '../../../src/story-skill-policy'
import { boundedPinnedSources } from '../../../src/bounded-specialist-prompt'
import type { JobStartResult } from '../../../src/job'
import type { TurnEvidence } from '../../../src/turn-plan-evidence'

export async function revisionRuntime(job: JobStartResult, turn: TurnEvidence, dependency: boolean) {
  let previous = '', step = 0, yielded = false, wroteSupport = false
  const contentPath = 'authored-content/confession.md', eventPath = 'events/confession.md'
  const missing = 'Clarify the necessary causal preparation for the confession'
  const revised = 'Nia waits for the testimony before admitting that she concealed the letter.'
  return scriptedStoryRuntime((index, context) => {
    const messages = context.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>
    const prompt = messages.filter(m => m.role === 'user').flatMap(m =>
      typeof m.content === 'string' ? [m.content] : m.content.map(c => c.text ?? '')).at(-1) ?? ''
    if (prompt !== previous) { previous = prompt; step = 0 }
    const phase = step++
    const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: 'toolUse' as const })
    const stop = (value: unknown) => ({ content: scriptedText(value), reason: 'stop' as const })
    if (prompt.includes('read-only NovelTea objective orchestrator')) {
      if (!phase) return read(requiredOrchestratorSkillReads(turn.creativePolicy?.mode ?? 'autonomous').map(p => 'skill://' + p))
      return stop({ sourceSha: job.baseSha, turnDigest: turn.digest, assignments: turn.assignments.map(a =>
        ({ id: a.id, reason: 'Complete the approved scoped revision.' })) })
    }
    if (prompt.includes('READ-ONLY dependency orchestrator')) {
      if (!phase) return read(['nt-story-orchestrate/SKILL.md', 'nt-story-orchestrate/references/planning.md',
        'nt-catalog/SKILL.md', 'nt-catalog/references/records.md', 'nt-catalog/references/authority-and-validation.md']
        .map(p => 'skill://' + p).concat(eventPath))
      return stop({ target: 'event.confession', specialist: 'nt-event-design', outcome: missing,
        reason: 'The cited Event owns the causal preparation for the requested authored conversation.' })
    }
    if (prompt.includes('revision specialist. FIRST')) {
      const support = prompt.includes('THIS IS A SEPARATELY AUTHORIZED SUPPORTING ASSIGNMENT')
      const path = support ? eventPath : contentPath
      assert.ok(prompt.includes('Only edit these PREEXISTING canonical Markdown files:\n' + path))
      if (!phase) return read([support ? 'nt-event-design/SKILL.md' : 'nt-narrative-composition/SKILL.md',
        'nt-catalog/SKILL.md', 'nt-catalog/references/records.md',
        ...(support ? ['nt-catalog/references/progression.md'] : [])].map(p => 'skill://' + p))
      if (phase === 1 && dependency && !support && !yielded) {
        yielded = true
        return { reason: 'toolUse', content: [{ type: 'toolCall', id: 'dependency-' + index,
          name: 'report_dependency', arguments: { obligationIndex: 0, missing,
            affectedIds: ['authored-content.confession', 'event.confession'],
            sources: [{ path: eventPath, quote: 'id: event.confession' }],
            likelySpecialist: 'nt-event-design', authorDecisionRequired: false } }] }
      }
      if (phase === 1 && (!dependency || support || wroteSupport)) {
        if (support) wroteSupport = true
        const old = readFileSync(join(job.worktreeStoryRoot, path), 'utf8')
        return { reason: 'toolUse', content: [{ type: 'toolCall', id: 'edit-' + index, name: 'edit',
          arguments: { path, edits: [{ oldText: old, newText: old + '\n\n' +
            (support ? revised : 'Author steering: Nia says, "You knew?" Then she waits for an answer.') + '\n' }] } }] }
      }
      return stop({ modifiedRecords: dependency && !support && !wroteSupport ? [] : [path],
        architecturalConflicts: [], laterObligations: [] })
    }
    if (prompt.includes('IMMUTABLE REVIEW PACKET')) {
      if (!phase) return read(boundedPinnedSources('nt-narrative-review').map(p => 'skill://' + p))
      const packet = JSON.parse(prompt.split('\nIMMUTABLE REVIEW PACKET\n')[1]!)
      return stop({ sourceDigest: packet.sourceDigest, verdict: 'pass', findings: [],
        evidence: packet.items.flatMap((item: any) => item.assurance.changedPaths.map((path: string) => ({
          commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path,
          line: readFileSync(join(job.worktreeStoryRoot, path), 'utf8').split('\n')
            .findIndex(l => l.includes(path === eventPath ? revised : 'Author steering:')) + 1,
          explanation: 'The bounded revision is present in the authorized canonical record.' }))) })
    }
    if (prompt.includes('You are the independent nt-narrative-review editor')) {
      const assignment = JSON.parse(prompt.split('\nASSIGNMENT:\n')[1]!)
      if (!phase) return read(prompt.split('PINNED REFERENCES:\n')[1]!.split('\nSTORY PATHS:')[0]!
        .split('\n').filter(p => p.startsWith('skill://')).concat(assignment.paths))
      const evidence = assignment.paths.map((p: string) => p + ':1: The verified source record remains present.')
      for (const route of assignment.milestoneRoutes) {
        const p = 'milestones/' + route.milestone.split('.').at(-1) + '.md'
        const line = readFileSync(join(job.worktreeStoryRoot, p), 'utf8').split('\n').findIndex(l => l.startsWith('fulfillment:')) + 1
        evidence.push(route.milestone + '#' + route.alternative + ' ' + p + ':' + line + ': The reachable Event fulfills the milestone.')
      }
      return stop({ verdict: 'pass', findings: [], evidence })
    }
    throw Error('Unexpected revision model prompt: ' + prompt.slice(0, 600))
  })
}
