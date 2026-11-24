// Real Studio persistence, auth and queue integration for the production
// specialist question regression. Only Pi transport and prerequisite setup
// are deterministic fixtures.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openStudioDatabase, migrateStudio } from "../web/test/support/studio-database.js";
import { createStudioAuth } from "../web/src/lib/auth.js";
import { acquireCachedStory } from "../web/src/lib/git-cache.server.js";
import { authorInteractionRequest } from "../web/src/lib/author-interactions.server.js";
import { ensureRootThreads } from "../web/src/lib/threads.server.js";
import { associateNaturalThread } from "../web/src/lib/natural-story.server.js";
import { readThreadChat } from "../web/src/lib/thread-chat.server.js";
import { runPersistedGeneration } from "../web/src/agent-runner.js";
import { userPiCredentials } from "../web/src/lib/pi-credentials.server.js";
import { claimServerGeneration, ensureNotServerOwned } from "../src/generation-owner.js";
import { inspectSpecialistChoice, type SpecialistChoiceReceipt } from "../src/specialist-choice.js";
import { type GenerationRequest } from "../src/generation.js";
import { scriptedModel } from "./c03-scripted-story-helpers.js";

export async function prepareAuthorStudio(root: string, repo: string, initial: string, objective: string) {
  const config = { baseURL: "http://localhost:3000", secret: "test-only-r14i-studio-secret-000000000000000",
    github: { clientId: "test", clientSecret: "test" }, gitlab: { clientId: "test", clientSecret: "test" } };
  const db = join(root, "r14i-studio.sqlite");
  let store = openStudioDatabase(db);
  await migrateStudio(store, config);
  let auth = createStudioAuth(store, config);
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({ name: "Author", email: "author@r14i.test", emailVerified: true }, { method: "test" });
  const session = await context.internalAdapter.createSession(user.id);
  const cookie = "better-auth.session_token=" + session.token + "." +
    createHmac("sha256", config.secret).update(session.token).digest("base64");
  const jobId = randomUUID(), storyId = randomUUID(), repoId = randomUUID(), now = new Date().toISOString();
  const job = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: user.id,
    repositoryId: "github:123", remoteUrl: "file://" + repo, token: "", directory: "story", commit: initial, jobId });
  await store.persistence.repositories.upsert(user.id, "github", "123", "Fixture/Story", null, repoId, now);
  await store.persistence.onboarding.importStory({ id: storyId, owner: user.id, repositoryId: repoId, directory: "story",
    title: "Story", commitSha: initial, createdAt: now });
  await store.persistence.generation.jobs.register(user.id, jobId, storyId, "Job", initial, now);
  await ensureRootThreads(store, user.id, storyId);
  const chat = await associateNaturalThread(store, user.id, storyId, jobId, objective);
  const api = async (method: "GET" | "POST", body?: unknown) => {
    const response = await authorInteractionRequest(auth, store, new Request(config.baseURL + "/api/jobs/" + jobId + "/author", {
      method, headers: { cookie, ...(method === "POST" ? { origin: config.baseURL, "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }), jobId, config.baseURL);
    return { status: response.status, data: await response.json() as any };
  };
  return { job, owner: user.id,
    async admit(request: GenerationRequest, thread: string) {
      await claimServerGeneration(job, thread, request);
      assert.throws(() => ensureNotServerOwned(job), /server-owned/);
      await store.testing.records.update("studio_sessions", { id: jobId }, {
        generationConfigJson: JSON.stringify({ model: { provider: scriptedModel.provider, id: scriptedModel.id } }),
      });
      await store.persistence.generation.queue.enqueue(user.id, jobId, "start", "prepared", now, JSON.stringify(request), thread);
      const worker = "fixture:r14i-initial";
      assert.equal((await store.persistence.generation.queue.claim(worker, 1, now))?.jobId, jobId);
      assert.equal(await store.persistence.generation.queue.finish(jobId, worker, true, now), true);
      await store.persistence.generation.jobs.authorDecision(user.id, jobId, "paused", now);
    },
    async resume(choice: SpecialistChoiceReceipt, runtime: ModelRuntime) {
      const view = await api("GET");
      assert.equal(view.status, 200, JSON.stringify(view.data));
      assert.equal(view.data.choice.id, choice.id);
      assert.equal(view.data.choice.question.question, choice.question.question);
      assert.equal((await readThreadChat(store, user.id, chat)).runs.some(r => r.jobId === jobId), true);
      const drafts = { answer: { selection: "", selectedIds: [], multiCustom: false, customAnswer: "The sealed ledger.", note: "" } };
      const draft = await api("POST", { action: "choice-draft", id: choice.id, proposalSha256: choice.proposalSha256, draftRevision: 1, drafts });
      assert.equal(draft.status, 200, JSON.stringify(draft.data));
      await store.close();
      store = openStudioDatabase(db);
      auth = createStudioAuth(store, config);
      assert.deepEqual((await api("GET")).data.choice.draft.drafts, drafts);
      assert.equal((await inspectSpecialistChoice(job, choice.id)).answer, undefined);
      const payload = { action: "choice", id: choice.id, proposalSha256: choice.proposalSha256,
        draftRevision: 2, kind: "custom", text: "The sealed ledger." };
      assert.equal((await api("POST", { ...payload, draftRevision: 1 })).status, 409);
      const accepted = await api("POST", payload);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      assert.equal(accepted.data.continuation, "queued", JSON.stringify(accepted.data));
      assert.equal((await api("POST", payload)).status, 200);
      assert.equal((await api("POST", { ...payload, text: "Other" })).status, 409);
      await userPiCredentials(store, user.id).modify(scriptedModel.provider, async () => ({ type: "api_key", key: "fixture-only" }));
      // The real user runtime is created with the owner-bound credential
      // adapter. Install the deterministic provider transport for this test.
      const create = ModelRuntime.create;
      const provider = runtime.getProvider(scriptedModel.provider)!;
      ModelRuntime.create = async options => {
        const scoped = await create.call(ModelRuntime, options);
        scoped.registerNativeProvider(provider);
        await scoped.refresh({ allowNetwork: false, providers: [scriptedModel.provider] });
        return scoped;
      };
      try {
        const worker = "fixture:r14i-resume";
        const item = await store.persistence.generation.queue.claim(worker, 1, now);
        assert.ok(item);
        await runPersistedGeneration(store, item);
        assert.equal(await store.persistence.generation.queue.finish(jobId, worker, true, now), true);
        const { openWebGenerationGraph } = await import("../src/web-fixture-runtime.js");
        const { saver, graph } = openWebGenerationGraph(join(job.stateDir, "web-generation.sqlite"));
        try {
          const snapshot = await graph.getState({ configurable: { thread_id: job.threadId + ":generation:web" } });
          assert.equal((await store.persistence.generation.jobs.state(user.id, jobId))?.status, "paused",
            JSON.stringify({ reason: snapshot.values.reason, failures: snapshot.values.failures,
              recovery: snapshot.values.recoverySources, tasks: snapshot.tasks }));
        } finally { saver.db.close(); }
        assert.equal((await api("GET")).data.choice.question.question, "Why does the witness protect the custodian?");
      } finally { ModelRuntime.create = create; }
    },
    close: () => store.close(),
  };
}
