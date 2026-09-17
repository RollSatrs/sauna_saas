import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { issueToken } from "../auth.ts";
import { audit, withTenant, withoutTenant } from "../db.ts";
import { can } from "../auth.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Счётчик неудачных PIN живёт в базе (см. миграцию 012): перезапуск сервера
 * не должен обнулять защиту, а при нескольких копиях API счётчик обязан быть
 * общим. Возвращает, сколько секунд осталось ждать; ноль — можно пробовать.
 */
async function секундыПаузы(функция: string, deviceId: string): Promise<number> {
  if (!UUID.test(deviceId)) return 0;
  return withoutTenant(async (client) =>
    Number((await client.query(`SELECT ${функция}($1) AS seconds`, [deviceId])).rows[0]?.seconds ?? 0));
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // Шаг 1: телефон и пароль. Пароль проверяется внутри СУБД — его хеш
  // роли приложения недоступен даже на чтение.
  app.post("/v1/auth/login", async (request, reply) => {
    const { phone, password } = (request.body ?? {}) as { phone?: string; password?: string };
    if (!phone || !password) return reply.code(400).send({ error: "укажите телефон и пароль" });

    const rows = await withoutTenant(async (client) => {
      const result = await client.query("SELECT * FROM auth_lookup($1, $2)", [phone, password]);
      return result.rows;
    });
    if (rows.length === 0) return reply.code(401).send({ error: "неверный телефон или пароль" });

    const memberships = rows.map((r) => ({
      membershipId: r.membership_id, orgId: r.org_id, orgName: r.org_name,
      branchId: r.branch_id, branchName: r.branch_name, role: r.role,
    }));
    const user = { id: rows[0].user_id, fullName: rows[0].full_name };

    // Одно место работы — сразу выдаём токен, чтобы кассир не делал лишний выбор.
    if (memberships.length === 1) {
      const m = memberships[0];
      const { token, expiresAt } = issueToken({
        userId: user.id, orgId: m.orgId, branchId: m.branchId,
        role: m.role, membershipId: m.membershipId,
      });
      return { user, memberships, token, expiresAt, context: m };
    }
    return { user, memberships };
  });

  /**
   * Привязка кассы к филиалу. Делается один раз при установке и только
   * владельцем или управляющим: дальше кассир входит четырьмя цифрами,
   * а пароль на кассовом компьютере больше не набирается.
   */
  app.post("/v1/auth/device", async (request, reply) => {
    const { phone, password, branchId, name } = (request.body ?? {}) as
      { phone?: string; password?: string; branchId?: string; name?: string };
    if (!phone || !password || !branchId) {
      return reply.code(400).send({ error: "укажите доступ руководителя и филиал" });
    }
    // Секрет генерирует сервер: клиент не выбирает себе ключ.
    const deviceToken = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
    try {
      const row = await withoutTenant(async (client) =>
        (await client.query("SELECT * FROM auth_bind_device($1,$2,$3,$4,$5)",
          [phone, password, branchId, name ?? "Касса", deviceToken])).rows[0]);
      return {
        device: { id: row.device_id, token: deviceToken, name: name ?? "Касса" },
        context: { orgId: row.org_id, orgName: row.org_name,
                   branchId: row.branch_id, branchName: row.branch_name },
      };
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message });
    }
  });

  // Ежедневный вход: филиал задаёт устройство, PIN — сотрудника.
  app.post("/v1/auth/pin", async (request, reply) => {
    const { deviceId, deviceToken, pin } = (request.body ?? {}) as
      { deviceId?: string; deviceToken?: string; pin?: string };
    if (!deviceId || !deviceToken || !pin) {
      return reply.code(400).send({ error: "касса не привязана — обратитесь к управляющему" });
    }
    if (!/^\d{4,8}$/.test(pin)) {
      return reply.code(400).send({ error: "PIN состоит из 4-8 цифр" });
    }

    const пауза = await секундыПаузы("pin_lock_seconds", deviceId);
    if (пауза > 0) {
      return reply.code(429).send({
        error: `слишком много неверных попыток, подождите ${пауза} с`,
        retryAfterSeconds: пауза,
      });
    }

    let rows;
    try {
      rows = await withoutTenant(async (client) =>
        (await client.query("SELECT * FROM auth_lookup_pin($1,$2,$3)",
          [deviceId, deviceToken, pin])).rows);
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message, unbound: true });
    }
    if (rows.length === 0) {
      // Промах считаем только после того, как устройство опознано: иначе
      // счётчик можно было бы накрутить чужой кассе, зная её идентификатор.
      const блокировка = await секундыПаузы("pin_note_failure", deviceId);
      if (блокировка > 0) {
        return reply.code(429).send({
          error: `слишком много неверных попыток, подождите ${блокировка} с`,
          retryAfterSeconds: блокировка,
        });
      }
      return reply.code(401).send({ error: "неверный PIN" });
    }
    // Верный PIN снимает счётчик промахов и паузу.
    await секундыПаузы("pin_note_success", deviceId);

    const m = rows[0];
    const { token, expiresAt } = issueToken({
      userId: m.user_id, orgId: m.org_id, branchId: m.branch_id,
      role: m.role, membershipId: m.membership_id,
    });
    return {
      token, expiresAt,
      user: { id: m.user_id, fullName: m.full_name },
      context: { orgId: m.org_id, orgName: m.org_name, branchId: m.branch_id,
                 branchName: m.branch_name, role: m.role },
    };
  });

  // Шаг 2: выбор места работы, если их несколько.
  app.post("/v1/auth/session", async (request, reply) => {
    const { phone, password, membershipId } =
      (request.body ?? {}) as { phone?: string; password?: string; membershipId?: string };
    if (!phone || !password || !membershipId) {
      return reply.code(400).send({ error: "укажите телефон, пароль и место работы" });
    }
    const rows = await withoutTenant(async (client) =>
      (await client.query("SELECT * FROM auth_lookup($1, $2)", [phone, password])).rows);
    const m = rows.find((r) => r.membership_id === membershipId);
    if (!m) return reply.code(401).send({ error: "нет доступа к выбранному месту работы" });

    const { token, expiresAt } = issueToken({
      userId: m.user_id, orgId: m.org_id, branchId: m.branch_id,
      role: m.role, membershipId: m.membership_id,
    });
    return {
      token, expiresAt,
      user: { id: m.user_id, fullName: m.full_name },
      context: { orgId: m.org_id, orgName: m.org_name, branchId: m.branch_id,
                 branchName: m.branch_name, role: m.role },
    };
  });

  // Список касс филиала и отзыв доступа: без этого украденный планшет
  // невозможно отключить, и проверка revoked_at была бы мёртвой.
  app.get("/v1/devices", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "device.manage")) return reply.code(403).send({ error: "нет доступа к списку касс" });
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.revoked_at,
                b.name AS branch_name, u.full_name AS created_by_name
         FROM devices d
         JOIN branches b ON b.id = d.branch_id
         JOIN users u ON u.id = d.created_by
         WHERE ($1::uuid IS NULL OR d.branch_id = $1)
         ORDER BY d.revoked_at NULLS FIRST, d.created_at DESC`, [ctx.branchId]);
      return { devices: rows };
    });
  });

  app.post("/v1/devices/:id/revoke", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "device.manage")) {
      return reply.code(403).send({ error: "отозвать кассу может только владелец или управляющий" });
    }
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        "UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *", [id]);
      if (rows.length === 0) return reply.code(404).send({ error: "касса не найдена или уже отозвана" });
      await audit(client, ctx, { entityType: "device", entityId: id, action: "revoke", after: rows[0] });
      return { device: rows[0] };
    });
  });
}
