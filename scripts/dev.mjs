#!/usr/bin/env node
// Поднимает API и кассу одной командой. Логи обоих процессов идут в один поток
// с префиксом, чтобы не держать два терминала.
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";

const parts = [
  { name: "api", color: "\x1b[36m", port: 3001, cmd: "node", args: ["--watch", "apps/api/src/server.ts"] },
  { name: "pos", color: "\x1b[35m", port: 5173, cmd: "pnpm", args: ["--filter", "@sauna/pos", "exec", "vite"] },
  { name: "owner", color: "\x1b[33m", port: 5174, cmd: "pnpm", args: ["--filter", "@sauna/owner", "exec", "vite"] },
];

/**
 * Занятый порт — самая частая причина странного запуска: Vite молча уезжает
 * на соседний порт, а касса начинает стучаться не туда. Лучше остановиться
 * и сказать, что делать, чем стартовать наполовину.
 */
// Проверяем подключением, а не попыткой занять порт: Vite слушает IPv6-адрес,
// и попытка занять тот же номер по IPv4 конфликта не покажет.
function отвечает(хост, порт) {
  return new Promise((resolve) => {
    const сокет = connect({ host: хост, port: порт });
    const ответ = (занят) => { сокет.destroy(); resolve(занят); };
    сокет.setTimeout(400);
    сокет.once("connect", () => ответ(true));
    сокет.once("error", () => ответ(false));
    сокет.once("timeout", () => ответ(false));
  });
}

async function портЗанят(порт) {
  const [v4, v6] = await Promise.all([отвечает("127.0.0.1", порт), отвечает("::1", порт)]);
  return v4 || v6;
}

const занятые = [];
for (const { name, port } of parts) {
  if (await портЗанят(port)) занятые.push({ name, port });
}

if (занятые.length > 0) {
  console.error("\n\x1b[31mПорты уже заняты — похоже, программа где-то запущена.\x1b[0m\n");
  for (const { name, port } of занятые) {
    let кто = "";
    try {
      const pid = execSync(`lsof -tnP -iTCP:${port} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString().trim().split("\n")[0];
      if (pid) кто = ` (процесс ${pid})`;
    } catch { /* lsof может быть недоступен */ }
    console.error(`  ${name}: порт ${port}${кто}`);
  }
  console.error("\nЗакройте прежний запуск (Ctrl+C в том окне) или освободите порты:");
  console.error("  \x1b[36mpnpm stop\x1b[0m\n");
  process.exit(1);
}

const children = parts.map(({ name, color, cmd, args }) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const print = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) console.log(`${color}${name}\x1b[0m ${line}`);
    }
  };
  child.stdout.on("data", print);
  child.stderr.on("data", print);
  return child;
});

const stop = () => { children.forEach((c) => c.kill("SIGTERM")); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
