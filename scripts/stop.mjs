#!/usr/bin/env node
// Останавливает то, что осталось от прошлого `pnpm dev` — по записанным PID,
// а не по номеру порта: на машине разработчика на тех же портах может висеть
// чужой, никак не связанный процесс (другой проект), и бить по порту означало
// бы убить его вслепую.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PIDFILE = fileURLToPath(new URL("../.dev-pids.json", import.meta.url));

if (!existsSync(PIDFILE)) {
  console.log("  нечего останавливать — .dev-pids.json нет (уже остановлено или не запускалось)");
  process.exit(0);
}

const записи = JSON.parse(readFileSync(PIDFILE, "utf8"));
let остановлено = 0;

for (const { name, port, pid } of записи) {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`  ${name} (порт ${port}): остановлен процесс ${pid}`);
    остановлено++;
  } catch {
    console.log(`  ${name}: процесс ${pid} уже не работает`);
  }
}

try { unlinkSync(PIDFILE); } catch { /* уже нет файла */ }

console.log(остановлено === 0
  ? "  всё уже было остановлено"
  : "\n  готово, можно запускать: pnpm dev");
