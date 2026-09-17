#!/usr/bin/env node
// Поднимает API и кассу одной командой. Логи обоих процессов идут в один поток
// с префиксом, чтобы не держать два терминала.
//
// Порты не жёсткие: на машине разработчика часто уже что-то висит на 3000/3001
// (другой проект) — вместо отказа стартовать ищем первый свободный порт от
// привычного номера и дальше. PID и порты своих процессов записываем в
// .dev-pids.json, чтобы `pnpm stop` останавливал именно их, а не всё подряд,
// что слушает эти номера — иначе она могла бы убить чужой процесс, если он
// случайно занял тот же порт.
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PIDFILE = fileURLToPath(new URL("../.dev-pids.json", import.meta.url));

const parts = [
  { name: "api", color: "\x1b[36m", port: 3001, cmd: "node", args: ["--watch", "apps/api/src/server.ts"] },
  { name: "pos", color: "\x1b[35m", port: 5173, cmd: "pnpm", args: ["--filter", "@sauna/pos", "exec", "vite"] },
  { name: "owner", color: "\x1b[33m", port: 5174, cmd: "pnpm", args: ["--filter", "@sauna/owner", "exec", "vite"] },
];

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

/** Первый свободный порт начиная с предпочитаемого — до +20, дальше явно что-то не так. */
async function свободныйПорт(предпочитаемый) {
  for (let порт = предпочитаемый; порт < предпочитаемый + 20; порт++) {
    if (!(await портЗанят(порт))) return порт;
  }
  throw new Error(`не нашлось свободного порта рядом с ${предпочитаемый}`);
}

const назначенные = [];
for (const часть of parts) {
  const порт = await свободныйПорт(часть.port);
  if (порт !== часть.port) {
    console.log(`\x1b[33m${часть.name}: порт ${часть.port} занят (другой проект?), беру ${порт}\x1b[0m`);
  }
  назначенные.push({ ...часть, port: порт });
}

const apiPort = назначенные.find((p) => p.name === "api").port;

const children = назначенные.map(({ name, color, port, cmd, args }) => {
  // API-порт нужен и кассе, и кабинету: их vite.config.ts проксирует /v1
  // на него, а не на захардкоженный 3001 — иначе прокси бил бы мимо, если
  // API поднялся на соседнем порту.
  const env = { ...process.env, API_PORT: String(apiPort) };
  const полныеАргументы = name === "api" ? args : [...args, "--port", String(port), "--strictPort"];
  const child = spawn(cmd, полныеАргументы, { stdio: ["ignore", "pipe", "pipe"], env });
  const print = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) console.log(`${color}${name}\x1b[0m ${line}`);
    }
  };
  child.stdout.on("data", print);
  child.stderr.on("data", print);
  return { name, port, child };
});

writeFileSync(PIDFILE, JSON.stringify(
  children.map(({ name, port, child }) => ({ name, port, pid: child.pid })), null, 2));

console.log("\n" + children.map(({ name, port }) => `  ${name}: http://localhost:${port}`).join("\n") + "\n");

const stop = () => {
  children.forEach(({ child }) => child.kill("SIGTERM"));
  try { execSync(`rm -f ${JSON.stringify(PIDFILE)}`); } catch { /* уже нет файла */ }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
