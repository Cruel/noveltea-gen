/** C05: only an internally inconsistent *independently certified* final
 * report can reach unfamiliar-failure diagnosis. Missing normal acceptance,
 * pending Turn Review, author/resource pauses, and fixture verdicts are NOT
 * diagnostic evidence or permission to replace the original reviewer. */
import type { JobReport } from "./job-report.js";

export function isTrustedFinalVerdictAnomaly(report: JobReport): boolean {
  const { generation: result, identity, evidence } = report;
  return result.status === "blocked" && identity.clean &&
    result.blockers.length === 0 &&
    result.scopeFulfillment === "complete-in-scope" &&
    (result.planFulfillment.status === "passed" ||
      result.planFulfillment.status === "not-applicable") &&
    result.review?.phase === "completed" && result.review.worker === "pi" &&
    result.review.current && evidence.editorial.verdict === "pass" &&
    evidence.scope?.deterministic === "passed" &&
    evidence.protection.status === "checked" &&
    result.author.executionControl === "running" &&
    !result.author.budgetPause && !result.author.pending.length &&
    !evidence.authorApprovals.required &&
    evidence.deferredIdeas.status === "ready" &&
    !evidence.deferredIdeas.scopedOutstanding.length &&
    !evidence.scope.diagnostics.some(d => d.severity === "blocking");
}
