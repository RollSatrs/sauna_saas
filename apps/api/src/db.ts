import pg from "pg";

// bigint приходит из драйвера строкой. Деньги у нас целые тиыны и в число
// помещаются с огромным запасом, поэтому разбираем сразу в Number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export type Ctx = {
  userId: string;
  orgId: string;
  branchId: string | null;
  role: string;
  membershipId: string;
};

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://sauna_app:sauna_app@localhost:5432/sauna_dev",
  max: 10,
});

export type Client = pg.PoolClient;

/**
 * Любой запрос к данным идёт внутри транзакции с выставленной организацией.
 * org_id берётся из проверенного токена и только отсюда — из тела запроса
 * его не принимаем никогда, иначе подмена вернёт чужую выручку.
 */
export async function withTenant<T>(orgId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Вне контекста организации: только вход в систему. */
export async function withoutTenant<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function audit(client: Client, ctx: Ctx, entry: {
  entityType: string; entityId?: string | null; action: string;
  before?: unknown; after?: unknown; branchId?: string | null; shiftId?: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (org_id, branch_id, user_id, shift_id, entity_type, entity_id, action, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.orgId, entry.branchId ?? ctx.branchId, ctx.userId, entry.shiftId ?? null,
     entry.entityType, entry.entityId ?? null, entry.action,
     entry.before ? JSON.stringify(entry.before) : null,
     entry.after ? JSON.stringify(entry.after) : null],
  );
}

/**
 * Выполняет операцию один раз на ключ. Повтор — например, когда касса
 * доотправляет накопленное после обрыва связи — вернёт прежний ответ,
 * а не создаст вторую запись.
 *
 * Ключ пишется той же транзакцией, что и сама операция: если операция
 * откатится, ключ не останется и повтор пройдёт честно.
 */
export async function once<T>(
  client: Client, ctx: Ctx, key: string | undefined, endpoint: string,
  reply: unknown, fn: () => Promise<T>,
): Promise<{ result: T; repeated: boolean }> {
  if (!key) return { result: await fn(), repeated: false };

  // Сначала занимаем ключ, потом выполняем. Порядок принципиален: если сперва
  // проверять наличие, два одновременных запроса с одним ключом оба увидят
  // «ещё нет» и оба выполнятся. Вставка блокирует второго на уникальном
  // индексе до конца первой транзакции, и он получает готовый ответ.
  const занято = await client.query(
    `INSERT INTO idempotency_keys (org_id, key, endpoint, response)
     VALUES ($1,$2,$3,'null'::jsonb) ON CONFLICT DO NOTHING RETURNING key`,
    [ctx.orgId, key, endpoint]);

  if (занято.rows.length === 0) {
    const прежний = await client.query(
      "SELECT response FROM idempotency_keys WHERE org_id = $1 AND key = $2", [ctx.orgId, key]);
    return { result: прежний.rows[0]?.response as T, repeated: true };
  }

  const result = await fn();
  // Отказ (обработчик вернул сам reply) не запоминаем: ключ уйдёт вместе с
  // откатом транзакции, и повтор получит тот же отказ заново.
  if (result !== (reply as unknown)) {
    await client.query(
      "UPDATE idempotency_keys SET response = $3 WHERE org_id = $1 AND key = $2",
      [ctx.orgId, key, JSON.stringify(result)]);
  }
  return { result, repeated: false };
}

/** Ключ идемпотентности из заголовка или тела запроса. */
export function idempotencyKey(request: {
  headers: Record<string, unknown>; body?: unknown;
}): string | undefined {
  const заголовок = request.headers["idempotency-key"];
  if (typeof заголовок === "string" && заголовок.length >= 8) return заголовок;
  const тело = (request.body as { idempotencyKey?: string } | undefined)?.idempotencyKey;
  return typeof тело === "string" && тело.length >= 8 ? тело : undefined;
}
