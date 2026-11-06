import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const certifier = fileURLToPath(new URL('../scripts/certify-self-hosted.mjs', import.meta.url))

test('self-hosted report preserves failed and passed evidence only for the same committed revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-cert-report-'))
  const repo = join(root, 'repo')
  const report = join(root, 'issue-71.json')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  try {
    mkdirSync(repo)
    git('init', '-q')
    writeFileSync(join(repo, 'README.txt'), 'initial\n')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial')
    const revision = git('rev-parse', 'HEAD')
    writeFileSync(report, JSON.stringify({
      schema: 1, issue: 71, revision,
      gates: {
        host: { status: 'passed', date: '2026-11-01T00:00:00Z' },
        compose: { status: 'failed', date: '2026-11-01T00:01:00Z',
          failure: 'Refusing to touch existing volume noveltea-app' },
      },
    }))
    const run = () => spawnSync(process.execPath,
      [certifier, '--offline', '--report', report], {
        cwd: repo, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NT_NATIVE_CLI: '', NT_SKILLS_CHECKOUT: '' },
      })
    assert.equal(run().status, 1, 'offline gate must reject missing native CLI')
    const same = JSON.parse(readFileSync(report, 'utf8'))
    assert.equal(same.revision, revision)
    assert.equal(same.gates.offline.status, 'failed')
    assert.equal(same.gates.host.status, 'passed')
    assert.equal(same.gates.compose.status, 'failed')
    assert.match(same.gates.compose.failure, /existing volume/)
    assert.equal(same.gates.compose.date, '2026-11-01T00:01:00Z')

    writeFileSync(join(repo, 'README.txt'), 'new revision\n')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'next')
    assert.equal(run().status, 1)
    const next = JSON.parse(readFileSync(report, 'utf8'))
    assert.equal(next.revision, git('rev-parse', 'HEAD'))
    assert.notEqual(next.revision, revision)
    assert.equal(next.gates.offline.status, 'failed')
    assert.equal(next.gates.host.status, 'not-run')
    assert.equal(next.gates.compose.status, 'not-run')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
