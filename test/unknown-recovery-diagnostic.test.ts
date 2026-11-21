import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type Model, type Provider, type AssistantMessage } from '@earendil-works/pi-ai';
import { withJobModelRuntime } from '../src/model-runtime.js';
import { configurePiPolicy, inspectPiPolicy } from '../src/job-pi-policy.js';
import { withStoryJobLock } from '../src/job-lock.js';
import type { JobStartResult } from '../src/job.js';
import {
  unknownCompletionCase, parseUnknownDiagnosis, unknownDiagnosisDisposition,
  diagnoseUnknownCompletion, inspectUnknownRecoveryStatus,
} from '../src/unknown-recovery-diagnostic.js';

const evidence = {
  jobId: 'job-222', threadId: 'thread-222', turnDigest: 'a'.repeat(64),
  planVersion: 3, sourceSha: 'b'.repeat(40), checkpoint: 'composition-last',
  reportStatus: 'blocked', scopeStatus: 'complete-in-scope', planStatus: 'complete',
};

test('unknown completion fingerprint identifies failed operation and evidence, not prose', () => {
  const first = unknownCompletionCase(evidence);
  assert.equal(first.operation, 'completion-verification');
  assert.equal(first.check, 'generation-fulfillment');
  assert.equal(first.checkVersion, 1);
  assert.equal(first.signature, unknownCompletionCase({ ...evidence }).signature);
  assert.equal(first.signature, unknownCompletionCase(Object.fromEntries(
    Object.entries(evidence).reverse()) as typeof evidence).signature,
  'reordered structured fields do not consume a second diagnosis');
  assert.notEqual(first.signature, unknownCompletionCase({ ...evidence, sourceSha: 'c'.repeat(40) }).signature);
  assert.notEqual(first.signature, unknownCompletionCase({ ...evidence, planStatus: 'incomplete' }).signature);
  assert.throws(() => unknownCompletionCase({ ...evidence, sourceSha: 'untrusted' }), /source/i);
});

test('model may only advise a known safe stop, never authorize a writer or a Story pass', () => {
  const original = unknownCompletionCase(evidence);
  const accepted = parseUnknownDiagnosis(JSON.stringify({
    schema: 'noveltea-unknown-recovery-diagnosis/v1',
    signature: original.signature, category: 'software',
    action: 'operator-intervention', summary: 'The completion gate needs operator inspection.',
  }), original);
  assert.equal(unknownDiagnosisDisposition(accepted), 'operator-intervention');
  for (const action of ['run-writer', 'approve', 'waive-check', 'author-question', 'retry']) {
    assert.throws(() => parseUnknownDiagnosis(JSON.stringify({
      ...accepted, action,
    }), original));
  }
  assert.throws(() => parseUnknownDiagnosis(JSON.stringify({
    ...accepted, signature: 'c'.repeat(64),
  }), original));
  assert.throws(() => parseUnknownDiagnosis(JSON.stringify({
    ...accepted, extra: 'permission',
  }), original));
});

test('real read-only Pi diagnosis is single-use across restart and rejects altered evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-222-unknown-'));
  const stateDir = join(root, 'state'), story = join(root, 'story');
  mkdirSync(stateDir); mkdirSync(story);
  const job = { jobId: evidence.jobId, threadId: evidence.threadId,
    stateDir, worktreeStoryRoot: story } as JobStartResult;
  const caseFile = unknownCompletionCase(evidence);
  const model: Model = {
    id: 'script-222', name: 'Scripted unknown recovery', provider: 'script-222', api: 'script-222',
    baseUrl: 'http://not-used.invalid', input: ['text'], reasoning: false,
    contextWindow: 128_000, maxTokens: 16_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const usage: AssistantMessage['usage'] = {
    input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let calls = 0;
  let activeSignature = caseFile.signature;
  let malformedOnce = false;
  const stream: NonNullable<Provider['streamSimple']> = (_model, ctx) => {
    const tools = new Set<string>();
    for (const entry of ctx.messages) {
      if (entry.role !== 'system') continue;
      for (const item of entry.toolsAdded ?? []) tools.add(item.name);
      for (const name of entry.toolsRemoved ?? []) tools.delete(name);
    }
    assert.deepEqual([...tools], [], 'diagnostician must have zero active tools');
    calls++;
    const result = createAssistantMessageEventStream();
    const content = [{ type: 'text' as const, text: malformedOnce ? 'Not structured JSON' :
      JSON.stringify({
        schema: 'noveltea-unknown-recovery-diagnosis/v1',
        signature: activeSignature, category: 'unclassified',
        action: 'inspect-existing-receipt', summary: 'Inspect verified completion receipts.',
      }) }];
    malformedOnce = false;
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content, usage, stopReason: 'stop', timestamp: Date.now(),
    };
    queueMicrotask(() => {
      result.push({ type: 'start', partial: message });
      result.push({ type: 'text_start', contentIndex: 0, partial: message });
      result.push({ type: 'text_end', contentIndex: 0, content: content[0]!.text, partial: message });
      result.push({ type: 'done', reason: 'stop', message });
      result.end(message);
    });
    return result;
  };
  const provider: Provider = {
    id: model.provider, name: 'Local diagnostic',
    auth: { apiKey: { name: 'Scripted auth', check: async () =>
      ({ type: 'api_key', source: 'test' }), resolve: async () =>
      ({ auth: { apiKey: 'not-a-real-key' } }) } },
    getModels: () => [model], stream, streamSimple: stream,
  };
  try {
    const rt = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    rt.registerNativeProvider(provider);
    await rt.refresh({ allowNetwork: false });
    await configurePiPolicy(job, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 0 } });
    const run = () => withJobModelRuntime(rt, () =>
      withStoryJobLock(job, 'unknown-diagnostic-test', () =>
        diagnoseUnknownCompletion(job, caseFile, model.provider, model.id)));
    await assert.rejects(run(), /budget exhausted/i);
    assert.equal(calls, 0, 'existing budget must prevent the initial model call');
    await configurePiPolicy(job, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 4 } });
    const first = await run();
    assert.equal(first.action, 'inspect-existing-receipt');
    assert.equal(calls, 1);
    assert.equal((await inspectPiPolicy(job)).budget.modelCalls, 1,
      'a successful first response must be metered without a correction');
    const second = await run();
    assert.deepEqual(second, first);
    assert.equal(calls, 1, 'same material evidence never creates a second model call');
    const savedStatus = { case: caseFile, phase: 'operator-intervention' as const,
      recommendation: first.action, advisoryCategory: first.category };
    assert.deepEqual(await inspectUnknownRecoveryStatus(job, savedStatus), savedStatus);
    assert.equal(calls, 1, 'read-only inspection cannot issue model requests');
    const receipt = join(stateDir, 'unknown-diagnostics', caseFile.signature + '.initial.json');
    const sealed = readFileSync(receipt, 'utf8');
    writeFileSync(receipt, sealed.replace('"responseHash":"', '"responseHash":"bad-'));
    const unsafe = await inspectUnknownRecoveryStatus(job, savedStatus);
    assert.equal(unsafe?.phase, 'unsafe-evidence');
    assert.equal(unsafe?.recommendation, undefined, 'tampered transcript proof loses all advisory claims');
    writeFileSync(receipt, sealed);
    assert.deepEqual(await inspectUnknownRecoveryStatus(job, savedStatus), savedStatus);
    const file = join(stateDir, 'unknown-diagnostics', caseFile.signature + '.admission.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"sourceSha":"b', '"sourceSha":"c'));
    await assert.rejects(run(), /untrustworthy|missing/i);
    assert.equal(calls, 1, 'tampered admission never grants model replay');

    // Budget exhaustion after one malformed response must preserve the same
    // Pi conversation and its original format-repair allowance on restart.
    const secondJob = { ...job, jobId: 'job-222-second',
      stateDir: join(root, 'state-2') };
    mkdirSync(secondJob.stateDir);
    const secondCase = unknownCompletionCase({ ...evidence, jobId: secondJob.jobId });
    activeSignature = secondCase.signature;
    malformedOnce = true;
    await configurePiPolicy(secondJob, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 1 } });
    const runSecond = () => withJobModelRuntime(rt, () =>
      withStoryJobLock(secondJob, 'unknown-diagnostic-test', () =>
        diagnoseUnknownCompletion(secondJob, secondCase, model.provider, model.id)));
    await assert.rejects(runSecond(), /budget exhausted/i);
    assert.equal(calls, 2, 'original malformed response was sent only once');
    await configurePiPolicy(secondJob, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 3 } });
    const resumed = await runSecond();
    assert.equal(resumed.signature, secondCase.signature);
    assert.equal(calls, 3, 'original session receives only a format correction');
    assert.equal((await inspectPiPolicy(secondJob)).budget.modelCalls, 2,
      'both original and corrected calls remain in the same job ledger');
    assert.deepEqual(await runSecond(), resumed);
    assert.equal(calls, 3, 'accepted original transcript never receives another model call');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
