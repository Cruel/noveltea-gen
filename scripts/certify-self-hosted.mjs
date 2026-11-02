#!/usr/bin/env node
/**
 * Issue #71: repeatable certification gates with durable, explicitly
 * distinguished evidence. A fixture can never satisfy a live provider gate.
 *
 * Modes:
 *   --offline  deterministic full suite and native CLI (default)
 *   --host     real rootless Docker and registered Story-controller integration
 *   --compose  isolated disposable Compose volumes and independent restarts
 *   --live-pi  opt-in paid web/Pi/native integration; NO remote publishing
 *
 * Each mode updates one local evidence report, without storing credentials,
 * prompts, Pi transcripts, or private Story content.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const definitions = {
  offline: { kind: 'fixture + native', description: 'Deterministic application and native Story contract suites' },
  host: { kind: 'real-rootless-host + fixture-generation', description: 'Actual sandbox isolation, resources, recovery and controller-backed Story job' },
  compose: { kind: 'real-compose + synthetic-state', description: 'Rootless deployment and independent service/controller restarts' },
  'live-pi': { kind: 'real-model + native', description: 'Authenticated web-triggered Pi writes a native-validated Story in a rootless sandbox' },
}
const usage = 'Usage: pnpm certify:self-hosted [--offline] [--host] [--compose] [--live-pi] [--report .local/certification/issue-71.json]'
const argv = process.argv.slice(2)
const selected = []
let reportPath = '.local/certification/issue-71.json'
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--report') {
    if (!argv[++i]) throw Error('--report needs a filename')
    reportPath = argv[i]
  } else if (arg === '--help') { console.log(usage); process.exit(0) }
  else if (arg?.startsWith('--') && Object.hasOwn(definitions, arg.slice(2)))
    selected.push(arg.slice(2))
  else throw Error(`Unknown option ${arg}. ${usage}`)
}
if (!selected.length) selected.push('offline')
// Evidence must describe exactly the committed source being certified.
// A dirty checkout can change without the HEAD SHA changing.
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim()
if (dirty) throw Error('Certification requires a clean committed checkout; commit/review changes first')
const reportFile = resolve(reportPath)
const clean = {
  schema: 1,
  issue: 71,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  gates: Object.fromEntries(Object.entries(definitions).map(([name, data]) =>
    [name, { ...data, status: 'not-run' }])),
  external: {
    githubDraft: 'not-run (requires real OAuth, installation and explicit test repository)',
    gitlabDraft: 'not-run (requires real GitLab OAuth and explicit test repository)',
    creativeReview: 'not-run (requires independent human review of actual Pi-authored Story)',
  },
  overall: 'incomplete',
}
if (existsSync(reportFile)) {
  try {
    const old = JSON.parse(readFileSync(reportFile, 'utf8'))
    if (old.schema === 1 && old.issue === 71 && old.revision === clean.revision) {
      for (const key of Object.keys(definitions)) {
        if (old.gates?.[key]?.status === 'passed') clean.gates[key] = old.gates[key]
      }
    }
  } catch { /* an unreadable old report is not evidence */ }
}
function save() {
  mkdirSync(dirname(reportFile), { recursive: true })
  writeFileSync(reportFile, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 })
}
function need(name) {
  const value = process.env[name]
  if (!value) throw Error(`Required environment variable ${name} is not configured`)
  return value
}
function rootless() {
  const flags = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8' }))
  if (!flags.some(value => /(^|=)rootless$/.test(value))) throw Error('Rootless Docker is required')
  const cgroup = execFileSync('docker', ['info', '--format', '{{.CgroupVersion}}/{{.CgroupDriver}}'], { encoding: 'utf8' }).trim()
  if (cgroup !== '2/systemd') throw Error('Resource enforcement requires Docker cgroup 2/systemd')
}
function execute(label, command, args, additionalEnv = {}) {
  process.stdout.write(`\n== ${label} ==\n`)
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...additionalEnv } })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${label} failed (status ${result.status ?? 'signal ' + result.signal})`)
}
const stages = {
  offline() {
    const native = need('NT_NATIVE_CLI'), skills = need('NT_SKILLS_CHECKOUT')
    if (!existsSync(native) || !existsSync(skills)) throw Error('Native validator or skills checkout is missing')
    execute('Full project check', 'pnpm', ['check'])
    execute('Native Story validation, context, baseline and protection', 'pnpm',
      ['exec', 'tsx', '--test', 'test/story-generator-certification.test.ts', 'test/validator.test.ts', 'test/story-context.test.ts'])
  },
  host() {
    rootless()
    need('NT_NATIVE_CLI'); need('NT_SKILLS_CHECKOUT')
    execute('Build sandbox image from certified checkout', 'docker',
      ['build', '-f', 'deploy/sandbox.Dockerfile', '-t', 'noveltea-sandbox:local', '.'])
    execute('Real rootless controller boundary', 'pnpm',
      ['--filter', '@noveltea/studio', 'exec', 'tsx', '--test', 'test/sandbox-controller.test.ts'],
      { NT_TEST_ROOTLESS_SANDBOX: '1' })
    execute('Actual rootless Pi tool delegation', 'pnpm',
      ['exec', 'tsx', '--test', 'test/sandbox-pi-tools.test.ts', 'test/story-context.test.ts'],
      { NT_TEST_ROOTLESS_SANDBOX: '1' })
    execute('Registered Story job through real controller', 'pnpm',
      ['exec', 'tsx', '--test', 'test/sandbox-hosted-live.test.ts'],
      { NT_TEST_HOSTED_FIXTURE: '1', NT_TEST_HOSTED_STAGES: '1' })
  },
  compose() {
    rootless()
    execute('Disposable rootless Compose independent restart certification',
      'pnpm', ['exec', 'tsx', 'scripts/certify-compose.ts'])
  },
  'live-pi'() {
    rootless()
    for (const key of ['NT_NATIVE_CLI', 'NT_STUDIO_SKILLS_SOURCE']) need(key)
    if (process.env.NT_TEST_WEB_PI_AUTH === 'studio-oauth') {
      for (const key of ['NT_TEST_WEB_PI_SOURCE_DB', 'NT_PI_CREDENTIAL_KEY']) need(key)
    } else if (!process.env.NT_TEST_WEB_PI_AUTH || process.env.NT_TEST_WEB_PI_AUTH === 'api-key') {
      for (const key of ['NT_TEST_WEB_PI_API_KEY', 'NT_TEST_WEB_PI_MODEL']) need(key)
    } else throw Error('NT_TEST_WEB_PI_AUTH must be studio-oauth or api-key')
    execute('Real Pi web job, canonical commit and sandbox', 'pnpm',
      ['--filter', '@noveltea/studio', 'exec', 'tsx', '--test', 'test/real-pi-generation.test.ts'],
      { NT_TEST_WEB_REAL_PI: '1' })
  },
}
for (const gate of [...new Set(selected)]) {
  const entry = clean.gates[gate]
  entry.status = 'running'
  entry.date = new Date().toISOString()
  save()
  try {
    stages[gate]()
    entry.status = 'passed'
  } catch (error) {
    entry.status = 'failed'
    entry.failure = error instanceof Error ? error.message : String(error)
    save()
    console.error(`Certification gate ${gate} FAILED: ${entry.failure}`)
    process.exitCode = 1
    break
  }
  delete entry.failure
  save()
}
const passed = Object.values(clean.gates).filter(gate => gate.status === 'passed').length
// Passing the available gate(s) is NOT equivalent to full #71 acceptance.
// Real provider and creative review evidence always remain separate.
console.log(`\nEvidence: ${reportFile}\nLocal gates: ${passed}/4 passed. Full #71 release certification: INCOMPLETE until real GitHub, GitLab and literary review evidence is recorded.\n`)
