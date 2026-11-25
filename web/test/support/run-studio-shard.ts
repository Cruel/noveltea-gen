import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { selectStudioShard, studioTestFiles } from './studio-shards.js'

const shard = process.env.NT_STUDIO_TEST_SHARD
if (!shard) throw Error('NT_STUDIO_TEST_SHARD must be set (for example 1/4)')
const plan = selectStudioShard(studioTestFiles(), shard)
console.info('Studio shard ' + shard + ': ' + plan.files.length + ' files, ' +
  plan.revisionCases.length + ' revision scenarios; estimated serial seconds ' + plan.estimatedSeconds)
console.info('Revision scenarios: ' + plan.revisionCases.join(', '))
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  ...plan.files.map(file => join('test', file))], {
  cwd: resolve(import.meta.dirname, '../..'),
  env: { ...process.env, NT_STUDIO_REVISION_CASES: plan.revisionCases.join(',') },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
