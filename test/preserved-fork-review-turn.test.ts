/** Opt-in verification against an EXISTING preserved and authenticated Job.
 * Read-only: never allocates or starts a child, invokes Pi or changes Story.
 * The saved private Story is deliberately not checked into test fixtures. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { collectRecoveryFork } from "../src/recovery-fork.js";
import { readReviewTurnEvidence, projectReviewTurn } from "../src/fork-review-turn.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { verifyCertifiedRecoveryLineage } from "../src/certification-lineage.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;

test(
  "reviewed first Event can become the exact source of a second isolated historical fork",
  { skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to a saved certification root" },
  async () => {
    const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const original = await startStoryJob(
      { story: saved.storyRoot, job: "a4166778-a74d-4128-a283-95accc8705f1" },
      false,
    );
    const parent = await startStoryJob(
      { story: saved.storyRoot, job: "9836aacc-99ca-4f58-b101-b010c2887b72" },
      false,
    );
    const lineage = await verifyCertifiedRecoveryLineage(original, parent);
    assert.equal(lineage?.hops.length, 1);
    assert.equal(lineage?.terminalJobId, parent.jobId);
    const checkpoint = (await inspectRecoveryCheckpoints(parent)).find(
      (point) => point.commitSha === "3e753836cc70144c2497add8f5662dad67e7bdea",
    );
    assert.ok(checkpoint?.eligible && checkpoint.assurance);
    assert.equal(checkpoint.semanticReview, "passed");
    const approved = await readReviewTurnEvidence(parent);
    assert.ok(approved);
    const nested = await collectRecoveryFork(
      parent,
      "bcd45d21-8669-4a36-9d96-e2c364187e77",
      checkpoint.commitSha,
      approved.contract,
      process.env.NT_STUDIO_SKILLS_SOURCE,
    );
    assert.equal(nested.checkpoint.commitSha, checkpoint.commitSha);
    assert.equal(nested.sourceJobId, parent.jobId);
    assert.equal(
      nested.reviewTurn?.source.verifiedSha,
      original.baseSha,
      "The original author Turn remains the canonical reviewer evidence",
    );
    assert.equal(
      nested.reviewCoverage.find((entry) => entry.commitSha === checkpoint.commitSha)?.status,
      "passed",
    );
    const projected = projectReviewTurn(nested.reviewTurn!, {
      jobId: nested.childId,
      baseSha: checkpoint.commitSha,
    } as typeof parent);
    assert.equal(projected.source.verifiedSha, checkpoint.commitSha);
    assert.equal(projected.source.jobId, nested.childId);
  },
);

test(
  "verified historical Character checkpoint admits a review-only original Turn for new Event work",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to a saved certification root",
  },
  async () => {
    const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const source = await startStoryJob(
      { story: saved.storyRoot, job: "a4166778-a74d-4128-a283-95accc8705f1" },
      false,
    );
    const turn = await readReviewTurnEvidence(source);
    assert.ok(turn);
    const original = await collectRecoveryFork(
      source,
      "a47fba52-54f6-43e5-9854-f1bb25a7c99b",
      "b237d8237ce70810a5de89d18d2411b81b2bfee4",
      turn.contract,
      process.env.NT_STUDIO_SKILLS_SOURCE,
    );
    assert.equal(original.reviewTurn?.digest, turn.digest);
    assert.equal(
      original.reviewTurn?.assignments.find((a) => a.id === "event")?.specialist,
      "nt-event-design",
    );
    const child = { jobId: original.childId, baseSha: original.checkpoint.commitSha };
    const review = projectReviewTurn(original.reviewTurn!, child as typeof source);
    assert.notEqual(review.digest, turn.digest);
    assert.equal(review.source.verifiedSha, original.checkpoint.commitSha);
    assert.equal(review.source.jobId, original.childId);
    assert.equal(
      review.assignments.find((a) => a.id === "event")?.outcome,
      turn.assignments.find((a) => a.id === "event")?.outcome,
    );
  },
);

test(
  "preserved legacy fork reproduces the exact unreviewed Event checkpoint bypass",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to a saved certification root",
  },
  async () => {
    const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const child = await startStoryJob(
      { story: saved.storyRoot, job: "86723188-b5aa-4cc9-9169-c034674bac9f" },
      false,
    );
    assert.equal(await readReviewTurnEvidence(child), null);
    const points = (await inspectRecoveryCheckpoints(child)).filter((p) => p.eligible);
    assert.equal(
      points.length,
      3,
      "The original incident, accounts and enacted Choice Events were committed",
    );
    assert.ok(
      points.every((p) => !p.assurance),
      "The historical bug was accepting native commits without independent-review evidence",
    );
    assert.deepEqual(
      points.map((p) => p.workItem),
      ["event-incident-identified", "event-accounts-tested", "event-choice-enacted"],
    );
  },
);

// Exact current-format reproduction: a new admitted writer Turn and historical
// no-write Review seals coexist. Read-only checks must consume the original
// projected Turn rather than relabeling the old verdict with new authority.
test("Luna nested continuation retains independently reviewed Event-only omissions after replacement Turn admission", {
  skip: !process.env.NT_TEST_PRESERVED_OMISSION_JOB || !root,
}, async () => {
  const { readInheritedReviewTurn } = await import("../src/fork-review-turn.js");
  const { readRecoveryFork } = await import("../src/recovery-fork-state.js");
  const { readEventOnlyOmission, readHistoricalEventOnlyOmission } = await import("../src/interactive-event-only.js");
  const { collectReviewedOmissionBatch } = await import("../src/recovery-review-batch.js");
  const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8"));
  const job = await startStoryJob({story:saved.storyRoot,job:process.env.NT_TEST_PRESERVED_OMISSION_JOB!},false);
  const fork = readRecoveryFork(job)!;
  assert.ok(fork.reviewBatch?.entries.length);
  const inherited = readInheritedReviewTurn(job)!;
  const local = (await readReviewTurnEvidence(job))!;
  assert.notEqual(local.digest, inherited.digest);
  for (const entry of fork.reviewBatch!.entries) {
    const slug = entry.milestoneId.slice(10);
    const receipt = JSON.parse(readFileSync(join(job.stateDir,"interactive-items",slug+".json"),"utf8"));
    const ref = receipt.units[0].eventOnly;
    const historical = await readHistoricalEventOnlyOmission(job,entry.milestoneId,ref);
    assert.equal(historical.turnDigest,inherited.digest);
    assert.deepEqual(await readEventOnlyOmission(job,entry.milestoneId,ref),historical);
  }
  const batch = await collectReviewedOmissionBatch(job,fork.checkpoint);
  assert.deepEqual(batch?.entries.map(e=>e.milestoneId),fork.reviewBatch!.entries.map(e=>e.milestoneId));
  assert.equal(batch?.turnDigest,local.digest);
});

// Private source regression: no synthetic approval or Story mutation. Exercise
// the actual conditional correction packet against the current fork authority.
test("Luna Accounts conditional correction identifies the inherited producer and one exact writable path", {
  skip: !process.env.NT_TEST_PRESERVED_ACCOUNTS_JOB || !root,
}, async () => {
  const { readdirSync } = await import("node:fs");
  const { parseMilestoneBlueprintReview } = await import("../src/milestone-blueprint.js");
  const { historicalCanonicalCatalog } = await import("../src/validator.js");
  const { dependencyTurn, dependencyGit, dependencyVersionBase } = await import("../src/dependency-state.js");
  const { reconstructWriterDependency, resolveWriterDependencySources, verifiedPathProducer } = await import("../src/writer-dependency.js");
  const { authorizeWriterDependency } = await import("../src/dependency-amendments.js");
  const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8"));
  const job = await startStoryJob({story:saved.storyRoot,job:process.env.NT_TEST_PRESERVED_ACCOUNTS_JOB!},false);
  const receipt = JSON.parse(readFileSync(join(job.stateDir,"milestone-blueprints/accounts.json"),"utf8"));
  const event = JSON.parse(readFileSync(join(job.stateDir,"event-items/accounts.json"),"utf8"));
  const assessment = JSON.parse(readFileSync(join(job.stateDir,"blueprint-assessments",
    readdirSync(join(job.stateDir,"blueprint-assessments"))[0]!),"utf8"));
  const assign = assessment.context.assignment, draft = receipt.draft;
  const prior = receipt.rounds.at(-1).review.prior.map((p:any)=>p.status==="resolved"?p:{
    ...p,status:"resolved",evidence:{kind:"upstream",targetId:draft.upstreamCorrection.targetId}});
  const conditional = parseMilestoneBlueprintReview(JSON.stringify({
    schema:"noveltea-milestone-blueprint-review/v5",status:"prerequisite",findings:[],prior,
  }),draft,assign,receipt.rounds.slice(0,-1));
  assert.equal(conditional.status,"pass");
  const turn=await dependencyTurn(job), catalog=await historicalCanonicalCatalog(job,job.baseSha);
  const finding=structuredClone(draft.upstreamCorrection);
  assert.throws(()=>resolveWriterDependencySources(job,job.baseSha,finding,catalog),/Missing exact source quotation/);
  const prefix=job.storyRelativePath?job.storyRelativePath+"/":"";
  // Complete the missing linking-record citation only in this test input.
  // This is not a model verdict, and no approval or grant is persisted.
  for(const id of finding.affectedIds){
    const record=catalog.find(r=>r.metadata.id===id)!;
    if(!finding.sources.some((s:any)=>s.path===record.path)){
      const bytes=dependencyGit(job,"show",job.baseSha+":"+prefix+record.path);
      finding.sources.push({path:record.path,quote:bytes.split("\n").find(l=>l.startsWith("id:"))});
    }
  }
  const {source,report,reportDigest}=await reconstructWriterDependency(job,{
    stage:"event",origin:"blueprint",milestoneId:assign.milestoneId,workItemId:event.workItemId,
    planVersion:event.planVersion,sealDigest:"a".repeat(64),assignmentKey:event.assignmentKey,
    head:event.expectedHead,sourcePaths:assign.sourcePaths,obligations:assign.dependencyObligations,finding,
  });
  assert.equal(source.producer.workItem,"event-revelation");
  const first=dependencyGit(job,"log","--reverse","--diff-filter=A","--format=%H",job.baseSha,"--",prefix+source.targetPath).split("\n")[0]!;
  assert.equal((await verifiedPathProducer(job,turn.digest,first,source.targetPath)).workItem,"event-reconstruction");
  await assert.rejects(verifiedPathProducer(job,"0".repeat(64),first,source.targetPath),/inherited producer/);
  const version=dependencyVersionBase(job);
  const grant=authorizeWriterDependency({plan:turn,head:job.baseSha,report,reportDigest,
    proposal:{sourceSha:report.sourceSha,reportDigest,target:source.targetId,specialist:report.likelySpecialist,
      outcome:report.missing,reason:"Test-only source authorization preflight"},
    records:catalog,sources:report.sources,version,versionBase:version,source,priorAmendments:[]});
  assert.deepEqual(grant.assignment.authority.existingPaths,["events/reconstruct-access-mismatch.md"]);
  assert.equal(grant.assignment.authority.mayCreate,false);
  assert.equal(dependencyGit(job,"rev-parse","HEAD"),job.baseSha);
  assert.equal(dependencyGit(job,"status","--porcelain"),"");
});

test("latest Luna duplicate Blueprint response and ordinary omission impact replay", {
  skip: !root || !process.env.NT_TEST_PRESERVED_LATEST_JOB,
}, async () => {
  const {createHash} = await import("node:crypto");
  const {assertBlueprintReplies,parseMilestoneBlueprintReview} = await import("../src/milestone-blueprint.js");
  const {affectedEventOnlyOmissions,readHistoricalEventOnlyOmission,reviewedOmissionSuccessor} = await import("../src/interactive-event-only.js");
  const saved = JSON.parse(readFileSync(join(root!,"certification-source.json"),"utf8"));
  const job = await startStoryJob({story:saved.storyRoot,job:process.env.NT_TEST_PRESERVED_LATEST_JOB!},false);
  const record = JSON.parse(readFileSync(join(job.stateDir,"milestone-blueprints/contradiction.json"),"utf8"));
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const assignment = {milestonePath:"milestones/contradiction.md",sourcePaths:[...new Set<string>(
    record.rounds.flatMap((r:any)=>[...r.review.findings.map((f:any)=>f.anchorPath),
      ...r.draft.events.flatMap((e:any)=>e.evidence.map((x:any)=>x.anchorPath))]))]};
  await assertBlueprintReplies(record.writer,record.rounds.map((r:any)=>r.draftDigest));
  await assertBlueprintReplies(record.reviewer,record.rounds.map((r:any)=>r.reviewerVerdict?sha(r.reviewerVerdict):r.reviewDigest),
    (text,i)=>parseMilestoneBlueprintReview(text,record.rounds[i].draft,assignment as any,record.rounds.slice(0,i),"sealed-replay"));
  const head = "13d1ca5a39f248fd7df7b14740286292e21cc3a6";
  const impact = await affectedEventOnlyOmissions(job,job.baseSha,head,["events/reconstruct-access-mismatch.md"]);
  assert.deepEqual(impact.map(p=>p.milestoneId),["milestone.revelation"]);
  const seal = JSON.parse(readFileSync(join(job.stateDir,"interactive-event-only/revelation.json"),"utf8"));
  const original = await readHistoricalEventOnlyOmission(job,"milestone.revelation",{nonce:seal.nonce,digest:seal.digest});
  assert.equal(await reviewedOmissionSuccessor(job,original,seal.digest,head),null,
    "an unreviewed ordinary commit cannot confer live omission authority");
});

test("Luna inherited negative revalidation retains the exact passed Revelation owner", {
  skip: !process.env.NT_TEST_INHERITED_DEPENDENT_JOB || !root,
}, async () => {
  const {inheritedDependentSource}=await import("../src/dependent-correction-work.js");
  const {inheritedReviewedCheckpoint}=await import("../src/recovery-fork-state.js");
  const {proposeDependentCorrection}=await import("../src/selective-revalidation.js");
  const saved=JSON.parse(readFileSync(join(root!,"certification-source.json"),"utf8"));
  const job=await startStoryJob({story:saved.storyRoot,job:process.env.NT_TEST_INHERITED_DEPENDENT_JOB!},false);
  const state=JSON.parse(readFileSync(join(job.stateDir,"revalidation-items","d981a60d9bf70113fa60978affc7e5f54e03dce9.json"),"utf8"));
  const negative=state.results.find((r:any)=>r.itemId==="event:milestone.revelation"&&r.status==="failed");
  assert.ok(negative);
  const inherited=inheritedReviewedCheckpoint(job,"event-revelation",negative.originalCommitSha)!;
  assert.equal(inherited.status,"passed");
  const turn=await readReviewTurnEvidence(job);
  const original=turn!.assignments.find(a=>a.id==="event")!;
  const proposal=proposeDependentCorrection({
    plan:state.proposal,item:{id:negative.itemId} as any,originalCommitSha:negative.originalCommitSha,
    assignmentId:original.id,specialist:original.specialist,originalReviewDigest:negative.originalReviewDigest,
    revalidationReviewDigest:negative.reviewerDigest,ownerPaths:inherited.proof.assurance!.changedPaths,
    blockingPaths:negative.findings.map((f:any)=>f.path),currentHeadSha:negative.sourceSha,originalObligation:original.outcome,
  });
  const source=await inheritedDependentSource(job,proposal);
  assert.equal(source?.proof.commitSha,negative.originalCommitSha);
  assert.equal(source?.model,"gpt-6-luna");
  await assert.rejects(inheritedDependentSource(job,{...proposal,itemId:"event:milestone.accounts"}),/original Milestone owner/);
  await assert.rejects(inheritedDependentSource(job,{...proposal,authorizedPaths:["creative-direction/foundation.md"]}),/exact independently reviewed owner/);
});

test("Luna cross-owner foundations rejection resolves to inherited Architecture, not Character writer",{
  skip:!root||!process.env.NT_TEST_CROSS_OWNER_JOB,
},async()=>{
  const {inheritedDependentSource}=await import("../src/dependent-correction-work.js");
  const {inheritedReviewedCheckpoint}=await import("../src/recovery-fork-state.js");
  const {proposeDependentCorrection}=await import("../src/selective-revalidation.js");
  const {createHash}=await import("node:crypto");
  const saved=JSON.parse(readFileSync(join(root!,"certification-source.json"),"utf8"));
  const job=await startStoryJob({story:saved.storyRoot,job:process.env.NT_TEST_CROSS_OWNER_JOB!},false);
  const state=JSON.parse(readFileSync(join(job.stateDir,"revalidation-items","e680ddd48fe4b543d66a6eb9610a2602954622e5.json"),"utf8"));
  const neg=state.results.find((r:any)=>r.itemId==="foundations"&&r.status==="failed");
  assert.ok(neg);
  const turn=await readReviewTurnEvidence(job);
  const owner=turn!.assignments.find(a=>a.id==="architecture")!;
  const affected=turn!.assignments.find(a=>a.id==="foundations")!;
  const inherited=inheritedReviewedCheckpoint(job,"global-architecture",state.proposal.rootUpstreamCommitSha)!;
  assert.equal(inherited.status,"passed");
  const digest=createHash("sha256").update(JSON.stringify([inherited.reviewDigest])).digest("hex");
  const options={plan:state.proposal,item:{id:neg.itemId} as any,originalCommitSha:inherited.proof.commitSha,
    assignmentId:owner.id,specialist:owner.specialist,originalReviewDigest:digest,
    revalidationReviewDigest:neg.reviewerDigest,ownerPaths:inherited.proof.assurance!.changedPaths,
    blockingPaths:neg.findings.map((f:any)=>f.path),currentHeadSha:neg.sourceSha,originalObligation:owner.outcome,
    upstreamOwner:{itemId:"architecture",affectedCommitSha:neg.originalCommitSha,
      affectedReviewDigest:neg.originalReviewDigest,affectedAssignmentId:affected.id,affectedObligation:affected.outcome}};
  const proposal=proposeDependentCorrection(options);
  assert.deepEqual(proposal.authorizedPaths,["milestones/reckoning.md"]);
  const source=await inheritedDependentSource(job,proposal);
  assert.equal(source?.proof.workItem,"global-architecture");
  assert.equal(source?.model,"gpt-6-luna");
  assert.throws(()=>proposeDependentCorrection({...options,blockingPaths:["milestones/accounts.md"]}),/upstream grant/);
  await assert.rejects(inheritedDependentSource(job,{...proposal,assignmentId:"foundations"}),/exact independently reviewed owner/);
});
