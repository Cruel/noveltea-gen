import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTimingShard, timingShards } from '../../../test/support/timing-shards.js'
import { revisionScenarios, type RevisionKind } from './story-revision-scenarios.js'

export const revisionFile = 'story-revision-admission.test.ts'

// Rounded serial test durations from CI run 45533379614. Include the newer
// integrated Turn conservatively until a CI measurement is available.
const slowFiles: Record<string, number> = {
  'current-checkpoint-fork.test.ts': 164,
  'pi-models.test.ts': 120,
  'story-chat-discovery.test.ts': 82,
  'pi-device-login.test.ts': 74,
  'onboarding-pi.test.ts': 65,
  'thread-protected-decision.test.ts': 54,
  'approval.test.ts': 41,
  'thread-restart.test.ts': 37,
  'fixture-jobs.test.ts': 37,
  'story-explorer.test.ts': 34,
  'generation-controls.test.ts': 32,
  'story-approved-continuation.test.ts': 30,
  'kysely-schema.test.ts': 24,
  'studio-store-conformance.test.ts': 25,
  'thread-publication-provider.test.ts': 16,
  'kysely-steering.test.ts': 10,
  'migrate-cli.test.ts': 9,
  'kysely-generation.test.ts': 8,
  'author-decisions-api.test.ts': 6,
  'thread-delete.test.ts': 6,
  'agent-process.test.ts': 5,
  'transcript-retention.test.ts': 5,
  'db-schema-baseline.test.ts': 4,
  'github-merge-integration.test.ts': 4,
  'postgres-compose.test.ts': 4,
  'studio-db-certification.test.ts': 4,
  'thread-review.test.ts': 4,
  'integrated-story-turn.test.ts': 120,
}

export function studioTestFiles(directory = resolve(import.meta.dirname, '..')): string[] {
  // Match the existing unsharded test script's two top-level globs.
  return readdirSync(directory).filter(name => /^[^.].*\.test\.tsx?$/.test(name)).sort()
}

type TestUnit = { id: string; file: string; seconds: number; revision?: RevisionKind }

export function studioTestUnits(files: readonly string[]): TestUnit[] {
  if (!files.includes(revisionFile)) throw Error('Missing Studio revision admission suite')
  if (new Set(files).size !== files.length) throw Error('Duplicate Studio test file')
  return [
    ...files.filter(file => file !== revisionFile).map(file => ({
      id: file, file, seconds: 2 + (slowFiles[file] ?? 1),
    })),
    ...revisionScenarios.map(scenario => ({
      id: revisionFile + ':' + scenario.kind, file: revisionFile,
      seconds: scenario.seconds + 2, revision: scenario.kind,
    })),
  ]
}

export function studioShards(files: readonly string[], count: number) {
  const units = studioTestUnits(files)
  const byId = new Map(units.map(unit => [unit.id, unit]))
  return timingShards(units.map(unit => unit.id), count, id => byId.get(id)!.seconds)
    .map(bucket => {
      const assigned = bucket.map(id => byId.get(id)!)
      return {
        files: [...new Set(assigned.map(unit => unit.file))].sort(),
        revisionCases: assigned.flatMap(unit => unit.revision ? [unit.revision] : []),
        estimatedSeconds: assigned.reduce((sum, unit) => sum + unit.seconds, 0),
      }
    })
}

export function selectStudioShard(files: readonly string[], shard: string) {
  const { index, count } = parseTimingShard(shard)
  return studioShards(files, count)[index]!
}
