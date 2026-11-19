import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenerationGraph } from "../src/generation.js";

test("one production graph routes native prerequisite preflight before Composition", async () => {
  const graph = await createGenerationGraph().getGraphAsync();
  for (const id of ["author_update_intake", "specialist_dispatch",
    "independent_assignment_review", "verify_committed_work"])
    assert.ok(graph.nodes[id], "Missing production graph node: " + id);
  const edges = graph.edges.map(({ source, target }) => source + "->" + target);
  assert.ok(edges.includes("author_update_intake->specialist_dispatch"));
  assert.ok(edges.includes("specialist_dispatch->author_update_intake"));
  assert.equal(graph.nodes["cross_domain_closeout"], undefined,
    "Prerequisite correction must reuse the original specialist dispatch, not add a recovery graph.");
});
