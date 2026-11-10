/**
 * Gate 0 PostgreSQL transaction feasibility certificate.
 *
 * Uses #127's opt-in Compose topology with a unique project and volume.
 * Tests native PostgreSQL primitives and the shared Kysely transaction boundary.
 * The conformance mode additionally exercises the composed StudioStore on both backends.
 * Never starts Studio or touches an existing developer DB.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

const root = resolve(".");
const project = "nt-pg-tx-" + randomUUID().slice(0, 12);
const volume = project + "-postgres";
const credentials = {
  NT_PG_ADMIN_PASSWORD: randomBytes(32).toString("hex"),
  NT_PG_APP_PASSWORD: randomBytes(32).toString("hex"),
  NT_PG_CONTROLLER_PASSWORD: randomBytes(32).toString("hex"),
  NT_PG_VOLUME_NAME: volume,
};
const env = { ...process.env, ...credentials };
const files = [
  "-p",
  project,
  "-f",
  "compose.yaml",
  "-f",
  "compose.postgres.yaml",
  "-f",
  "compose.postgres.test.yaml",
];
const lock = 814615239;
let postgresContainer = "";

function docker(args: string[], acceptFailure = false): string {
  const result = spawnSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || (!acceptFailure && result.status !== 0)) {
    // Do not include commands, environment variables, or disposable passwords in logs.
    throw new Error(
      "PostgreSQL audit Docker operation failed: " +
        (result.stderr || result.error?.message || "exit status " + result.status),
    );
  }
  return result.stdout.trim();
}

function compose(...args: string[]): string {
  return docker(["compose", ...files, ...args]);
}

function volumeExists(): boolean {
  // Docker returns the JSON empty array on some versions when inspect misses.
  const inspected = docker(["volume", "inspect", volume], true);
  return inspected !== "" && inspected !== "[]";
}

/** Each invocation uses a new PostgreSQL TCP session and the application role. */
function psqlArgs(): string[] {
  return [
    "exec",
    "-i",
    "-e",
    "PGPASSWORD=" + credentials.NT_PG_APP_PASSWORD,
    postgresContainer,
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    "noveltea_app",
    "-d",
    "noveltea",
    "-X",
    "-q",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "-",
  ];
}

function query(script: string): string {
  const result = spawnSync("docker", psqlArgs(), {
    cwd: root,
    env,
    input: script,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new Error(
      "PostgreSQL audit query failed: " +
        (result.stderr || result.error?.message || "exit status " + result.status),
    );
  return result.stdout.trim();
}

/**
 * Keep one PostgreSQL session open while the caller probes a second session.
 * The marker is emitted by a distinct SQL statement before pg_sleep begins.
 */
async function whileSessionHolds(
  script: string,
  marker: string,
  probe: (output: () => string) => void,
): Promise<void> {
  const child: ChildProcessWithoutNullStreams = spawn("docker", psqlArgs(), {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    stdout += data;
  });
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  const markerSeen = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for PostgreSQL session marker")),
      12_000,
    );
    const inspect = () => {
      if (!stdout.split("\n").includes(marker)) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", inspect);
    child.on("close", () => {
      clearTimeout(timer);
      if (!stdout.split("\n").includes(marker))
        reject(new Error("PostgreSQL session ended before marker: " + stderr));
    });
  });
  try {
    child.stdin.end(script);
    await markerSeen;
    probe(() => stdout);
    assert.equal(await completed, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    // Consume completion on a failed assertion as well.
    await completed.catch(() => {});
  }
}

test("PostgreSQL Gate 0: isolated transaction feasibility (#128 prerequisite)", async (t) => {
  const options = JSON.parse(docker(["info", "--format", "{{json .SecurityOptions}}"])) as string[];
  assert.ok(
    options.some((flag) => /(^|=)rootless$/.test(flag)),
    "Refusing nonrootless Docker",
  );
  assert.ok(!volumeExists(), "Refusing existing volume");
  assert.equal(
    docker(["ps", "-aq", "--filter", "label=com.docker.compose.project=" + project]),
    "",
    "Refusing existing Compose containers",
  );

  const temporary = mkdtempSync(join(tmpdir(), "nt-pg-kysely-"));
  const override = join(temporary, "ports.yaml");
  // Only this disposable certificate publishes a random loopback port.
  writeFileSync(
    override,
    'services:\n  postgres:\n    ports: ["127.0.0.1::5432"]\n    networks: [pg-proof]\nnetworks:\n  pg-proof: {}\n',
  );
  files.push("-f", override);
  let started = false;
  try {
    compose("config", "--quiet");
    started = true;
    compose("up", "-d", "--wait", "postgres");
    postgresContainer = compose("ps", "-q", "postgres");
    assert.ok(postgresContainer);
    assert.equal(query("SELECT current_user;"), "noveltea_app");

    await t.test("transaction advisory lock excludes another session and releases on rollback", async () => {
      await whileSessionHolds(
        `BEGIN;
SELECT pg_advisory_xact_lock(${lock});
SELECT 'AUDIT_LOCK_HELD';
SELECT pg_sleep(2);
ROLLBACK;
`,
        "AUDIT_LOCK_HELD",
        () => {
          assert.equal(query(`SELECT pg_try_advisory_xact_lock(${lock});`), "f");
        },
      );
      assert.equal(query(`SELECT pg_try_advisory_xact_lock(${lock});`), "t");
      await whileSessionHolds(
        `BEGIN;
SELECT pg_advisory_xact_lock(${lock});
SELECT 'AUDIT_COMMIT_HELD';
SELECT pg_sleep(1);
COMMIT;
`,
        "AUDIT_COMMIT_HELD",
        () => {
          assert.equal(query(`SELECT pg_try_advisory_xact_lock(${lock});`), "f");
        },
      );
      assert.equal(query(`SELECT pg_try_advisory_xact_lock(${lock});`), "t");
    });

    await t.test("transaction-scoped writes are invisible to another connection and roll back", async () => {
      query("CREATE TABLE audit_visibility (id integer PRIMARY KEY);");
      await whileSessionHolds(
        `BEGIN;
INSERT INTO audit_visibility (id) VALUES (1);
SELECT count(*) FROM audit_visibility;
SELECT 'AUDIT_UNCOMMITTED';
SELECT pg_sleep(2);
ROLLBACK;
`,
        "AUDIT_UNCOMMITTED",
        (output) => {
          assert.ok(output().split("\n").includes("1"), "Transaction cannot read its own write");
          assert.equal(query("SELECT count(*) FROM audit_visibility;"), "0");
        },
      );
      assert.equal(query("SELECT count(*) FROM audit_visibility;"), "0");
    });

    await t.test("one-slot FIFO queue cannot overclaim across concurrent sessions", async () => {
      query(`CREATE TABLE audit_queue (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phase text NOT NULL CHECK (phase IN ('queued','running','finished'))
);
INSERT INTO audit_queue (phase) VALUES ('queued'), ('queued');`);
      await whileSessionHolds(
        `BEGIN;
SELECT pg_advisory_xact_lock(${lock});
UPDATE audit_queue SET phase='running'
 WHERE id=(SELECT id FROM audit_queue WHERE phase='queued' ORDER BY id LIMIT 1)
 AND (SELECT count(*) FROM audit_queue WHERE phase='running') < 1
 RETURNING 'AUDIT_FIRST_CLAIM';
SELECT pg_sleep(2);
COMMIT;
`,
        "AUDIT_FIRST_CLAIM",
        () => {
          // This session blocks on the same lock until the first claim commits.
          const result = query(`BEGIN;
SELECT pg_advisory_xact_lock(${lock});
UPDATE audit_queue SET phase='running'
 WHERE id=(SELECT id FROM audit_queue WHERE phase='queued' ORDER BY id LIMIT 1)
 AND (SELECT count(*) FROM audit_queue WHERE phase='running') < 1
 RETURNING id;
COMMIT;
SELECT count(*) FROM audit_queue WHERE phase='running';`);
          assert.equal(result, "1", "Second worker must not fill the occupied slot");
        },
      );
      assert.equal(
        query("SELECT string_agg(id::text || ':' || phase, ',' ORDER BY id) FROM audit_queue;"),
        "1:running,2:queued",
        "First claim must take the oldest eligible job",
      );
    });

    await t.test("shared typed Kysely helpers against competing application connections", () => {
      const address = compose("port", "postgres", "5432");
      assert.match(address, /^127\.0\.0\.1:\d+$/);
      const result = spawnSync(
        "pnpm",
        ["--filter", "@noveltea/studio", "exec", "tsx", "--test", "test/kysely-guards.test.ts"],
        {
          cwd: root,
          env: {
            ...env,
            // The isolated-schema test creates/drops schemas. Its setup must use
            // the disposable bootstrap role, not expand app production grants.
            NT_KYSELY_PROOF_URL: `postgresql://noveltea_bootstrap:${encodeURIComponent(credentials.NT_PG_ADMIN_PASSWORD)}@${address}/noveltea`,
          },
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      assert.equal(result.status, 0, "Shared Kysely proof failed");
    });

    if (process.argv.includes("--conformance")) {
      await t.test("full isolated-schema SQLite/PostgreSQL Kysely conformance", () => {
        const address = compose("port", "postgres", "5432");
        assert.match(address, /^127\.0\.0\.1:\d+$/);
        const suite = [
          "kysely-advanced-threads", "kysely-approvals", "kysely-continuation",
          "kysely-features", "kysely-generation", "kysely-git",
          "kysely-schema-hardening", "kysely-schema", "kysely-steering",
          "kysely-story-navigation", "kysely-thread-messages", "kysely-workflow",
          "shared-studio-store", "studio", "oauth", "thread-chat", "studio-readiness",
          "studio-store-conformance",
        ].map(name => `test/${name}.test.ts`);
        const result = spawnSync("pnpm", [
          "--filter", "@noveltea/studio", "exec", "tsx", "--test",
          "--test-concurrency=2", ...suite,
        ], {
          cwd: root,
          env: {
            ...env,
            NT_TEST_PG_URL: `postgresql://noveltea_bootstrap:${encodeURIComponent(credentials.NT_PG_ADMIN_PASSWORD)}@${address}/noveltea`,
            NT_REQUIRE_KYSELY_PROOF: "1",
          },
          encoding: "utf8",
          timeout: 240_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        process.stdout.write(result.stdout ?? "");
        process.stderr.write(result.stderr ?? "");
        assert.equal(result.status, 0, "Mandatory dual-backend Kysely conformance failed");
      });
    }
  } finally {
    try {
      if (started) {
        compose("down"); // Never -v: the composed base defines developer volumes.
        if (volumeExists()) docker(["volume", "rm", volume]); // Only this invocation's unique volume.
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      files.splice(-2);
    }
  }
});
