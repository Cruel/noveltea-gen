import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { JobStartResult } from './job.js';
import { assertNativeVersion, nativeExecutable } from './native-cli-version.js';

export interface StoryMetricsFinding {
  dimension: string;
  code: string;
  status: string;
  severity: string;
  firmness?: 'hard' | 'soft';
  count?: number | null;
  limit?: number;
  path?: string;
  pointer?: string;
  evidence?: string;
}
export interface StoryArchitectureMetrics {
  metricsVersion: 1;
  contractRevision: string;
  catalogSourceRevision: string;
  sourceRevisions: Array<{ path: string; sourceRevision: string }>;
  foundation: {
    status: string;
    targetCoverage: string;
    approvedFirstPlaythroughMinutes: { min_minutes: number; max_minutes: number } | null;
    productionBudget: unknown;
  };
  coverage: { missingNarrative: number; missingExploration: number;
    searchTruncated: boolean; unresolvedAlternatives: number };
  route: { status: string; narrativeMinutes: unknown; explorationMinutes: unknown; totalMinutes: unknown };
  routeCoverage: { status: string; truncated: boolean };
  contentFootprint: { illustrationConceptCount: number | null;
    illustrationVariantCount: number | null; characterArtworkTiers: unknown;
    classificationCoverage: string };
  budgetFindings: StoryMetricsFinding[];
}
export interface ArchitectureBudgetReview {
  /** Exact native source identity, distinct from the controller's trusted Git SHA. */
  catalogSourceRevision: string;
  sourceRevisionsDigest: string;
  contractRevision: string;
  trustedBaseSha: string;
  metrics: Pick<StoryArchitectureMetrics, 'foundation' | 'coverage' | 'route' |
    'routeCoverage' | 'contentFootprint'>;
  findings: StoryMetricsFinding[];
  warnings: string[];
  requiresAuthorDirection: string[];
}

/** Do not replace the native analyzer with a TS Story parser. This is a strict
 * admission adapter to the optional, read-only CLI metrics operation. */
export function nativeStoryMetrics(job: JobStartResult): StoryArchitectureMetrics {
  assertNativeVersion(job.validatorVersion);
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'])
    delete env[key];
  const run = spawnSync(nativeExecutable(),
    ['--json', 'narrative', 'metrics', job.worktreeStoryRoot], {
      cwd: job.worktreeRoot, env, encoding: 'utf8', timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  if (run.error || run.signal || run.status !== 0)
    throw new Error('Native Narrative metrics unavailable or rejected the canonical Story: ' +
      (run.error?.message ?? run.stderr?.trim() ?? 'invalid CLI status'));
  let envelope: unknown;
  try { envelope = JSON.parse(run.stdout); }
  catch { throw new Error('Native Narrative metrics did not return JSON.'); }
  const response = envelope as { protocolVersion?: number; success?: boolean;
    exitCode?: number; diagnostics?: unknown[]; metrics?: StoryArchitectureMetrics };
  if (!response || response.protocolVersion !== 1 || response.success !== true ||
    response.exitCode !== 0 || !Array.isArray(response.diagnostics) ||
    response.diagnostics.length || !response.metrics)
    throw new Error('Native Narrative metrics returned an invalid protocol envelope.');
  return response.metrics;
}

/** Bind source, coverage and budget decisions to the canonical validator's
 * record inventory. Absence/uncertainty is NOT zero or a compliant budget. */
export function reviewArchitectureMetrics(metrics: StoryArchitectureMetrics,
  records: Array<{ path: string }>, contractRevision: string,
  trustedBaseSha: string): ArchitectureBudgetReview {
  if (metrics.metricsVersion !== 1 || metrics.contractRevision !== contractRevision ||
    !/^xxh3-128:[a-f0-9]{32}$/.test(metrics.catalogSourceRevision) ||
    !Array.isArray(metrics.sourceRevisions) || !Array.isArray(metrics.budgetFindings) ||
    !metrics.coverage || !metrics.route || !metrics.routeCoverage ||
    !metrics.foundation || !metrics.contentFootprint ||
    typeof metrics.routeCoverage.status !== 'string' ||
    typeof metrics.coverage.searchTruncated !== 'boolean')
    throw new Error('Native Narrative metrics did not supply supported, complete source evidence.');
  const paths = records.map(record => record.path).sort();
  const sources = metrics.sourceRevisions.map(record => record.path).sort();
  if (JSON.stringify(paths) !== JSON.stringify(sources) ||
    new Set(sources).size !== sources.length ||
    metrics.sourceRevisions.some(source => !/^xxh3-128:[a-f0-9]{32}$/.test(source.sourceRevision)))
    throw new Error('Native Narrative metrics were not bound to the validated canonical record inventory.');
  for (const finding of metrics.budgetFindings) {
    if (!finding || typeof finding.code !== 'string' || typeof finding.status !== 'string' ||
      typeof finding.dimension !== 'string' ||
      !['hard-violation', 'soft-overage', 'unverified', 'unapproved',
        'within-budget', 'within-target', 'target-overrun', 'target-underrun', 'target-risk']
        .includes(finding.status))
      throw new Error('Native Narrative metrics returned unsupported budget findings.');
  }
  const warnings: string[] = [];
  const requiresAuthorDirection: string[] = [];
  for (const finding of metrics.budgetFindings) {
    if (finding.status === 'hard-violation') {
      requiresAuthorDirection.push(`${finding.dimension}: ${finding.count} exceeds hard limit ${finding.limit} (${finding.path ?? 'Creative Direction'}${finding.pointer ?? ''})`);
    } else if (finding.status === 'soft-overage') {
      warnings.push(`${finding.dimension}: ${finding.count} exceeds soft preference ${finding.limit}; independently review scope and seek author direction for material expansion.`);
    } else if (['unverified', 'unapproved', 'target-overrun', 'target-underrun', 'target-risk'].includes(finding.status)) {
      warnings.push(`${finding.dimension}: ${finding.status}; no precise coverage or approval inferred.`);
    }
  }
  if (metrics.coverage.missingNarrative || metrics.coverage.missingExploration ||
    metrics.coverage.searchTruncated || metrics.routeCoverage.status !== 'bounded-complete')
    warnings.push('Route duration/coverage remains uncertain; do not present estimates as exact playtime.');
  if (metrics.contentFootprint.classificationCoverage !== 'declared-exhaustive')
    warnings.push('Artwork and distinct content footprint remain provisional until source-backed declarations are complete.');
  const sourceRevisionsDigest = createHash('sha256')
    .update(JSON.stringify(metrics.sourceRevisions)).digest('hex');
  return { catalogSourceRevision: metrics.catalogSourceRevision,
    sourceRevisionsDigest, contractRevision, trustedBaseSha,
    metrics: { foundation: metrics.foundation, coverage: metrics.coverage,
      route: metrics.route, routeCoverage: metrics.routeCoverage,
      contentFootprint: metrics.contentFootprint },
    findings: metrics.budgetFindings, warnings, requiresAuthorDirection };
}
