import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { canonicalPinnedReadPath, completedPinnedSkillReads, requirePinnedSkillReads, correctReadOnlyPinnedMethodology } from "../src/pinned-skill-reads.js";

test("snapshot roots containing /skills/ credit successful pinned skill:// reads", async () => {
  const root = "/tmp/cert/skills/abc123";
  const required = ["nt-interactive-narrative/SKILL.md",
    "nt-catalog/references/authority-and-validation.md", "nt-catalog/references/glossary.md"]
    .map(name => root + "/skills/" + name);
  const messages = [
    { role: "assistant", content: required.map((name, index) => ({
      type: "toolCall", name: "read", id: "ref" + index,
      arguments: { path: "skill://" + name.slice((root + "/skills/").length) },
    })) },
    ...required.map((_, index) => ({ role: "toolResult", toolCallId: "ref" + index, isError: false })),
  ] as unknown as AgentSession["messages"];
  assert.deepEqual(await requirePinnedSkillReads({ messages } as AgentSession,
    "/story/job", required, "Interactive specialist"), required);
});

test("counts only completed exact skill reads, never typo paths or failed tool calls", () => {
  const root = "/story/job";
  const correct = "/snapshots/known/skills/nt-catalog/SKILL.md";
  const messages = [
    { role: "assistant", content: [
      { type: "toolCall", name: "read", id: "valid", arguments: { path: correct } },
      { type: "toolCall", name: "read", id: "typo", arguments: { path: "/snapshots/kn0wn/skills/nt-catalog/references/records.md" } },
      { type: "toolCall", name: "read", id: "failed", arguments: { path: "/snapshots/known/skills/nt-catalog/references/progression.md" } },
      { type: "toolCall", name: "bash", id: "shell", arguments: { path: "/snapshots/known/skills/nt-worldbuilding/SKILL.md" } },
    ] },
    { role: "toolResult", toolCallId: "valid", isError: false },
    { role: "toolResult", toolCallId: "typo", isError: true },
    { role: "toolResult", toolCallId: "failed", isError: true },
    { role: "toolResult", toolCallId: "shell", isError: false },
  ] as unknown as AgentSession["messages"];
  assert.deepEqual(completedPinnedSkillReads(messages, root), [correct]);
  messages.push({ role: "assistant", content: [
    { type: "toolCall", name: "read", id: "retry", arguments: { path: "/snapshots/known/skills/nt-catalog/references/progression.md" } },
  ] } as AgentSession["messages"][number]);
  messages.push({ role: "toolResult", toolCallId: "retry", isError: false } as AgentSession["messages"][number]);
  assert.deepEqual(completedPinnedSkillReads(messages, root), [correct,
    "/snapshots/known/skills/nt-catalog/references/progression.md"]);
});

test("successful short-address reads record original pinned paths, not model-visible aliases", () => {
  const root = "/story/job", snapshot = "/snapshots/known";
  const messages = [
    { role: "assistant", content: [
      { type: "toolCall", name: "read", id: "short", arguments: { path: "skill://nt-catalog/references/records.md" } },
      { type: "toolCall", name: "read", id: "rejected", arguments: { path: "skill://nt-catalog/../nt-story-orchestrate/SKILL.md" } },
    ] },
    { role: "toolResult", toolCallId: "short", isError: false },
    { role: "toolResult", toolCallId: "rejected", isError: true },
  ] as unknown as AgentSession["messages"];
  assert.deepEqual(completedPinnedSkillReads(messages, root, snapshot),
    ["/snapshots/known/skills/nt-catalog/references/records.md"]);
  assert.equal(canonicalPinnedReadPath("skill://nt-catalog/../nt-story-orchestrate/SKILL.md", root, snapshot), "");
  assert.equal(canonicalPinnedReadPath("events/opening.md", root, snapshot), "/story/job/events/opening.md");
});

test("read-only methodology correction consumes one same-session read-only prompt; never trusts a self report", async () => {
  const root = "/story/job", snapshotRoot = "/snapshots/pinned";
  const resources = ["nt-story-orchestrate/SKILL.md", "nt-catalog/references/records.md"];
  for (const mode of ["complete", "recover", "still-missing", "interrupted", "unsafe-tools"] as const) {
    const messages: any[] = [
      {role:"assistant",content:[{type:"toolCall",name:"read",id:"first",arguments:{path:"skill://"+resources[0]}}]},
      {role:"toolResult",toolCallId:"first",isError:false},
      {role:"assistant",content:[{type:"toolCall",name:"read",id:"second",arguments:{path:"skill://"+resources[1]}}]},
      {role:"toolResult",toolCallId:"second",isError:mode!=="complete"},
      {role:"assistant",stopReason:mode==="interrupted"?"aborted":"stop",content:[{type:"text",text:"{}"}]},
    ];
    const originalTools = mode==="unsafe-tools"?["read","write"]:["read","grep","find","ls"];
    let active = [...originalTools], admitted=0, prompts=0;
    const session = {messages,getActiveToolNames:()=>[...active],setActiveToolsByName:(names:string[])=>{active=[...names]}};
    const run=()=>correctReadOnlyPinnedMethodology({
      session:session as unknown as AgentSession,root,snapshotRoot,resources,
      expectedResponse:"the original dependency JSON",
      beforeCorrection:async()=>{admitted++;},
      prompt:async feedback=>{
        prompts++;
        assert.equal(admitted,1);
        assert.deepEqual(active,["read"]);
        assert.match(feedback,/same read-only Pi session/);
        assert.match(feedback,/skill:\/\/nt-catalog\/references\/records\.md/);
        assert.doesNotMatch(feedback,/skill:\/\/nt-story-orchestrate\/SKILL\.md/);
        assert.doesNotMatch(feedback,/\/snapshots\/pinned/);
        messages.push(
          {role:"assistant",content:[{type:"toolCall",name:"read",id:"corrected",arguments:{path:"skill://"+resources[1]}}]},
          {role:"toolResult",toolCallId:"corrected",isError:mode==="still-missing"},
          {role:"assistant",stopReason:"stop",content:[{type:"text",text:"{}"}]});
      },
    });
    if(mode==="complete" || mode==="recover") await run();
    else await assert.rejects(run,mode==="still-missing"?/exhausted its one continuation/:
      mode==="interrupted"?/completed original response/:/read-only tool authority/);
    assert.equal(prompts,mode==="recover" || mode==="still-missing"?1:0);
    assert.equal(admitted,prompts);
    assert.deepEqual(active,originalTools);
  }
});
