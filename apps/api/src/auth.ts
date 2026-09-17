// Токен подписывается HMAC-SHA256 средствами node:crypto — отдельная
// библиотека для этого не нужна и добавила бы лишнюю зависимость в кассу.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Ctx } from "./db.ts";

const SECRET_ПО_УМОЛЧАНИЮ = "dev-secret-change-me";
const SECRET = process.env.JWT_SECRET ?? SECRET_ПО_УМОЛЧАНИЮ;
const TTL_SECONDS = 12 * 60 * 60; // смена длиннее суток не бывает

// Секрет по умолчанию годится только для разработки: он лежит в открытом
// репозитории, и с ним токен кассира подделывает кто угодно. Забытая на
// сервере переменная — это не предупреждение в логе, а дыра, поэтому
// продакшен с таким секретом просто не стартует.
if (SECRET === SECRET_ПО_УМОЛЧАНИЮ && process.env.NODE_ENV === "production") {
  throw new Error(
    "JWT_SECRET не задан: запуск в продакшене с секретом по умолчанию запрещён. " +
    "Задайте случайную строку от 32 символов в переменной окружения JWT_SECRET.",
  );
}

const b64 = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

function signature(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64url");
}

export function issueToken(ctx: Ctx): { token: string; expiresAt: string } {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = { ...ctx, exp: expires };
  const body = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify(payload))}`;
  return { token: `${body}.${signature(body)}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export function readToken(token: string): Ctx | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(body));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    const { userId, orgId, branchId, role, membershipId } = payload;
    if (!userId || !orgId || !membershipId) return null;
    return { userId, orgId, branchId: branchId ?? null, role, membershipId };
  } catch {
    return null;
  }
}

/**
 * Тарифы и сотрудники — только владельцу: управляющий распоряжается сменой,
 * но не ценой услуги и не составом персонала.
 */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ["*"],
  manager: ["shift.*", "visit.*", "order.*", "payment.*", "booking.*", "catalog.read", "report.*", "subscription.*", "device.manage"],
  cashier: ["shift.open", "shift.close", "visit.*", "order.*", "payment.create", "booking.*",
            "catalog.read", "subscription.sell", "subscription.charge", "subscription.freeze"],
  accountant: ["report.*", "catalog.read"],
};

export function can(ctx: Ctx, permission: string): boolean {
  const granted = ROLE_PERMISSIONS[ctx.role] ?? [];
  return granted.some((rule) =>
    rule === "*" || rule === permission ||
    (rule.endsWith(".*") && permission.startsWith(rule.slice(0, -1))));
}
