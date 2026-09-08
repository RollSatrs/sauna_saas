import Fastify from "fastify";
import type { Ctx } from "./db.ts";
import { pool } from "./db.ts";
import { readToken } from "./auth.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerBoardRoutes } from "./routes/board.ts";
import { registerBookingRoutes } from "./routes/bookings.ts";
import { registerCatalogRoutes } from "./routes/catalog.ts";
import { registerManageRoutes } from "./routes/manage.ts";
import { registerOrderRoutes } from "./routes/orders.ts";
import { registerReportRoutes } from "./routes/reports.ts";
import { registerShiftRoutes } from "./routes/shifts.ts";
import { registerSubscriptionRoutes } from "./routes/subscriptions.ts";
import { registerVisitRoutes } from "./routes/visits.ts";

declare module "fastify" {
  interface FastifyRequest {
    ctx: Ctx;
  }
}

const PUBLIC_ROUTES = new Set([
  "/v1/auth/login", "/v1/auth/session", "/v1/auth/device", "/v1/auth/pin", "/health",
]);

export function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" } });

  // Часть операций кассы тела не имеет (например, завершение визита).
  // Пустое тело с заголовком JSON трактуем как пустой объект, а не как ошибку.
  app.addContentTypeParser(
    "application/json", { parseAs: "string" },
    (_request, body: string, done) => {
      if (body === "" || body === undefined) return done(null, {});
      try { done(null, JSON.parse(body)); }
      catch (error) { done(error as Error, undefined); }
    });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "content-type,authorization,idempotency-key");
    reply.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (request.method === "OPTIONS") return reply.code(204).send();

    if (PUBLIC_ROUTES.has(request.url.split("?")[0])) return;

    const header = request.headers.authorization ?? "";
    const ctx = header.startsWith("Bearer ") ? readToken(header.slice(7)) : null;
    if (!ctx) return reply.code(401).send({ error: "нужен вход в систему" });
    // Организация приходит только отсюда — из подписанного токена.
    request.ctx = ctx;
  });

  app.get("/health", async () => {
    const { rows } = await pool.query("SELECT now() AS now");
    return { ok: true, serverTime: rows[0].now };
  });

  registerAuthRoutes(app);
  registerBoardRoutes(app);
  registerCatalogRoutes(app);
  registerShiftRoutes(app);
  registerVisitRoutes(app);
  registerOrderRoutes(app);
  registerBookingRoutes(app);
  registerSubscriptionRoutes(app);
  registerReportRoutes(app);
  registerManageRoutes(app);

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(500).send({ error: error.message });
  });

  return app;
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isEntrypoint) {
  const app = buildServer();
  const port = Number(process.env.API_PORT ?? 3001);
  app.listen({ port, host: "0.0.0.0" })
    .then(() => console.log(`API на http://localhost:${port}`))
    .catch((error) => { console.error(error); process.exit(1); });
}
