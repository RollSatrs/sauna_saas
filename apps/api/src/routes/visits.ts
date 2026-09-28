import type { FastifyInstance } from "fastify";
import { audit, idempotencyKey, once, withTenant } from "../db.ts";
import { can } from "../auth.ts";
import { quoteEntryService, quoteVisit } from "../pricing-service.ts";
import { addSellableItem, OrderError, recalcOrder, requireOpenShift } from "../order-service.ts";
import { applicableSubscriptions, chargedUnits, coverageMinutes, refreshSubscription }
  from "../subscriptions-service.ts";
import { splitByCoveredMinutes } from "@sauna/core";

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
    return withTenant(ctx.orgId, async (client) => {
      // Ключ идемпотентности приходит от кассы: после обрыва связи она
      // доотправляет накопленное, и повтор не должен открыть второй визит.
      const { result, repeated } = await once(
        client, ctx, idempotencyKey(request), "visits.create", reply, async () => {
      const shiftId = await requireOpenShift(client, ctx);
      if (!shiftId) return reply.code(409).send({ error: "смена не открыта — касса работает только на просмотр" });

      let resource = null;
      if (body.resourceId) {
        resource = (await client.query(
          "SELECT * FROM resources WHERE id = $1 AND branch_id = $2 AND archived_at IS NULL",
          [body.resourceId, ctx.branchId])).rows[0];
        if (!resource) return reply.code(404).send({ error: "ресурс не найден" });
      }

      const serviceId = body.serviceId ?? resource?.default_service_id;
      if (!serviceId) {
        return reply.code(400).send({
          error: resource ? "для ресурса не задана услуга по умолчанию" : "выберите тариф посещения",
        });
      }
      const serviceRes = await client.query(
        "SELECT * FROM services WHERE id = $1 AND archived_at IS NULL", [serviceId]);
      const service = serviceRes.rows[0];
      if (!service) return reply.code(404).send({ error: "услуга не найдена" });

      const публичный = !resource;
      if (публичный) {
        const branch = (await client.query(
          "SELECT settings FROM branches WHERE id = $1", [ctx.branchId])).rows[0];
        const mode = branch?.settings?.catalog_mode ?? "private";
        if (mode !== "public" && mode !== "mixed") {
          return reply.code(409).send({ error: "тарифы посещения отключены в настройках филиала" });
        }
        if (service.kind !== "entry" && service.kind !== "per_person") {
          return reply.code(400).send({ error: "для визита без помещения нужен тариф посещения" });
        }
      }

      const guestsCount = Math.max(1, Math.round(Number(body.guestsCount ?? 1)));
      const plannedMinutes = публичный ? 0 : body.plannedMinutes ?? service.default_duration_min ?? 60;
      const startedAt = new Date();
      let entryPrice: Awaited<ReturnType<typeof quoteEntryService>> | null = null;
      if (публичный) {
        try {
          entryPrice = await quoteEntryService(client, serviceId, ctx.branchId!, guestsCount, startedAt);
        } catch (error) {
          return reply.code(400).send({ error: (error as Error).message });
        }
      }

      const orderRes = await client.query(
        `INSERT INTO orders (org_id, branch_id, shift_id, customer_id, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.orgId, ctx.branchId, shiftId, body.customerId ?? null, ctx.userId]);

      let visit;
      try {
        const { rows } = await client.query(
          `INSERT INTO visits (org_id, branch_id, resource_id, booking_id, customer_id, service_id,
                               shift_id, order_id, planned_minutes, guests_count, created_by, started_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [ctx.orgId, ctx.branchId, resource?.id ?? null, body.bookingId ?? null,
           body.customerId ?? null, serviceId, shiftId, orderRes.rows[0].id,
           plannedMinutes, guestsCount, ctx.userId, startedAt]);
        visit = rows[0];
      } catch (error) {
        if ((error as { constraint?: string }).constraint === "visits_one_active_per_resource") {
          return reply.code(409).send({ error: "на этом ресурсе уже идёт визит" });
        }
        throw error;
      }

      await client.query("UPDATE orders SET visit_id = $2 WHERE id = $1", [orderRes.rows[0].id, visit.id]);
      if (entryPrice) {
        await client.query(
          `INSERT INTO order_items (org_id, order_id, kind, ref_id, name_snapshot, qty, unit,
                                    unit_price, price_rule_id, total, meta, created_by)
           VALUES ($1,$2,'service_entry',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [ctx.orgId, orderRes.rows[0].id, serviceId, service.name, entryPrice.qty, entryPrice.unit,
           entryPrice.unitPrice, entryPrice.ruleId, entryPrice.total,
           JSON.stringify({ fixedAt: new Date(visit.started_at).toISOString(), guestsCount }), ctx.userId]);
        await recalcOrder(client, orderRes.rows[0].id);
      }
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

  /** Активные посещения без помещения для публичного экрана кассы. */
  app.get("/v1/visits/public", async (request) => {
    const ctx = request.ctx;
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT v.id, v.started_at, v.guests_count, v.order_id,
                s.name AS service_name, s.kind AS service_kind,
                c.full_name AS customer_name, o.total, o.paid_total
         FROM visits v
         JOIN services s ON s.id = v.service_id
         JOIN orders o ON o.id = v.order_id
         LEFT JOIN customers c ON c.id = v.customer_id
         WHERE v.branch_id = $1 AND v.resource_id IS NULL AND v.status = 'active'
         ORDER BY v.started_at`, [ctx.branchId]);
      return { visits: rows, serverTime: new Date().toISOString() };
    });
  });

  app.get("/v1/visits/:id", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    return withTenant(ctx.orgId, async (client) => {
      const visit = (await client.query(
        `SELECT v.*, r.name AS resource_name, s.name AS service_name, s.kind AS service_kind,
                c.full_name AS customer_name, c.phone AS customer_phone
         FROM visits v
         LEFT JOIN resources r ON r.id = v.resource_id
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
      const order = (await client.query("SELECT * FROM orders WHERE id = $1", [visit.order_id])).rows[0];
      if (visit.resource_id === null) {
        const elapsedMinutes = Math.max(0, Math.floor(
          (Date.now() - new Date(visit.started_at).getTime()) / 60000));
        return {
          visit, order, items: items.rows, extensions: [], timeQuote: null, subscriptions: [],
          elapsedMinutes, dueTotal: Number(order.total), serverTime: new Date().toISOString(),
        };
      }

      const quote = await quoteVisit(client, visit);
      // Подходящий абонемент система предлагает сама — кассир не должен помнить,
      // у кого что куплено.
      const subscriptions = await applicableSubscriptions(client, {
        customerId: visit.customer_id, serviceId: visit.service_id,
        branchId: visit.branch_id, timezone: branch.timezone,
      });
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
      if (!visit.resource_id) {
        return reply.code(409).send({ error: "готовый тариф посещения не требует продления" });
      }

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
    const input = (request.body ?? {}) as { kind?: string; refId?: string; qty?: number };

    try {
      return await withTenant(ctx.orgId, async (client) => {
        const { result, repeated } = await once(
          client, ctx, idempotencyKey(request), "visits.items", reply, async () => {
            const visit = (await client.query("SELECT * FROM visits WHERE id = $1", [id])).rows[0];
            if (!visit) throw new OrderError("визит не найден", 404);
            const order = (await client.query(
              "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [visit.order_id])).rows[0];
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

  app.delete("/v1/visits/:id/items/:itemId", async (request, reply) => {
    const ctx = request.ctx;
    const { id, itemId } = request.params as { id: string; itemId: string };
    return withTenant(ctx.orgId, async (client) => {
      const visit = (await client.query("SELECT * FROM visits WHERE id = $1", [id])).rows[0];
      if (!visit) return reply.code(404).send({ error: "визит не найден" });
      const item = (await client.query(
        "SELECT * FROM order_items WHERE id = $1 AND order_id = $2", [itemId, visit.order_id])).rows[0];
      if (!item) return reply.code(404).send({ error: "позиция не найдена" });
      if (item.kind === "service_time" || item.kind === "service_entry") {
        return reply.code(409).send({
          error: item.kind === "service_entry"
            ? "тариф входа нельзя убрать из открытого посещения"
            : "время визита удалить нельзя — оно считается системой",
        });
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
      const service = (await client.query(
        "SELECT name, kind FROM services WHERE id = $1", [visit.service_id])).rows[0];

      if (!visit.resource_id) {
        await client.query(
          "UPDATE visits SET status = 'finished', ended_at = $2 WHERE id = $1", [id, endedAt]);
        let order = await recalcOrder(client, visit.order_id);
        if (Number(order.total) === 0) {
          order = (await client.query(
            "UPDATE orders SET status = 'paid' WHERE id = $1 RETURNING *", [visit.order_id])).rows[0];
        }
        const elapsedMinutes = Math.max(0, Math.floor(
          (endedAt.getTime() - new Date(visit.started_at).getTime()) / 60000));
        await audit(client, ctx, { entityType: "visit", entityId: id, action: "finish",
                                   after: { elapsedMinutes, fixedEntryPrice: true },
                                   shiftId: visit.shift_id });
        return {
          visit: { ...visit, status: "finished", ended_at: endedAt },
          order, timeQuote: null, elapsedMinutes,
        };
      }

      const quote = await quoteVisit(client, { ...visit, ended_at: endedAt });
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
