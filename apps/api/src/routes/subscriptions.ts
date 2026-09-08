import type { FastifyInstance } from "fastify";
import { audit, withTenant } from "../db.ts";
import { can } from "../auth.ts";
import { applicableSubscriptions, refreshSubscription } from "../subscriptions-service.ts";

export function registerSubscriptionRoutes(app: FastifyInstance): void {
  app.get("/v1/subscription-plans", async (request) => {
    const ctx = request.ctx;
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM subscription_plans WHERE archived_at IS NULL ORDER BY price`);
      return { plans: rows };
    });
  });

  // Продажа абонемента — обычная позиция заказа: проходит через смену и Z-отчёт.
  app.post("/v1/subscriptions", async (request, reply) => {
    const ctx = request.ctx;
    const { planId, customerId, holderIds = [] } = (request.body ?? {}) as
      { planId?: string; customerId?: string; holderIds?: string[] };
    if (!planId || !customerId) return reply.code(400).send({ error: "укажите абонемент и гостя" });

    return withTenant(ctx.orgId, async (client) => {
      const shift = (await client.query(
        `SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open' AND opened_by = $2
         ORDER BY opened_at DESC LIMIT 1`, [ctx.branchId, ctx.userId])).rows[0];
      if (!shift) return reply.code(409).send({ error: "смена не открыта" });

      const plan = (await client.query(
        "SELECT * FROM subscription_plans WHERE id = $1 AND archived_at IS NULL", [planId])).rows[0];
      if (!plan) return reply.code(404).send({ error: "абонемент не найден" });
      if (holderIds.length + 1 > plan.max_holders) {
        return reply.code(400).send({
          error: `в этот абонемент можно вписать не больше ${plan.max_holders} человек` });
      }

      const order = (await client.query(
        `INSERT INTO orders (org_id, branch_id, shift_id, customer_id, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.orgId, ctx.branchId, shift.id, customerId, ctx.userId])).rows[0];

      const subscription = (await client.query(
        `INSERT INTO subscriptions (org_id, plan_id, customer_id, valid_to_base,
                                    balance_cache, price_paid, order_id, created_by)
         VALUES ($1,$2,$3, CURRENT_DATE + $4::int, $5, $6, $7, $8) RETURNING *`,
        [ctx.orgId, planId, customerId, plan.validity_days,
         Number(plan.allowance), Number(plan.price), order.id, ctx.userId])).rows[0];

      for (const holder of holderIds) {
        await client.query(
          `INSERT INTO subscription_holders (subscription_id, customer_id, org_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [subscription.id, holder, ctx.orgId]);
      }

      await client.query(
        `INSERT INTO order_items (org_id, order_id, kind, ref_id, name_snapshot, qty, unit,
                                  unit_price, total, subscription_id, created_by)
         VALUES ($1,$2,'subscription',$3,$4,1,'piece',$5,$5,$6,$7)`,
        [ctx.orgId, order.id, planId, plan.name, Number(plan.price), subscription.id, ctx.userId]);

      const updated = (await client.query(
        `UPDATE orders SET subtotal = $2, total = $2 WHERE id = $1 RETURNING *`,
        [order.id, Number(plan.price)])).rows[0];

      await audit(client, ctx, { entityType: "subscription", entityId: subscription.id,
                                 action: "sell", after: subscription, shiftId: shift.id });
      return { subscription, order: updated };
    });
  });

  app.get("/v1/customers/:id/subscriptions", async (request) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.*, p.name AS plan_name, p.type, p.allowance, p.freeze_days_limit,
                subscription_balance(s.id) AS balance,
                subscription_valid_to(s.id) AS valid_to
         FROM subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
         LEFT JOIN subscription_holders h ON h.subscription_id = s.id
         WHERE s.customer_id = $1 OR h.customer_id = $1
         GROUP BY s.id, p.name, p.type, p.allowance, p.freeze_days_limit
         ORDER BY s.purchased_at DESC`, [id]);
      return { subscriptions: rows };
    });
  });

  app.get("/v1/subscriptions/:id", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const subscription = (await client.query(
        `SELECT s.*, p.name AS plan_name, p.type, p.allowance, p.freeze_days_limit,
                subscription_balance(s.id) AS balance, subscription_valid_to(s.id) AS valid_to,
                c.full_name AS customer_name, c.phone AS customer_phone
         FROM subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
         JOIN customers c ON c.id = s.customer_id
         WHERE s.id = $1`, [id])).rows[0];
      if (!subscription) return reply.code(404).send({ error: "абонемент не найден" });

      const history = await client.query(
          `SELECT e.*, u.full_name AS author, v.started_at AS visit_started
           FROM subscription_entries e
           JOIN users u ON u.id = e.created_by
           LEFT JOIN visits v ON v.id = e.visit_id
           WHERE e.subscription_id = $1 ORDER BY e.created_at DESC`, [id]);
      const freezes = await client.query(
        "SELECT * FROM subscription_freezes WHERE subscription_id = $1 ORDER BY starts_on", [id]);
      const holders = await client.query(
        `SELECT c.id, c.full_name, c.phone FROM subscription_holders h
         JOIN customers c ON c.id = h.customer_id WHERE h.subscription_id = $1`, [id]);
      return { subscription, history: history.rows, freezes: freezes.rows, holders: holders.rows };
    });
  });

  // Заморозка — интервал, а не правка срока: иначе теряется история и лимит дней.
  app.post("/v1/subscriptions/:id/freeze", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    const { reason } = (request.body ?? {}) as { reason?: string };
    return withTenant(ctx.orgId, async (client) => {
      const s = (await client.query(
        `SELECT s.*, p.freeze_days_limit FROM subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id WHERE s.id = $1 FOR UPDATE`, [id])).rows[0];
      if (!s) return reply.code(404).send({ error: "абонемент не найден" });
      if (s.status === "frozen") return reply.code(409).send({ error: "абонемент уже заморожен" });

      const used = (await client.query(
        `SELECT COALESCE(SUM(COALESCE(ends_on, CURRENT_DATE) - starts_on), 0)::int AS days
         FROM subscription_freezes WHERE subscription_id = $1`, [id])).rows[0].days;
      if (used >= s.freeze_days_limit) {
        return reply.code(400).send({
          error: `лимит заморозки исчерпан: по этому абонементу доступно ${s.freeze_days_limit} дней` });
      }

      await client.query(
        `INSERT INTO subscription_freezes (org_id, subscription_id, starts_on, reason, created_by)
         VALUES ($1,$2,CURRENT_DATE,$3,$4)`, [ctx.orgId, id, reason ?? null, ctx.userId]);
      await client.query("UPDATE subscriptions SET status = 'frozen' WHERE id = $1", [id]);
      await audit(client, ctx, { entityType: "subscription", entityId: id, action: "freeze",
                                 after: { reason, usedDays: used } });
      return { subscription: (await client.query(
        `SELECT s.*, subscription_valid_to(s.id) AS valid_to FROM subscriptions s WHERE s.id = $1`,
        [id])).rows[0] };
    });
  });

  app.post("/v1/subscriptions/:id/unfreeze", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const open = (await client.query(
        `UPDATE subscription_freezes SET ends_on = CURRENT_DATE
         WHERE subscription_id = $1 AND ends_on IS NULL RETURNING *`, [id])).rows[0];
      if (!open) return reply.code(409).send({ error: "абонемент не был заморожен" });
      await client.query("UPDATE subscriptions SET status = 'active' WHERE id = $1", [id]);
      const subscription = await refreshSubscription(client, id);
      await audit(client, ctx, { entityType: "subscription", entityId: id, action: "unfreeze",
                                 after: subscription });
      return { subscription };
    });
  });

  // Корректировка баланса — только руководителю и только обратной записью.
  app.post("/v1/subscriptions/:id/adjust", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "subscription.adjust")) {
      return reply.code(403).send({ error: "корректировать баланс может только управляющий" });
    }
    const { id } = request.params as { id: string };
    const { amount, comment } = (request.body ?? {}) as { amount?: number; comment?: string };
    if (typeof amount !== "number" || amount === 0 || !comment) {
      return reply.code(400).send({ error: "укажите величину корректировки и причину" });
    }
    return withTenant(ctx.orgId, async (client) => {
      await client.query(
        `INSERT INTO subscription_entries (org_id, subscription_id, type, amount, comment, created_by)
         VALUES ($1,$2,'adjust',$3,$4,$5)`, [ctx.orgId, id, amount, comment, ctx.userId]);
      const subscription = await refreshSubscription(client, id);
      await audit(client, ctx, { entityType: "subscription", entityId: id, action: "adjust",
                                 after: { amount, comment } });
      return { subscription };
    });
  });

  app.get("/v1/visits/:id/subscriptions", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const visit = (await client.query(
        `SELECT v.*, b.timezone FROM visits v JOIN branches b ON b.id = v.branch_id
         WHERE v.id = $1`, [id])).rows[0];
      if (!visit) return reply.code(404).send({ error: "визит не найден" });
      return {
        subscriptions: await applicableSubscriptions(client, {
          customerId: visit.customer_id, serviceId: visit.service_id,
          branchId: visit.branch_id, timezone: visit.timezone,
        }),
      };
    });
  });
}
