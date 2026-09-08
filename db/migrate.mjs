#!/usr/bin/env node
// Прогон миграций и сида. Идут под владельцем базы: он обходит RLS,
// приложение же ходит ролью sauna_app, на которую политики действуют.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.MIGRATION_DATABASE_URL ?? "postgres://localhost:5432/sauna_dev";
const args = new Set(process.argv.slice(2));

const client = new pg.Client({ connectionString: url });
await client.connect();

if (args.has("--reset")) {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await client.query("GRANT ALL ON SCHEMA public TO public;");
  console.log("схема очищена");
}

await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

const applied = new Set(
  (await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
);

for (const file of readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) { console.log(`= ${file}`); continue; }
  const sql = readFileSync(join(here, "migrations", file), "utf8");
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`+ ${file}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`× ${file}\n  ${err.message}`);
    process.exit(1);
  }
}

if (args.has("--seed") || args.has("--reset")) {
  for (const file of ["seed.sql", "demo-history.sql"]) {
    if (file === "demo-history.sql" && args.has("--no-history")) continue;
    await client.query(readFileSync(join(here, file), "utf8"));
    console.log(`+ ${file}`);
  }
}

await client.end();
console.log("готово");
