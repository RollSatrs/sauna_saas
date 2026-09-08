import type { FastifyInstance } from "fastify";
import type { Client, Ctx } from "../db.ts";
import { audit, idempotencyKey, once, withTenant } from "../db.ts";
import { can } from "../auth.ts";
import { quoteExtraService, quoteVisit } from "../pricing-service.ts";
import { applicableSubscriptions, chargedUnits, coverageMinutes, refreshSubscription }
  from "../subscriptions-service.ts";
import { splitByCoveredMinutes } from "@sauna/core";

/** Итоги заказа всегда пересчитываются из позиций — второго источника правды нет. */
async function recalcOrder(client: Client, orderId: string) {
  const { rows } = await client.query(
    `UPDATE orders o SET
       subtotal = agg.subtotal, discount_total = agg.discount, total = agg.total,
       status = CASE
         WHEN o.status IN ('refunded','partially_refunded','void') THEN o.status
         WHEN agg.total > 0 AND o.paid_total >= agg.total THEN 'paid'
         ELSE 'open' END
     FROM (
       SELECT COALESCE(SUM(total + discount),0)::bigint AS subtotal,
              COALESCE(SUM(discount),0)::bigint AS discount,
              COALESCE(SUM(total),0)::bigint AS total
       FROM order_items WHERE order_id = $1
     ) agg
     WHERE o.id = $1 RETURNING o.*`, [orderId]);
  return rows[0];
}

async function requireOpenShift(client: Client, ctx: Ctx) {
  const { rows } = await client.query(
    `SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open' AND opened_by = $2
     ORDER BY opened_at DESC LIMIT 1`, [ctx.branchId, ctx.userId]);
  return rows[0]?.id ?? null;
}

export function registerVisitRoutes(app: FastifyInstance): void {
  // Открыть визит: с брони или без. Ресурс защищён уникальным индексом —
  // два кассира не смогут посадить гостей в одну парную одновременно.
  app.post("/v1/visits", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "visit.create")) return reply.code(403).send({ error: "нет права открывать визиты" });
    const body = (request.body ?? {}) as {
      resourceId?: string; serviceId?: string; plannedMinutes?: number;
      guestsCount?: number; customerId?: string; bookingId?: string;
    };
    if (!body.resourceId) return reply.code(400).send({ error: "не указан ресурс" });

    return withTenant(ctx.orgId, async (client) => {
      // Ключ идемпотентности приходит от кассы: после обрыва связи она
      // доотправляет накопленное, и повтор не должен открыть второй визит.
      const { result, repeated } = await once(
        client, ctx, idempotencyKey(request), "visits.create", reply, async () => {
      const shiftId = await requireOpenShift(client, ctx);
      if (!shiftId) return reply.code(409).send({ error: "смена не открыта — касса работает только на просмотр" });

      const resourceRes = await client.query(
        "SELECT * FROM resources WHERE id = $1 AND branch_id = $2 AND archived_at IS NULL",
        [body.resourceId, ctx.branchId]);
      const resource = resourceRes.rows[0];
      if (!resource) return reply.code(404).send({ error: "ресурс не найден" });

      const serviceId = body.serviceId ?? resource.default_service_id;
      if (!serviceId) return reply.code(400).send({ error: "для ресурса не задана услуга по умолчанию" });
      const serviceRes = await client.query("SELECT * FROM services WHERE id = $1", [serviceId]);
      const service = serviceRes.rows[0];
      if (!service) return reply.code(404).send({ error: "услуга не найдена" });

      const plannedMinutes = body.plannedMinutes ?? service.default_duration_min ?? 60;

      const orderRes = await client.query(
        `INSERT INTO orders (org_id, branch_id, shift_id, customer_id, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.orgId, ctx.branchId, shiftId, body.customerId ?? null, ctx.userId]);

      let visit;
      try {
        const { rows } = await client.query(
          `INSERT INTO visits (org_id, branch_id, resource_id, booking_id, customer_id, service_id,
                               shift_id, order_id, planned_minutes, guests_count, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [ctx.orgId, ctx.branchId, body.resourceId, body.bookingId ?? null,
           body.customerId ?? null, serviceId, shiftId, orderRes.rows[0].id,
           plannedMinutes, body.guestsCount ?? 1, ctx.userId]);
        visit = rows[0];
      } catch (error) {
        if ((error as { constraint?: string }).constraint === "visits_one_active_per_resource") {
          return reply.code(409).send({ error: "на этом ресурсе уже идёт визит" });
        }
        throw error;
      }

      await client.query("UPDATE orders SET visit_id = $2 WHERE id = $1", [orderRes.rows[0].id, visit.id]);
      if (body.bookingId) {
        await client.query("UPDATE bookings SET status = 'arrived' WHERE id = $1", [body.bookingId]);
      }
      await audit(client, ctx, { entityType: "visit", entityId: visit.id, action: "open",
                                 after: visit, shiftId });
      return { visit, orderId: orderRes.rows[0].id };
      });
      if (repeated && result === undefined) {
        return reply.code(409).send({ error: "операция уже выполняется, повторите через секунду" });
      }
      return repeated ? { ...(result as object), repeated: true } : result;
    });
  });

  app.get("/v1/visits/:id", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const visit = (await client.query(
        `SELECT v.*, r.name AS resource_name, s.name AS service_name,
                c.full_name AS customer_name, c.phone AS customer_phone
         FROM visits v
         JOIN resources r ON r.id = v.resource_id
         JOIN services s ON s.id = v.service_id
         LEFT JOIN customers c ON c.id = v.customer_id
         WHERE v.id = $1`, [id])).rows[0];
      if (!visit) return reply.code(404).send({ error: "визит не найден" });

      const branch = (await client.query(
        "SELECT timezone FROM branches WHERE id = $1", [visit.branch_id])).rows[0];
      const items = await client.query(
        "SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at", [visit.order_id]);
      const extensions = await client.query(
        "SELECT * FROM visit_extensions WHERE visit_id = $1 ORDER BY created_at", [id]);
      const quote = await quoteVisit(client, visit);
      // Подходящий абонемент система предлагает сама — кассир не должен помнить,
      // у кого что куплено.
      const subscriptions = await applicableSubscriptions(client, {
        customerId: visit.customer_id, serviceId: visit.service_id,
        branchId: visit.branch_id, timezone: branch.timezone,
      });
      const order = (await client.query("SELECT * FROM orders WHERE id = $1", [visit.order_id])).rows[0];
      const extraTotal = items.rows.reduce((a, r) => a + Number(r.total), 0);
      return {
        visit, order, items: items.rows, extensions: extensions.rows,
        timeQuote: quote, subscriptions,
        dueTotal: quote.total + extraTotal,
        serverTime: new Date().toISOString(),
      };
    });
  });

  // Продление. Пересечение со следующей бронью не запрещаем, но предупреждаем:
  // решение остаётся за кассиром, который видит зал.
  app.post("/v1/visits/:id/extend", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    const { minutes, reason } = (request.body ?? {}) as { minutes?: number; reason?: string };
    if (!minutes || minutes <= 0) return reply.code(400).send({ error: "укажите время продления" });

    return withTenant(ctx.orgId, async (client) => {
      const { result, repeated } = await once(
        client, ctx, idempotencyKey(request), "visits.extend", reply, async () => {
      const visit = (await client.query(
        "SELECT * FROM visits WHERE id = $1 AND status = 'active' FOR UPDATE", [id])).rows[0];
      if (!visit) return reply.code(404).send({ error: "активный визит не найден" });

      await client.query(
        `INSERT INTO visit_extensions (org_id, visit_id, minutes, reason, created_by)
         VALUES ($1,$2,$3,$4,$5)`, [ctx.orgId, id, Math.round(minutes), reason ?? null, ctx.userId]);

      const quote = await quoteVisit(client, visit);
      const newEnd = quote.segments.at(-1)?.to ?? new Date();
      const conflict = (await client.query(
        `SELECT id, starts_at FROM bookings
         WHERE resource_id = $1 AND status IN ('booked','arrived')
           AND occupied && tstzrange(now(), $2, '[)')
         ORDER BY starts_at LIMIT 1`, [visit.resource_id, newEnd])).rows[0];

      await audit(client, ctx, { entityType: "visit", entityId: id, action: "extend",
                                 after: { minutes }, shiftId: visit.shift_id });
      return {
        visit, timeQuote: quote,
        warning: conflict
          ? `на ${new Date(conflict.starts_at).toISOString()} этот ресурс уже забронирован`
          : null,
      };
      });
      if (repeated && result === undefined) {
        return reply.code(409).send({ error: "операция уже выполняется, повторите через секунду" });
      }
      return repeated ? { ...(result as object), repeated: true } : result;
    });
  });

  // Доп. услуга или товар. Цена снимается снимком в момент продажи.
  app.post("/v1/visits/:id/items", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    const { kind, refId, qty = 1 } =
      (request.body ?? {}) as { kind?: string; refId?: string; qty?: number };
    if (!refId || (kind !== "service_extra" && kind !== "product")) {
      return reply.code(400).send({ error: "укажите товар или доп. услугу" });
    }

    return withTenant(ctx.orgId, async (client) => {
      const { result, repeated } = await once(
        client, ctx, idempotencyKey(request), "visits.items", reply, async () => {
      const visit = (await client.query("SELECT * FROM visits WHERE id = $1", [id])).rows[0];
      if (!visit) return reply.code(404).send({ error: "визит не найден" });
      const order = (await client.query(
        "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [visit.order_id])).rows[0];
      if (order.status !== "open") {
        return reply.code(409).send({ error: "заказ уже закрыт: оформите отдельную продажу" });
      }

      let name: string; let unitPrice: number; let unit: string; let ruleId: string | null = null;
      if (kind === "product") {
        const product = (await client.query(
          "SELECT * FROM products WHERE id = $1 AND archived_at IS NULL", [refId])).rows[0];
        if (!product) return reply.code(404).send({ error: "товар не найден" });
        name = product.name; unitPrice = Number(product.price); unit = product.unit;
      } else {
        const service = (await client.query(
          "SELECT * FROM services WHERE id = $1 AND archived_at IS NULL", [refId])).rows[0];
        if (!service) return reply.code(404).send({ error: "услуга не найдена" });
        const priced = await quoteExtraService(client, refId, visit.branch_id, qty);
        name = service.name; unitPrice = priced.unitPrice; unit = service.unit; ruleId = priced.ruleId;
      }

      const { rows } = await client.query(
        `INSERT INTO order_items (org_id, order_id, kind, ref_id, name_snapshot, qty, unit,
                                  unit_price, price_rule_id, total, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ctx.orgId, order.id, kind, refId, name, qty, unit, unitPrice, ruleId,
         Math.round(unitPrice * qty), ctx.userId]);

      if (kind === "product") {
        await client.query(
          `INSERT INTO stock_movements (org_id, branch_id, product_id, delta, reason, order_id, created_by)
           VALUES ($1,$2,$3,$4,'sale',$5,$6)`,
          [ctx.orgId, visit.branch_id, refId, -qty, order.id, ctx.userId]);
      }
      const updated = await recalcOrder(client, order.id);
      return { item: rows[0], order: updated };
      });
      if (repeated && result === undefined) {
        return reply.code(409).send({ error: "операция уже выполняется, повторите через секунду" });
      }
      return repeated ? { ...(result as object), repeated: true } : result;
    });
  });

  app.delete("/v1/visits/:id/items/:itemId", async (request, reply) => {
    const ctx = request.ctx;
    const { id, itemId } = request.params as { id: string; itemId: string };
    return withTenant(ctx.orgId, async (client) => {
      const visit = (await client.query("SELECT * FROM visits WHERE id = $1", [id])).rows[0];
      if (!visit) return reply.code(404).send({ error: "визит не найден" });
      const item = (await client.query(
        "SELECT * FROM order_items WHERE id = $1 AND order_id = $2", [itemId, visit.order_id])).rows[0];
      if (!item) return reply.code(404).send({ error: "позиция не найдена" });
      if (item.kind === "service_time") {
        return reply.code(409).send({ error: "время визита удалить нельзя — оно считается системой" });
      }
      await client.query("DELETE FROM order_items WHERE id = $1", [itemId]);
      if (item.kind === "product") {
        await client.query(
          `INSERT INTO stock_movements (org_id, branch_id, product_id, delta, reason, order_id, created_by)
           VALUES ($1,$2,$3,$4,'correction',$5,$6)`,
          [ctx.orgId, visit.branch_id, item.ref_id, Number(item.qty), visit.order_id, ctx.userId]);
      }
      await audit(client, ctx, { entityType: "order_item", entityId: itemId, action: "remove",
                                 before: item, shiftId: visit.shift_id });
      return { order: await recalcOrder(client, visit.order_id) };
    });
  });

  // Завершение: фиксируем фактическое время, дописываем позицию за время
  // со снимком тарифных сегментов и освобождаем ресурс.
  app.post("/v1/visits/:id/finish", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const { result, repeated } = await once(
        client, ctx, idempotencyKey(request), "visits.finish", reply, async () => {
      const visit = (await client.query(
        "SELECT * FROM visits WHERE id = $1 AND status = 'active' FOR UPDATE", [id])).rows[0];
      if (!visit) return reply.code(404).send({ error: "активный визит не найден" });

      const { subscriptionId } = (request.body ?? {}) as { subscriptionId?: string };
      const endedAt = new Date();
      const quote = await quoteVisit(client, { ...visit, ended_at: endedAt });
      const service = (await client.query(
        "SELECT name FROM services WHERE id = $1", [visit.service_id])).rows[0];
      const hours = quote.billedMinutes / 60;

      // Списание абонемента и создание позиции идут одной транзакцией:
      // иначе при сбое гость потеряет посещение, не получив услугу.
      let covered = { coveredMinutes: 0, coveredAmount: 0, remainderAmount: quote.total };
      let subscription: { id: string; type: string; balance: number } | null = null;
      if (subscriptionId) {
        const branch = (await client.query(
          "SELECT timezone FROM branches WHERE id = $1", [visit.branch_id])).rows[0];
        const options = await applicableSubscriptions(client, {
          customerId: visit.customer_id, serviceId: visit.service_id,
          branchId: visit.branch_id, timezone: branch.timezone,
        });
        const chosen = options.find((o) => o.id === subscriptionId);
        if (!chosen) {
          return reply.code(409).send({
            error: "этот абонемент сейчас не действует: истёк срок, исчерпан баланс или услуга вне его условий",
          });
        }
        await client.query("SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE", [subscriptionId]);
        subscription = { id: chosen.id, type: chosen.type, balance: chosen.balance };
        const minutes = coverageMinutes(subscription, quote.billedMinutes);
        covered = splitByCoveredMinutes(quote, minutes);
      }

      const itemName = covered.coveredMinutes >= quote.billedMinutes && subscription
        ? `${service.name} · ${(quote.billedMinutes / 60).toFixed(1).replace(".", ",").replace(",0", "")} ч · по абонементу`
        : null;

      const item = (await client.query(
        `INSERT INTO order_items (org_id, order_id, kind, ref_id, name_snapshot, qty, unit,
                                  unit_price, total, meta, created_by, subscription_id, covered_amount)
         VALUES ($1,$2,'service_time',$3,$4,$5,'hour',$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ctx.orgId, visit.order_id, visit.service_id,
         itemName ?? `${service.name} · ${(quote.billedMinutes / 60).toFixed(1).replace(".", ",").replace(",0", "")} ч`,
         hours.toFixed(2), hours > 0 ? Math.round(quote.total / hours) : 0,
         covered.remainderAmount,
         JSON.stringify({
           actualMinutes: quote.actualMinutes,
           billedMinutes: quote.billedMinutes,
           minimumApplied: quote.minimumApplied,
           coveredMinutes: covered.coveredMinutes,
           segments: quote.segments.map((s) => ({
             from: s.from.toISOString(), to: s.to.toISOString(),
             minutes: s.minutes, ruleId: s.ruleId, ratePerHour: s.ratePerHour, amount: s.amount,
           })),
         }), ctx.userId, subscription?.id ?? null, covered.coveredAmount])).rows[0];

      let subscriptionState = null;
      if (subscription) {
        const units = chargedUnits(subscription, covered.coveredMinutes);
        await client.query(
          `INSERT INTO subscription_entries (org_id, subscription_id, type, amount, covered_money,
                                             visit_id, order_item_id, created_by)
           VALUES ($1,$2,'charge',$3,$4,$5,$6,$7)`,
          [ctx.orgId, subscription.id, -units, covered.coveredAmount, id, item.id, ctx.userId]);
        subscriptionState = await refreshSubscription(client, subscription.id);
        await audit(client, ctx, { entityType: "subscription", entityId: subscription.id,
                                   action: "charge",
                                   after: { units, coveredMoney: covered.coveredAmount, visitId: id },
                                   shiftId: visit.shift_id });
      }

      await client.query(
        "UPDATE visits SET status = 'finished', ended_at = $2 WHERE id = $1", [id, endedAt]);
      let order = await recalcOrder(client, visit.order_id);
      // Визит, целиком закрытый абонементом, платить нечем: закрываем заказ сразу,
      // иначе он навсегда останется в неоплаченных.
      if (Number(order.total) === 0) {
        order = (await client.query(
          "UPDATE orders SET status = 'paid' WHERE id = $1 RETURNING *", [visit.order_id])).rows[0];
      }
      await audit(client, ctx, { entityType: "visit", entityId: id, action: "finish",
                                 after: { billedMinutes: quote.billedMinutes, total: quote.total,
                                          coveredAmount: covered.coveredAmount },
                                 shiftId: visit.shift_id });
      return {
        visit: { ...visit, status: "finished", ended_at: endedAt },
        order, timeQuote: quote, covered, subscription: subscriptionState,
      };
      });
      if (repeated && result === undefined) {
        return reply.code(409).send({ error: "операция уже выполняется, повторите через секунду" });
      }
      return repeated ? { ...(result as object), repeated: true } : result;
    });
  });
}
