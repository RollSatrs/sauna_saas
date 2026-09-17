import type { FastifyInstance } from "fastify";
import type { Client, Ctx } from "../db.ts";
import { audit, withTenant } from "../db.ts";
import { can } from "../auth.ts";

/**
 * Управление справочниками из кабинета владельца.
 * Два правила держат данные в порядке:
 *   — справочники не удаляются, а архивируются: иначе ломается история продаж;
 *   — каждое изменение попадает в аудит вместе с прежним значением.
 */

const МАСКИ: Record<string, number> = { будни: 31, выходные: 96, все: 127 };

class ОшибкаВвода extends Error {}

const текст = (значение: unknown, поле: string, максимум = 200): string => {
  const v = typeof значение === "string" ? значение.trim() : "";
  if (!v) throw new ОшибкаВвода(`заполните поле «${поле}»`);
  if (v.length > максимум) throw new ОшибкаВвода(`«${поле}» длиннее ${максимум} символов`);
  return v;
};

/** Цена приходит из формы в тенге, в базе живёт в тиынах. */
const тиыны = (значение: unknown, поле: string): number => {
  const число = Number(значение);
  if (!Number.isFinite(число) || число < 0) throw new ОшибкаВвода(`«${поле}» — число не меньше нуля`);
  if (число > 100_000_000) throw new ОшибкаВвода(`«${поле}» выглядит ошибкой: слишком много`);
  return Math.round(число * 100);
};

const целое = (значение: unknown, поле: string, мин: number, макс: number): number => {
  const число = Math.round(Number(значение));
  if (!Number.isFinite(число) || число < мин || число > макс) {
    throw new ОшибкаВвода(`«${поле}» — целое число от ${мин} до ${макс}`);
  }
  return число;
};

const время = (значение: unknown, поле: string): string => {
  const v = String(значение ?? "");
  if (!/^([01]\d|2[0-4]):[0-5]\d$/.test(v)) throw new ОшибкаВвода(`«${поле}» — время в формате 08:00`);
  // 24:00 сохраняем как есть: подмена на 23:59:59 оставляла последнюю минуту
  // суток без тарифа, и визит, заканчивающийся в 23:59, не рассчитывался.
  return v;
};

/** Правила тарифа переписываются целиком: так проще, чем сверять по одному. */
async function записатьТарифы(
  client: Client, ctx: Ctx, serviceId: string, единица: string, правила: unknown,
) {
  if (!Array.isArray(правила) || правила.length === 0) {
    throw new ОшибкаВвода("у услуги должен быть хотя бы один тариф");
  }
  await client.query("UPDATE price_rules SET is_active = false WHERE service_id = $1", [serviceId]);
  for (const [i, п] of правила.entries()) {
    const с = время((п as any).from ?? "00:00", `тариф ${i + 1}: начало`);
    const до = время((п as any).to ?? "24:00", `тариф ${i + 1}: конец`);
    if (до <= с) throw new ОшибкаВвода(`тариф ${i + 1}: конец должен быть позже начала`);
    await client.query(
      `INSERT INTO price_rules (org_id, service_id, priority, dow_mask, time_from, time_to,
                                amount, unit, min_units, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
      [ctx.orgId, serviceId, целое((п as any).priority ?? 0, `тариф ${i + 1}: приоритет`, 0, 100),
       МАСКИ[(п as any).days ?? "все"] ?? 127, с, до,
       тиыны((п as any).price, `тариф ${i + 1}: цена`), единица,
       Number((п as any).minUnits ?? 1)]);
  }
}

export function registerManageRoutes(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/manage")) return;
    const право = request.url.includes("/staff") ? "staff.manage" : "catalog.manage";
    if (!can(request.ctx, право)) {
      return reply.code(403).send({
        error: право === "staff.manage"
          ? "заводить сотрудников может только владелец"
          : "менять справочники и тарифы может только владелец",
      });
    }
  });

  const обработать = async (reply: any, дело: () => Promise<unknown>) => {
    try {
      return await дело();
    } catch (error) {
      if (error instanceof ОшибкаВвода) return reply.code(400).send({ error: error.message });
      const код = (error as { code?: string }).code;
      if (код === "23505") return reply.code(409).send({ error: "такая запись уже есть" });
      throw error;
    }
  };

  // ── Абонементы ───────────────────────────────────────────────────────
  app.get("/v1/manage/subscription-plans", async (request) =>
    withTenant(request.ctx.orgId, async (client) => ({
      plans: (await client.query(
        `SELECT p.*, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id) AS sold
         FROM subscription_plans p ORDER BY p.archived_at NULLS FIRST, p.price`)).rows,
    })));

  const сохранитьАбонемент = async (request: any, reply: any, id?: string) =>
    обработать(reply, () => withTenant(request.ctx.orgId, async (client) => {
      const b = request.body ?? {};
      const тип = String(b.type);
      if (!["visits", "hours", "unlimited_period"].includes(тип)) {
        throw new ОшибкаВвода("выберите тип абонемента");
      }
      const поля = [
        текст(b.name, "название"),
        тип,
        тип === "unlimited_period" ? 0 : целое(b.allowance, "количество", 1, 10000),
        целое(b.validityDays, "срок действия, дней", 1, 3650),
        тиыны(b.price, "цена"),
        Array.isArray(b.serviceIds) ? b.serviceIds : [],
        целое(b.maxHolders ?? 1, "человек в абонементе", 1, 20),
        целое(b.freezeDaysLimit ?? 0, "лимит заморозки, дней", 0, 365),
      ];

      if (id) {
        const было = (await client.query(
          "SELECT * FROM subscription_plans WHERE id = $1", [id])).rows[0];
        if (!было) return reply.code(404).send({ error: "абонемент не найден" });
        const стало = (await client.query(
          `UPDATE subscription_plans SET name=$2, type=$3, allowance=$4, validity_days=$5,
                  price=$6, scope_services=$7, max_holders=$8, freeze_days_limit=$9
           WHERE id=$1 RETURNING *`, [id, ...поля])).rows[0];
        await audit(client, request.ctx, { entityType: "subscription_plan", entityId: id,
                                           action: "update", before: было, after: стало });
        return { plan: стало };
      }
      const стало = (await client.query(
        `INSERT INTO subscription_plans (org_id, name, type, allowance, validity_days, price,
                                         scope_services, max_holders, freeze_days_limit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [request.ctx.orgId, ...поля])).rows[0];
      await audit(client, request.ctx, { entityType: "subscription_plan", entityId: стало.id,
                                         action: "create", after: стало });
      return { plan: стало };
    }));

  app.post("/v1/manage/subscription-plans", (request, reply) =>
    сохранитьАбонемент(request, reply));
  app.patch("/v1/manage/subscription-plans/:id", (request, reply) =>
    сохранитьАбонемент(request, reply, (request.params as { id: string }).id));

  // Проданные абонементы продолжают действовать: архив убирает план из продажи.
  app.post("/v1/manage/subscription-plans/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { restore } = (request.body ?? {}) as { restore?: boolean };
    return withTenant(request.ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `UPDATE subscription_plans SET archived_at = ${restore ? "NULL" : "now()"}
         WHERE id = $1 RETURNING *`, [id]);
      if (rows.length === 0) return reply.code(404).send({ error: "абонемент не найден" });
      await audit(client, request.ctx, { entityType: "subscription_plan", entityId: id,
                                         action: restore ? "restore" : "archive", after: rows[0] });
      return { plan: rows[0] };
    });
  });

  // ── Услуги и тарифы ──────────────────────────────────────────────────
  app.get("/v1/manage/services", async (request) =>
    withTenant(request.ctx.orgId, async (client) => ({
      services: (await client.query(
        `SELECT s.*,
                COALESCE(json_agg(json_build_object(
                  'id', r.id, 'priority', r.priority, 'dowMask', r.dow_mask,
                  'from', to_char(r.time_from,'HH24:MI'), 'to', to_char(r.time_to,'HH24:MI'),
                  'price', r.amount, 'minUnits', r.min_units
                ) ORDER BY r.priority DESC) FILTER (WHERE r.id IS NOT NULL), '[]') AS rules
         FROM services s
         LEFT JOIN price_rules r ON r.service_id = s.id AND r.is_active
         GROUP BY s.id ORDER BY s.archived_at NULLS FIRST, s.kind, s.name`)).rows,
    })));

  const сохранитьУслугу = async (request: any, reply: any, id?: string) =>
    обработать(reply, () => withTenant(request.ctx.orgId, async (client) => {
      const b = request.body ?? {};
      const почасовая = b.kind === "time_based";
      const единица = почасовая ? "hour" : "piece";
      const имя = текст(b.name, "название услуги");
      const длительность = почасовая ? целое(b.defaultDuration ?? 60, "длительность, мин", 15, 1440) : null;
      const режимВремени = почасовая && b.timePricingMode === "at_start" ? "at_start" : "segments";

      let serviceId = id;
      let было = null;
      if (id) {
        было = (await client.query("SELECT * FROM services WHERE id = $1", [id])).rows[0];
        if (!было) return reply.code(404).send({ error: "услуга не найдена" });
        await client.query(
          "UPDATE services SET name=$2, default_duration_min=$3, time_pricing_mode=$4 WHERE id=$1",
          [id, имя, длительность, режимВремени]);
      } else {
        serviceId = (await client.query(
          `INSERT INTO services (org_id, name, kind, unit, default_duration_min, time_pricing_mode)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [request.ctx.orgId, имя, почасовая ? "time_based" : "extra", единица, длительность, режимВремени])).rows[0].id;
      }

      await записатьТарифы(client, request.ctx, serviceId!, единица,
        почасовая ? b.rules : [{ price: b.price, days: "все", from: "00:00", to: "24:00", priority: 0 }]);

      const стало = (await client.query("SELECT * FROM services WHERE id = $1", [serviceId])).rows[0];
      await audit(client, request.ctx, { entityType: "service", entityId: serviceId,
                                         action: id ? "update" : "create", before: было, after: стало });
      return { service: стало };
    }));

  app.post("/v1/manage/services", (request, reply) => сохранитьУслугу(request, reply));
  app.patch("/v1/manage/services/:id", (request, reply) =>
    сохранитьУслугу(request, reply, (request.params as { id: string }).id));

  app.post("/v1/manage/services/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { restore } = (request.body ?? {}) as { restore?: boolean };
    return withTenant(request.ctx.orgId, async (client) => {
      if (!restore) {
        const занята = (await client.query(
          `SELECT count(*)::int AS n FROM resources
           WHERE default_service_id = $1 AND archived_at IS NULL`, [id])).rows[0].n;
        if (занята > 0) {
          return reply.code(409).send({
            error: `услуга назначена ${занята} помещению — сначала поменяйте услугу там` });
        }
      }
      const { rows } = await client.query(
        `UPDATE services SET archived_at = ${restore ? "NULL" : "now()"} WHERE id=$1 RETURNING *`, [id]);
      if (rows.length === 0) return reply.code(404).send({ error: "услуга не найдена" });
      await audit(client, request.ctx, { entityType: "service", entityId: id,
                                         action: restore ? "restore" : "archive", after: rows[0] });
      return { service: rows[0] };
    });
  });

  // ── Помещения ────────────────────────────────────────────────────────
  app.get("/v1/manage/resources", async (request) =>
    withTenant(request.ctx.orgId, async (client) => ({
      resources: (await client.query(
        `SELECT r.*, s.name AS service_name, b.name AS branch_name
         FROM resources r
         LEFT JOIN services s ON s.id = r.default_service_id
         JOIN branches b ON b.id = r.branch_id
         ORDER BY r.archived_at NULLS FIRST, r.sort_order, r.name`)).rows,
    })));

  const сохранитьПомещение = async (request: any, reply: any, id?: string) =>
    обработать(reply, () => withTenant(request.ctx.orgId, async (client) => {
      const b = request.body ?? {};
      const поля = [
        текст(b.name, "название помещения"),
        целое(b.capacity ?? 1, "вместимость", 1, 200),
        b.serviceId ?? null,
        целое(b.bufferMinutes ?? 0, "время уборки, мин", 0, 240),
        целое(b.sortOrder ?? 0, "порядок", 0, 999),
      ];
      if (id) {
        const было = (await client.query("SELECT * FROM resources WHERE id=$1", [id])).rows[0];
        if (!было) return reply.code(404).send({ error: "помещение не найдено" });
        const стало = (await client.query(
          `UPDATE resources SET name=$2, capacity=$3, default_service_id=$4,
                  buffer_minutes=$5, sort_order=$6 WHERE id=$1 RETURNING *`, [id, ...поля])).rows[0];
        await audit(client, request.ctx, { entityType: "resource", entityId: id,
                                           action: "update", before: было, after: стало });
        return { resource: стало };
      }
      const branchId = b.branchId ?? request.ctx.branchId;
      if (!branchId) throw new ОшибкаВвода("выберите филиал");
      const стало = (await client.query(
        `INSERT INTO resources (org_id, branch_id, name, capacity, default_service_id,
                                buffer_minutes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [request.ctx.orgId, branchId, ...поля])).rows[0];
      await audit(client, request.ctx, { entityType: "resource", entityId: стало.id,
                                         action: "create", after: стало });
      return { resource: стало };
    }));

  app.post("/v1/manage/resources", (request, reply) => сохранитьПомещение(request, reply));
  app.patch("/v1/manage/resources/:id", (request, reply) =>
    сохранитьПомещение(request, reply, (request.params as { id: string }).id));

  app.post("/v1/manage/resources/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { restore } = (request.body ?? {}) as { restore?: boolean };
    return withTenant(request.ctx.orgId, async (client) => {
      if (!restore) {
        const занято = (await client.query(
          "SELECT count(*)::int AS n FROM visits WHERE resource_id=$1 AND status='active'", [id])).rows[0].n;
        if (занято > 0) {
          return reply.code(409).send({ error: "в помещении сейчас идёт визит" });
        }
      }
      const { rows } = await client.query(
        `UPDATE resources SET archived_at = ${restore ? "NULL" : "now()"} WHERE id=$1 RETURNING *`, [id]);
      if (rows.length === 0) return reply.code(404).send({ error: "помещение не найдено" });
      await audit(client, request.ctx, { entityType: "resource", entityId: id,
                                         action: restore ? "restore" : "archive", after: rows[0] });
      return { resource: rows[0] };
    });
  });

  // ── Товары ───────────────────────────────────────────────────────────
  app.get("/v1/manage/products", async (request) =>
    withTenant(request.ctx.orgId, async (client) => ({
      products: (await client.query(
        `SELECT p.*, COALESCE((SELECT SUM(delta) FROM stock_movements m
                               WHERE m.product_id = p.id), 0) AS stock
         FROM products p ORDER BY p.archived_at NULLS FIRST, p.category, p.name`)).rows,
    })));

  const сохранитьТовар = async (request: any, reply: any, id?: string) =>
    обработать(reply, () => withTenant(request.ctx.orgId, async (client) => {
      const b = request.body ?? {};
      const поля = [текст(b.name, "название товара"),
                    b.category ? текст(b.category, "категория", 80) : null,
                    тиыны(b.price, "цена")];
      if (id) {
        const было = (await client.query("SELECT * FROM products WHERE id=$1", [id])).rows[0];
        if (!было) return reply.code(404).send({ error: "товар не найден" });
        const стало = (await client.query(
          "UPDATE products SET name=$2, category=$3, price=$4 WHERE id=$1 RETURNING *",
          [id, ...поля])).rows[0];
        await audit(client, request.ctx, { entityType: "product", entityId: id,
                                           action: "update", before: было, after: стало });
        return { product: стало };
      }
      const стало = (await client.query(
        `INSERT INTO products (org_id, name, category, price) VALUES ($1,$2,$3,$4) RETURNING *`,
        [request.ctx.orgId, ...поля])).rows[0];
      await audit(client, request.ctx, { entityType: "product", entityId: стало.id,
                                         action: "create", after: стало });
      return { product: стало };
    }));

  app.post("/v1/manage/products", (request, reply) => сохранитьТовар(request, reply));
  app.patch("/v1/manage/products/:id", (request, reply) =>
    сохранитьТовар(request, reply, (request.params as { id: string }).id));

  // Приход и списание — движением, а не правкой остатка: остаток всегда свёртка.
  app.post("/v1/manage/products/:id/stock", async (request, reply) =>
    обработать(reply, () => withTenant(request.ctx.orgId, async (client) => {
      const { id } = request.params as { id: string };
      const b = (request.body ?? {}) as { delta?: number; reason?: string; branchId?: string };
      const дельта = Number(b.delta);
      if (!Number.isFinite(дельта) || дельта === 0) {
        throw new ОшибкаВвода("укажите количество: положительное — приход, отрицательное — списание");
      }
      const branchId = b.branchId ?? request.ctx.branchId;
      if (!branchId) throw new ОшибкаВвода("выберите филиал");
      const { rows } = await client.query(
        `INSERT INTO stock_movements (org_id, branch_id, product_id, delta, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [request.ctx.orgId, branchId, id, дельта,
         дельта > 0 ? "income" : (b.reason === "writeoff" ? "writeoff" : "correction"),
         request.ctx.userId]);
      await audit(client, request.ctx, { entityType: "product", entityId: id,
                                         action: "stock", after: rows[0] });
      return { movement: rows[0] };
    })));

  app.post("/v1/manage/products/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { restore } = (request.body ?? {}) as { restore?: boolean };
    return withTenant(request.ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `UPDATE products SET archived_at = ${restore ? "NULL" : "now()"} WHERE id=$1 RETURNING *`, [id]);
      if (rows.length === 0) return reply.code(404).send({ error: "товар не найден" });
      await audit(client, request.ctx, { entityType: "product", entityId: id,
                                         action: restore ? "restore" : "archive", after: rows[0] });
      return { product: rows[0] };
    });
  });

  // ── Настройки филиала ────────────────────────────────────────────────
  app.patch("/v1/manage/branches/:id", async (request, reply) =>
    обработать(reply, () => withTenant(request.ctx.orgId, async (client) => {
      const { id } = request.params as { id: string };
      const b = (request.body ?? {}) as any;
      const было = (await client.query("SELECT * FROM branches WHERE id=$1", [id])).rows[0];
      if (!было) return reply.code(404).send({ error: "филиал не найден" });
      const шаг = целое(b.pricingStep ?? было.settings.pricing_step_min, "шаг тарификации", 5, 120);
      const льгота = целое(b.graceMinutes ?? было.settings.grace_minutes, "льготные минуты", 0, 119);
      if (льгота >= шаг) throw new ОшибкаВвода("льготные минуты должны быть меньше шага тарификации");
      const стало = (await client.query(
        `UPDATE branches SET name=$2, address=$3, settings = settings || $4::jsonb
         WHERE id=$1 RETURNING *`,
        [id, текст(b.name ?? было.name, "название филиала"), b.address ?? было.address,
         JSON.stringify({
           pricing_step_min: шаг,
           grace_minutes: льгота,
           rounding: b.rounding === "exact" ? "exact" : "up",
           cashier_discount_limit_percent:
             целое(b.discountLimit ?? было.settings.cashier_discount_limit_percent ?? 10,
                   "лимит скидки кассира, %", 0, 100),
         })])).rows[0];
      await audit(client, request.ctx, { entityType: "branch", entityId: id,
                                         action: "update", before: было, after: стало });
      return { branch: стало };
    })));

  // ── Сотрудники ───────────────────────────────────────────────────────
  app.get("/v1/manage/staff", async (request) =>
    withTenant(request.ctx.orgId, async (client) => ({
      staff: (await client.query(
        `SELECT m.id AS membership_id, m.role, m.status, m.branch_id,
                u.id AS user_id, u.phone, u.full_name,
                b.name AS branch_name, (m.pin_hash IS NOT NULL) AS has_pin
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN branches b ON b.id = m.branch_id
         ORDER BY m.role, u.full_name`)).rows,
    })));

  app.post("/v1/manage/staff", async (request, reply) =>
    обработать(reply, () => withTenant(request.ctx.orgId, async (client) => {
      const b = (request.body ?? {}) as any;
      const телефон = текст(b.phone, "телефон", 20);
      const роль = String(b.role);
      if (!["manager", "cashier", "accountant"].includes(роль)) {
        throw new ОшибкаВвода("выберите роль: управляющий, кассир или бухгалтер");
      }
      const pin = String(b.pin ?? "");
      if (!/^\d{4,8}$/.test(pin)) throw new ОшибкаВвода("PIN — от 4 до 8 цифр");
      // Хеш с солью не сравнить напрямую, поэтому занятость проверяет функция в базе.
      const занят = (await client.query("SELECT pin_taken($1,$2,$3) AS taken",
        [request.ctx.orgId, b.branchId ?? request.ctx.branchId, pin])).rows[0].taken;
      if (занят) throw new ОшибкаВвода("такой PIN уже занят другим сотрудником этого филиала");
      const пароль = текст(b.password ?? pin, "пароль", 100);

      const существует = (await client.query(
        "SELECT id FROM users WHERE phone = $1", [телефон])).rows[0];
      const userId = существует
        ? существует.id
        : (await client.query(
            `INSERT INTO users (phone, full_name, password_hash)
             VALUES ($1,$2,crypt($3, gen_salt('bf'))) RETURNING id`,
            [телефон, текст(b.fullName, "имя"), пароль])).rows[0].id;

      const { rows } = await client.query(
        `INSERT INTO memberships (user_id, org_id, branch_id, role, pin_hash)
         VALUES ($1,$2,$3,$4,crypt($5, gen_salt('bf'))) RETURNING *`,
        [userId, request.ctx.orgId, b.branchId ?? request.ctx.branchId, роль, pin]);
      await audit(client, request.ctx, { entityType: "staff", entityId: rows[0].id,
                                         action: "create", after: { телефон, роль } });
      return { membership: rows[0] };
    })));

  app.patch("/v1/manage/staff/:id", async (request, reply) =>
    обработать(reply, () => withTenant(request.ctx.orgId, async (client) => {
      const { id } = request.params as { id: string };
      const b = (request.body ?? {}) as any;
      const было = (await client.query("SELECT * FROM memberships WHERE id=$1", [id])).rows[0];
      if (!было) return reply.code(404).send({ error: "сотрудник не найден" });
      if (было.role === "owner") {
        return reply.code(409).send({ error: "владельца изменить нельзя" });
      }
      if (b.fullName) {
        await client.query("UPDATE users SET full_name=$2 WHERE id=$1", [было.user_id, текст(b.fullName, "имя")]);
      }
      if (b.pin) {
        if (!/^\d{4,8}$/.test(String(b.pin))) throw new ОшибкаВвода("PIN — от 4 до 8 цифр");
        const занят = (await client.query("SELECT pin_taken($1,$2,$3,$4) AS taken",
          [request.ctx.orgId, было.branch_id, String(b.pin), id])).rows[0].taken;
        if (занят) throw new ОшибкаВвода("такой PIN уже занят другим сотрудником этого филиала");
        await client.query("UPDATE memberships SET pin_hash = crypt($2, gen_salt('bf')) WHERE id=$1",
          [id, String(b.pin)]);
      }
      const { rows } = await client.query(
        `UPDATE memberships SET role = COALESCE($2, role), status = COALESCE($3, status)
         WHERE id=$1 RETURNING *`, [id, b.role ?? null, b.status ?? null]);
      await audit(client, request.ctx, { entityType: "staff", entityId: id,
                                         action: "update", before: было, after: rows[0] });
      return { membership: rows[0] };
    })));
}
