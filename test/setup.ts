import { SQL } from "bun";

/**
 * The suite truncates tables, so it must never touch the database the dashboard
 * reads — a test run once wiped a real sync. This preload redirects
 * DATABASE_URL to a sibling `<name>_test` database, creates it if missing and
 * migrates it, all before src/db.ts is imported anywhere.
 *
 * Set TEST_DATABASE_URL to point somewhere else entirely.
 */

function deriveTestDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}_test`;
  return url.toString();
}

const configured = process.env.DATABASE_URL;
if (!configured) throw new Error("DATABASE_URL not set — see .env.example");

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? deriveTestDatabaseUrl(configured);
if (testDatabaseUrl === configured) {
  throw new Error(
    "the test database URL is the same as DATABASE_URL — refusing to run a suite that truncates tables against it",
  );
}

const testDatabaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname).replace(/^\//, "");
if (!/^[a-z0-9_]+$/i.test(testDatabaseName)) {
  throw new Error(`unusable test database name: ${testDatabaseName}`);
}

// CREATE DATABASE cannot be parameterised, hence the name check above.
const maintenanceUrl = new URL(testDatabaseUrl);
maintenanceUrl.pathname = "/postgres";
const maintenance = new SQL(maintenanceUrl.toString());

try {
  await maintenance.unsafe(`create database "${testDatabaseName}"`);
} catch (cause) {
  // 42P04 is "database already exists", which is the normal case after the first run.
  const code = (cause as { code?: string })?.code;
  if (code !== "42P04" && !/already exists/i.test(String(cause))) throw cause;
} finally {
  await maintenance.close();
}

const migrate = Bun.spawn(["bunx", "prisma", "migrate", "deploy"], {
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  stdout: "pipe",
  stderr: "pipe",
});
const [migrateError, migrateCode] = await Promise.all([
  new Response(migrate.stderr).text(),
  migrate.exited,
]);
if (migrateCode !== 0) {
  throw new Error(`could not migrate the test database:\n${migrateError.trim()}`);
}

process.env.DATABASE_URL = testDatabaseUrl;
