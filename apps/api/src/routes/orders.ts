import type { FastifyInstance } from "fastify";
import { audit, idempotencyKey, once, withTenant } from "../db.ts";
import { can } from "../auth.ts";
import {
  addSellableItem, OrderError, requireOpenShift, type SellableItem,
} from "../order-service.ts";

export function registerOrderRoutes(app: FastifyInstance): void {
  /** Быстрая продажа товара или доп. услуги без визита и таймера. */
  app.post("/v1/orders", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "visit.create")) return reply.code(403).send({ error: "нет права создавать продажи" });
    const { customerId, items } = (request.body ?? {}) as {
      customerId?: string;
      items?: SellableItem[];
    };
    if (!Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: "добавьте хотя бы одну позицию" });
    }

    try {
      return await withTenant(ctx.orgId, async (client) => {
        const { result, repeated } = await once(
          client, ctx, idempotencyKey(request), "orders.create", reply, async () => {
            const shiftId = await requireOpenShift(client, ctx);
            if (!shiftId) throw new OrderError("смена не открыта", 409);
            const order = (await client.query(
              `INSERT INTO orders (org_id, branch_id, shift_id, customer_id, created_by)
               VALUES ($1,$2,$3,$4,$5) RETURNING *`,
              [ctx.orgId, ctx.branchId, shiftId, customerId ?? null, ctx.userId])).rows[0];
            let updated = order;
            for (const item of items) {
              updated = (await addSellableItem(client, ctx, order, item)).order;
            }
            await audit(client, ctx, { entityType: "order", entityId: order.id,
                                       action: "create_direct", after: updated, shiftId });
            return { order: updated };
          });
        if (repeated && result === undefined) {
          return reply.code(409).send({ error: "операция уже выполняется, повторите через секунду" });
        }
        return repeated ? { ...(result as object), repeated: true } : result;
      });
    } catch (error) {
      if (error instanceof OrderError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });

  app.post("/v1/orders/:id/items", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "visit.create")) return reply.code(403).send({ error: "нет права менять продажу" });
    const { id } = request.params as { id: string };
    const input = (request.body ?? {}) as SellableItem;
    try {
      return await withTenant(ctx.orgId, async (client) => {
        const { result, repeated } = await once(
          client, ctx, idempotencyKey(request), "orders.items", reply, async () => {
            const order = (await client.query(
              `SELECT * FROM orders WHERE id = $1 AND branch_id = $2 AND visit_id IS NULL FOR UPDATE`,
              [id, ctx.branchId])).rows[0];
            if (!order) throw new OrderError("быстрая продажа не найдена", 404);
            return addSellableItem(client, ctx, order, input);
          });
        if (repeated && result === undefined) {
          return reply.code(409).send({ error: "операция уже выполняется, повторите через секунду" });
        }
        return repeated ? { ...(result as object), repeated: true } : result;
      });
    } catch (error) {
      if (error instanceof OrderError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });

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
    // Возврат — единственная операция кассы, которая достаёт деньги из ящика
    // обратно, поэтому её оставляем управляющему и владельцу. Кассир проводит
    // возврат через них: так недостача всегда имеет имя.
    if (!can(ctx, "payment.refund")) {
      return reply.code(403).send({ error: "возврат оформляет управляющий или владелец" });
    }
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
      const existingOrder = (await client.query(
        "SELECT branch_id FROM orders WHERE id = $1", [id])).rows[0];
      if (!existingOrder) return reply.code(404).send({ error: "заказ не найден" });

      const payment = (await client.query(
        "SELECT * FROM payments WHERE id = $1 AND order_id = $2", [paymentId, id])).rows[0];
      if (!payment) return reply.code(404).send({ error: "платёж не найден" });

      const already = (await client.query(
        "SELECT COALESCE(SUM(amount),0)::bigint AS total FROM refunds WHERE original_payment_id = $1",
        [paymentId])).rows[0];
      if (Math.round(amount) + Number(already.total) > Number(payment.amount)) {
        return reply.code(400).send({ error: "сумма возвратов превышает платёж" });
      }

      // В отличие от оплаты, возврат оформляет не тот, кто открыл смену —
      // управляющий или владелец возвращают деньги из смены дежурного кассира.
      // Поэтому ищем открытую смену филиала заказа, а не ctx.branchId: у
      // владельца он может быть пустым — он не привязан к одному филиалу.
      const shift = (await client.query(
        `SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open'
         ORDER BY opened_at DESC LIMIT 1`, [existingOrder.branch_id])).rows[0];
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
