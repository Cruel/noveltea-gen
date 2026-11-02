# Historical Skein Agent Protocol qualification (#39)

**Retired in favor of the dedicated NovelTea LangGraph agent.** This document preserves the 2026-10-31 research results. The Skein host, dependencies and qualification tests have been removed; commands below are historical and no longer runnable. Production web jobs run on the dedicated NovelTea agent process.

**2026-10-31.** The real NovelTea `story_generation` LangGraph.js graph works with Skein's single-process SQLite deployment on this Linux/Node 24 checkout. This is a **qualification spike**, not a production-ready, authenticated, publicly accessible server or an authorization to move old CLI checkpoints.

## Version selection

- `@skein-js/local`, `@skein-js/agent-protocol`, `@skein-js/express`: **0.23.0** (pre-alpha).
- `@langchain/langgraph`: **1.5.2** (unchanged).
- `@langchain/langgraph-checkpoint-sqlite`: **1.0.4** (changed from 1.1.0). Skein local's declared peer dependency is `~1.0.4`; keeping 1.1.0 would be outside its supported peer range. The existing independent `author-updates/checkpoints.sqlite` graph also runs on 1.0.4, and the normal repository regression suite must be run whenever either version changes.
- `@langchain/langgraph-sdk`: **1.12.9**.

Skein's one-process SQLite store is not a distributed deployment. Production multi-instance deployment requires separately qualified shared drivers. Skein reports lost in-progress attempts as errors; **it does not automatically replay a crashed writer**, which is consistent with NovelTea's fail-closed recovery design. Do not regard a successful server restart during a paused checkpoint as proof of safe SIGKILL recovery during an active Pi edit.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm exec tsx --test test/skein-qualification.test.ts
pnpm check

# Opt-in paid model smoke against the real Story graph (default: openai/gpt-6-luna).
NT_LIVE_SKEIN=1 NT_NATIVE_CLI=/absolute/path/to/noveltea \
  pnpm exec tsx --test --test-name-pattern='opt-in real Pi foundation' test/skein-qualification.test.ts
```

The test starts `src/skein-qualification-host.ts` on an ephemeral **loopback-only** port with a private absolute SQLite path under a disposable test directory. The host is for testing only: it lacks web-service authentication, rate limits, per-user credential isolation, sandboxing, deployment supervision, and server-side admission from a trusted web controller. **Do not expose this host to external clients.** It does not replace `pnpm studio` or add an HTTP/SSE fallback server.

## Verified boundaries

- The real `story_generation` graph (not a toy replacement) runs a fixture foundation stage through Skein and later resumes the original thread after terminating and restarting the server against the same SQLite database. The later fixture specialists finish with an honest editorial-unverified block; the author Git HEAD remains intact.
- The **Skein protocol** persists a LangGraph approval interrupt through a server restart, and progresses only after a client sends an explicit `command.resume`. The `approval_probe` graph is isolated to this qualification host; it is **not** the trusted NovelTea protected-decision approval workflow.
- NovelTea's independent author-update graph persists a real author **question** across server restart. The parent generation thread reports the pending blocker, then continues only after `job author resume` submits the exact typed answer. This tests interoperability of the **separate** checkpoint stores, not a completed web approval integration. Signed protected approvals remain unchanged pending #57/#58/#65.
- A durable `generation-server-owner.json` binds a Story job to its first API/Studio thread and the exact normalized generation request. Another server thread, changed request, or competing CLI generator cannot take over the job's checkpoints. A job with an existing CLI generation checkpoint or active CLI generation lease cannot be claimed by a server thread. The owner receipt is never automatically reset on restart. This deliberately prevents silent migration/reassignment; operational transfer requires a separately designed, verified procedure.
- The opt-in real Pi run used the server-hosted production graph with fixture mode **off**, actually authored and committed Creative Direction into the job worktree, and left the author branch untouched. It checks the runtime transport and worktree boundary, not prose quality or a complete narrative.

## Remaining certification limits

- No simulated mid-Pi `SIGKILL` or independent real-model stress test, worker relocation, distributed Postgres/Redis deployment, long-lived SSE replay, or authentication/security review was performed by #39. The existing Story writer receipts and locks, separate author approvals, and future server admission control must be tested again as #59/#65/#55 integrate the web service.
- The qualification also confirms Skein rejects a second **overlapping run** on the same thread when `multitaskStrategy: "reject"` is requested. Future trusted web admission must make this policy mandatory; the durable owner receipt handles **different threads**, not overlapping runs on the same thread. The existing per-work-item locks and receipts still fence crash windows.
- The SQLite store is owned exclusively by one server process. It must not be mounted simultaneously by another process, and the durable database and Job/Pi state directories must survive restarts together.
- Server-mediated approval authorization must be added later by the trusted controller. A raw Agent Protocol `command.resume` is not proof that the caller is a permitted NovelTea author. Keep the host loopback-only until that integration exists.

The result is **compatible for a controlled one-process prototype**, not a promise of production-grade reliability. No fallback server was implemented.
