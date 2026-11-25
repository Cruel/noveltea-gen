// The same registry drives unsharded registration and CI scheduling.
// Seconds are rounded from CI run 45533379614; they are estimates, not timeouts.
type Scenario = {
  kind: string
  name: string
  timeout: number
  seconds: number
  requiresSkills?: boolean
}

export const revisionScenarios = [
  { kind: 'redirect', name: "out-of-scope Character steering requires reviewed Milestone continuation with bounded downstream inventory",
    timeout: 60_000, seconds: 27 },
  { kind: 'broad', name: "reviewed Milestone expansion admits a scoped child and rejects changed approval",
    timeout: 60_000, seconds: 32 },
  { kind: 'whole', name: "whole-story request in an existing Thread requires exact scope approval without inheriting old targets",
    timeout: 60_000, seconds: 26 },
  { kind: 'initial-focus', name: "first Chat Turn on verified canon admits a single conversation editor, not global creation",
    timeout: 60_000, seconds: 27 },
  { kind: 'steering', name: "authenticated live steer amends pending Story work at graph boundary and survives restart",
    timeout: 90_000, seconds: 36 },
  { kind: 'steering-protected', name: "protected steering pauses before any Story writer and retains a review fence",
    timeout: 90_000, seconds: 21 },
  { kind: 'steering-stale', name: "unreachable steering source cannot replan a running Story",
    timeout: 90_000, seconds: 21 },
  { kind: 'dependency', name: "authenticated Turn dispatches a discovered dependency and fences another owner across restart",
    timeout: 90_000, seconds: 31, requiresSkills: true },
  { kind: 'conversation', name: "conversation revision in the same authenticated Thread grants only authored-content",
    timeout: 60_000, seconds: 17 },
  { kind: 'create-conversation', name: "authenticated focused conversation creates only pinned missing support after review and reconnect",
    timeout: 60_000, seconds: 18 },
  { kind: 'narrow', name: "unambiguous Character revision admits only its one focused path without a form",
    timeout: 60_000, seconds: 17 },
  { kind: 'concurrent', name: "simultaneous completed-Thread submissions both persist; only the first receives a scope",
    timeout: 60_000, seconds: 15 },
  { kind: 'cancel', name: "ambiguous queued instruction can be cancelled without rewriting its history or blocking the next",
    timeout: 60_000, seconds: 17 },
  { kind: 'multi-turn', name: "two different-scope Turns continue a single Thread from exact verified Git HEAD across restart",
    timeout: 90_000, seconds: 18 },
  { kind: 'unverified-crash', name: "Git commit without final trusted checkpoint blocks further Turns and survives recovery",
    timeout: 60_000, seconds: 17 },
  { kind: 'cancel-inflight', name: "cancellation racing with asynchronous inference cannot resurrect or authorize the message",
    timeout: 60_000, seconds: 1 },
] as const satisfies readonly Scenario[]

export type RevisionKind = typeof revisionScenarios[number]['kind']

export function selectRevisionScenarios(selection: string | undefined): readonly (typeof revisionScenarios[number])[] {
  if (selection === undefined) return revisionScenarios
  const kinds = selection.split(',')
  const selected = revisionScenarios.filter(scenario => kinds.includes(scenario.kind))
  if (kinds.length !== selected.length || new Set(kinds).size !== kinds.length)
    throw new Error('Invalid Studio revision scenario selection: ' + selection)
  return selected
}
