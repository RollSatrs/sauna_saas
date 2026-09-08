#!/usr/bin/env node
// Наборы тестов делят одну базу, поэтому идут строго по очереди и каждый
// начинает с чистого состояния. Параллельный прогон ловил бы чужие смены
// и падал бы «через раз» — худший вид красноты.
import { spawnSync } from "node:child_process";

const unit = ["packages/core/test/pricing.test.ts"];
const integration = [
  "apps/api/test/auth.test.ts",
  "apps/api/test/flow.test.ts",
  "apps/api/test/subscriptions.test.ts",
  "apps/api/test/reports.test.ts",
  "apps/api/test/manage.test.ts",
  "apps/api/test/offline.test.ts",
];

const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", env: process.env });
let failed = 0;

console.log("\n── доменное ядро ──────────────────────────────────────");
if (run("node", ["--test", ...unit]).status !== 0) failed++;

for (const file of integration) {
  console.log(`\n── ${file} ────────────────────────────────`);
  if (run("node", ["db/migrate.mjs", "--reset"]).status !== 0) { failed++; continue; }
  if (run("node", ["--test", file]).status !== 0) failed++;
}

console.log(failed === 0
  ? "\nВсе наборы пройдены\n"
  : `\nНе пройдено наборов: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
