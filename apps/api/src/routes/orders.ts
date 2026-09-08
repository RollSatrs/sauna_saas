import type { FastifyInstance } from "fastify";
import { audit, withTenant } from "../db.ts";
import { can } from "../auth.ts";

export function registerOrderRoutes(app: FastifyInstance): void {
  /**
   * Оплата. Ключ идемпотентности обязателен: подвисшая сеть плюс второй клик
   * кассира не должны превращаться в два чека.
   */
  app.post("/v1/orders/:id/payments", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "payment.create")) return reply.code(403).send({ error: "нет права принимать оплату" });
    const { id } = request.params as { id: string };
    const { method, amount, idempotencyKey, externalRef } = (request.body ?? {}) as {
      method?: string; amount?: number; idempotencyKey?: string; externalRef?: string;
    };
    if (!method || !amount || amount <= 0) {
      return reply.code(400).send({ error: "укажите способ оплаты и сумму" });
    }
    const key = idempotencyKey ?? request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8) {
      return reply.code(400).send({ error: "нужен ключ идемпотентности длиной от 8 символов" });
    }

    return withTenant(ctx.orgId, async (client) => {
      const order = (await client.query(
        "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!order) return reply.code(404).send({ error: "заказ не найден" });

      const existing = (await client.query(
        "SELECT * FROM payments WHERE org_id = $1 AND idempotency_key = $2", [ctx.orgId, key])).rows[0];
      if (existing) {
        return { payment: existing, order, repeated: true };
      }

      const shift = (await client.query(
        `SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open' AND opened_by = $2
         ORDER BY opened_at DESC LIMIT 1`, [ctx.branchId, ctx.userId])).rows[0];
      if (!shift) return reply.code(409).send({ error: "смена не открыта" });

      const remaining = Number(order.total) - Number(order.paid_total);
      if (Math.round(amount) > remaining) {
        return reply.code(400).send({
          error: `к оплате осталось ${remaining} тиын, принять больше нельзя`, remaining });
      }

      const payment = (await client.query(
        `INSERT INTO payments (org_id, order_id, shift_id, method, amount, external_ref, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [ctx.orgId, id, shift.id, method, Math.round(amount), externalRef ?? null, key, ctx.userId])).rows[0];

      // Выручка относится на смену, в которой прошёл платёж: визит может
      // пережить смену, а деньги — нет.
      const updated = (await client.query(
        `UPDATE orders SET paid_total = paid_total + $2,
           status = CASE WHEN paid_total + $2 >= total THEN 'paid' ELSE status END
         WHERE id = $1 RETURNING *`, [id, Math.round(amount)])).rows[0];

      await audit(client, ctx, { entityType: "payment", entityId: payment.id, action: "create",
                                 after: payment, shiftId: shift.id });
      return { payment, order: updated, repeated: false };
    });
  });

  // Возврат — обратная операция со ссылкой на оригинал, а не правка платежа.
  app.post("/v1/orders/:id/refunds", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    const { paymentId, amount, reason, idempotencyKey } = (request.body ?? {}) as {
      paymentId?: string; amount?: number; reason?: string; idempotencyKey?: string;
    };
    if (!paymentId || !amount || amount <= 0 || !reason) {
      return reply.code(400).send({ error: "укажите платёж, сумму и причину возврата" });
    }
    const key = idempotencyKey ?? request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8) {
      return reply.code(400).send({ error: "нужен ключ идемпотентности" });
    }

    return withTenant(ctx.orgId, async (client) => {
      const payment = (await client.query(
        "SELECT * FROM payments WHERE id = $1 AND order_id = $2", [paymentId, id])).rows[0];
      if (!payment) return reply.code(404).send({ error: "платёж не найден" });

      const already = (await client.query(
        "SELECT COALESCE(SUM(amount),0)::bigint AS total FROM refunds WHERE original_payment_id = $1",
        [paymentId])).rows[0];
      if (Math.round(amount) + Number(already.total) > Number(payment.amount)) {
        return reply.code(400).send({ error: "сумма возвратов превышает платёж" });
      }

      const shift = (await client.query(
        `SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open' AND opened_by = $2
         ORDER BY opened_at DESC LIMIT 1`, [ctx.branchId, ctx.userId])).rows[0];
      if (!shift) return reply.code(409).send({ error: "смена не открыта" });

      const refund = (await client.query(
        `INSERT INTO refunds (org_id, original_payment_id, order_id, shift_id, amount, reason, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [ctx.orgId, paymentId, id, shift.id, Math.round(amount), reason, key, ctx.userId])).rows[0];

      const order = (await client.query(
        `UPDATE orders SET paid_total = paid_total - $2,
           status = CASE WHEN paid_total - $2 <= 0 THEN 'refunded' ELSE 'partially_refunded' END
         WHERE id = $1 RETURNING *`, [id, Math.round(amount)])).rows[0];

      await audit(client, ctx, { entityType: "refund", entityId: refund.id, action: "create",
                                 after: refund, shiftId: shift.id });
      return { refund, order };
    });
  });

  app.get("/v1/orders/:id", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const order = (await client.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
      if (!order) return reply.code(404).send({ error: "заказ не найден" });
      const items = await client.query(
        "SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at", [id]);
      const payments = await client.query(
        "SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at", [id]);
      return { order, items: items.rows, payments: payments.rows };
    });
  });
}
