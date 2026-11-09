/**
 * Opt-in real PostgreSQL topology/role certificate for #127.
 * Starts ONLY PostgreSQL and disposable network probes, never Studio,
 * models, the controller daemon, developer named volumes or private skills.
 * The full PG application migration is a separate, blocked implementation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(".");
const project = "nt-pg-cert-" + randomUUID().slice(0, 12);
const volume = project + "-postgres";
const fakeApp = project + "-network-fixture";
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
const image = "postgres:17-alpine";

function command(args: string[], accepted = true) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || (accepted && result.status !== 0)) {
    // Never print commands or environment (they contain disposable passwords).
    throw new Error(
      "Docker certification command failed: " +
        (result.stderr || result.error?.message || "status " + result.status),
    );
  }
  return result;
}
function docker(...args: string[]) {
  return command(args).stdout.trim();
}
function compose(...args: string[]) {
  return docker("compose", ...files, ...args);
}
function probe(network: "pg-app" | "pg-controller", user: string, password: string, sql: string) {
  return command(
    [
      "run",
      "--rm",
      "--network",
      project + "_" + network,
      "-e",
      "PGPASSWORD=" + password,
      image,
      "psql",
      "-h",
      "postgres",
      "-U",
      user,
      "-d",
      "noveltea",
      "-XAtqc",
      sql,
    ],
    false,
  );
}
function admin(sql: string) {
  return compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-U",
    "noveltea_bootstrap",
    "-d",
    "noveltea",
    "-Atqc",
    sql,
  );
}
function requireDenied(result: ReturnType<typeof probe>, label: string) {
  assert.notEqual(result.status, 0, label + " unexpectedly succeeded");
}
function assertControllerPermissions() {
  const reader = (sql: string) =>
    probe("pg-controller", "noveltea_controller", credentials.NT_PG_CONTROLLER_PASSWORD, sql);
  const app = (sql: string) => probe("pg-app", "noveltea_app", credentials.NT_PG_APP_PASSWORD, sql);
  assert.equal(app("SELECT 1").stdout.trim(), "1", "App network cannot connect");
  assert.equal(reader("SELECT 1").stdout.trim(), "1", "Controller network cannot connect");
  assert.equal(reader("SELECT count(*) FROM controller_catalog.trusted_jobs").stdout.trim(), "0");
  requireDenied(reader("SELECT * FROM public.pi_credentials"), "Controller access to private credentials");
  requireDenied(
    reader("INSERT INTO public.pi_credentials VALUES ('intrusion')"),
    "Controller writes to app tables",
  );
  requireDenied(
    reader("CREATE TABLE controller_catalog.intrusion (id integer)"),
    "Controller DDL in its catalog schema",
  );
  requireDenied(reader("CREATE TEMP TABLE intrusion (id integer)"), "Controller temporary table creation");
}

function main() {
  const flags = JSON.parse(docker("info", "--format", "{{json .SecurityOptions}}")) as string[];
  assert.ok(
    flags.some((flag) => /(^|=)rootless$/.test(flag)),
    "Refusing nonrootless Docker",
  );
  assert.notEqual(
    command(["volume", "inspect", volume], false).status,
    0,
    "Refusing to use an existing volume",
  );
  assert.equal(
    docker("ps", "-aq", "--filter", "label=com.docker.compose.project=" + project),
    "",
    "Refusing to reuse existing Compose containers",
  );
  compose("config", "--quiet");

  let attempted = false;
  let fixtureCreated = false;
  try {
    attempted = true;
    compose("up", "-d", "--wait", "postgres");
    assert.equal(
      docker("port", compose("ps", "-q", "postgres")),
      "",
      "PostgreSQL port must never be published",
    );
    assert.equal(admin("SELECT 1"), "1");
    // Create a private user-owned relation to demonstrate a real SQL deny,
    // rather than accepting a missing-table error as proof of isolation.
    const appCreate = probe(
      "pg-app",
      "noveltea_app",
      credentials.NT_PG_APP_PASSWORD,
      "CREATE TABLE public.pi_credentials (ciphertext text); INSERT INTO public.pi_credentials VALUES ('private');",
    );
    assert.equal(appCreate.status, 0, "Application role must be able to own its schema");
    assertControllerPermissions();

    command([
      "run",
      "-d",
      "--name",
      fakeApp,
      "--network",
      project + "_pg-app",
      "--network-alias",
      "web",
      "--network-alias",
      "agent",
      image,
      "sleep",
      "600",
    ]);
    fixtureCreated = true;
    const appNetwork = command(
      [
        "run",
        "--rm",
        "--network",
        project + "_pg-app",
        image,
        "sh",
        "-c",
        "getent hosts web && getent hosts agent && getent hosts postgres",
      ],
      false,
    );
    assert.equal(appNetwork.status, 0, "App network fixture is not reachable");
    const controllerNetwork = command(
      [
        "run",
        "--rm",
        "--network",
        project + "_pg-controller",
        image,
        "sh",
        "-c",
        "getent hosts postgres && ! getent hosts web && ! getent hosts agent",
      ],
      false,
    );
    assert.equal(controllerNetwork.status, 0, "Controller must resolve PostgreSQL but never Web/Agent");
    command(["rm", "-f", fakeApp]);
    fixtureCreated = false;

    admin(
      "CREATE TABLE public.pg_cert_marker (id text PRIMARY KEY); INSERT INTO public.pg_cert_marker VALUES ('persisted');",
    );
    compose("restart", "postgres");
    compose("up", "-d", "--wait", "postgres");
    assert.equal(admin("SELECT id FROM public.pg_cert_marker"), "persisted");
    assertControllerPermissions();
    compose("down");
    compose("up", "-d", "--wait", "postgres");
    assert.equal(admin("SELECT id FROM public.pg_cert_marker"), "persisted");
    assertControllerPermissions();
    console.log(
      "PASS PostgreSQL: separate rootless Compose DB networks, least-privilege controller SELECT, denied private reads/writes, durable restart and down/up, no host port",
    );
  } catch (error) {
    // Captures boot/migration failures before the disposable container is gone.
    console.error(compose("logs", "--tail", "70", "postgres"));
    throw error;
  } finally {
    if (fixtureCreated) command(["rm", "-f", fakeApp], false);
    compose("down");
    // NEVER use compose down -v: the base manifest declares developer's
    // named SQLite/state/cache volumes. Remove ONLY the unique test volume.
    if (attempted && command(["volume", "inspect", volume], false).status === 0)
      docker("volume", "rm", volume);
  }
}
main();
