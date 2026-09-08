#!/usr/bin/env node
// Останавливает всё, что осталось от прошлого запуска: API и оба приложения.
import { execSync } from "node:child_process";

const порты = [3001, 5173, 5174];
let остановлено = 0;

for (const порт of порты) {
  try {
    const pids = execSync(`lsof -tnP -iTCP:${порт} -sTCP:LISTEN`,
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
        console.log(`  порт ${порт}: остановлен процесс ${pid}`);
        остановлено++;
      } catch { /* уже завершился */ }
    }
  } catch { /* на порту никого нет */ }
}

console.log(остановлено === 0
  ? "  всё уже остановлено"
  : `\n  готово, можно запускать: pnpm dev`);
