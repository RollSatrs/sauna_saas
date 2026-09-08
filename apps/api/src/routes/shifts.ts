import type { FastifyInstance } from "fastify";
import { audit, withTenant } from "../db.ts";
import { can } from "../auth.ts";

export function registerShiftRoutes(app: FastifyInstance): void {
  app.get("/v1/shifts/current", async (request) => {
    const ctx = request.ctx;
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.*, u.full_name AS opened_by_name
         FROM shifts s JOIN users u ON u.id = s.opened_by
         WHERE s.branch_id = $1 AND s.status = 'open'
         ORDER BY s.opened_at DESC LIMIT 1`, [ctx.branchId]);
      return { shift: rows[0] ?? null, serverTime: new Date().toISOString() };
    });
  });

  // Чеки текущей смены — отсюда кассир оформляет возврат.
  app.get("/v1/shifts/current/receipts", async (request) => {
    const ctx = request.ctx;
    return withTenant(ctx.orgId, async (client) => {
      const shift = (await client.query(
        `SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open' AND opened_by = $2
         ORDER BY opened_at DESC LIMIT 1`, [ctx.branchId, ctx.userId])).rows[0];
      if (!shift) return { receipts: [] };

      const { rows } = await client.query(
        `SELECT o.id, o.total, o.paid_total, o.status, o.created_at,
                r.name AS resource_name, c.full_name AS customer_name,
                COALESCE(json_agg(json_build_object(
                  'id', p.id, 'method', p.method, 'amount', p.amount,
                  'refunded', COALESCE(ref.total, 0)
                ) ORDER BY p.created_at) FILTER (WHERE p.id IS NOT NULL), '[]') AS payments
         FROM orders o
         LEFT JOIN visits v ON v.id = o.visit_id
         LEFT JOIN resources r ON r.id = v.resource_id
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN payments p ON p.order_id = o.id
         LEFT JOIN LATERAL (
           SELECT SUM(amount) AS total FROM refunds rf WHERE rf.original_payment_id = p.id
         ) ref ON true
         WHERE o.shift_id = $1 AND o.paid_total > 0
         GROUP BY o.id, r.name, c.full_name
         ORDER BY o.created_at DESC`, [shift.id]);

      return {
        receipts: rows.map((r) => ({
          ...r,
          total: Number(r.total), paid_total: Number(r.paid_total),
          payments: (r.payments as { amount: number; refunded: number }[]).map((p) => ({
            ...p, amount: Number(p.amount), refunded: Number(p.refunded),
          })),
        })),
      };
    });
  });

  app.post("/v1/shifts", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "shift.open")) return reply.code(403).send({ error: "нет права открывать смену" });
    const { openingCash = 0 } = (request.body ?? {}) as { openingCash?: number };
    if (!ctx.branchId) return reply.code(400).send({ error: "у пользователя не указан филиал" });

    return withTenant(ctx.orgId, async (client) => {
      const open = await client.query(
        "SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open' AND opened_by = $2",
        [ctx.branchId, ctx.userId]);
      if (open.rows.length > 0) {
        return reply.code(409).send({ error: "у вас уже открыта смена", shiftId: open.rows[0].id });
      }
      const { rows } = await client.query(
        `INSERT INTO shifts (org_id, branch_id, opened_by, opening_cash)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [ctx.orgId, ctx.branchId, ctx.userId, Math.round(openingCash)]);
      await audit(client, ctx, { entityType: "shift", entityId: rows[0].id, action: "open",
                                 after: { openingCash }, shiftId: rows[0].id });
      return { shift: rows[0] };
    });
  });

  /**
   * Закрытие смены собирает Z-отчёт и делает его неизменяемым снимком.
   * Пересчитывать итоги при каждом открытии отчёта нельзя: правка справочника
   * задним числом изменила бы документ, который кассир уже подписал.
   */
  app.post("/v1/shifts/:id/close", async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "shift.close")) return reply.code(403).send({ error: "нет права закрывать смену" });
    const { id } = request.params as { id: string };
    const { countedCash } = (request.body ?? {}) as { countedCash?: number };
    if (typeof countedCash !== "number") {
      return reply.code(400).send({ error: "укажите фактический пересчёт наличных" });
    }

    return withTenant(ctx.orgId, async (client) => {
      const shiftRes = await client.query(
        "SELECT * FROM shifts WHERE id = $1 AND status = 'open' FOR UPDATE", [id]);
      const shift = shiftRes.rows[0];
      if (!shift) return reply.code(404).send({ error: "открытая смена не найдена" });

      const active = await client.query(
        "SELECT count(*)::int AS n FROM visits WHERE shift_id = $1 AND status = 'active'", [id]);
      if (active.rows[0].n > 0) {
        return reply.code(409).send({
          error: `в смене ещё ${active.rows[0].n} активных визитов — завершите их или передайте в следующую смену`,
          activeVisits: active.rows[0].n,
        });
      }

      const byMethod = await client.query(
        `SELECT method, COALESCE(SUM(amount),0)::bigint AS total, count(*)::int AS count
         FROM payments WHERE shift_id = $1 GROUP BY method`, [id]);
      const refunds = await client.query(
        `SELECT COALESCE(SUM(r.amount),0)::bigint AS total, count(*)::int AS count
         FROM refunds r WHERE r.shift_id = $1`, [id]);
      const cashRefunds = await client.query(
        `SELECT COALESCE(SUM(r.amount),0)::bigint AS total FROM refunds r
         JOIN payments p ON p.id = r.original_payment_id
         WHERE r.shift_id = $1 AND p.method = 'cash'`, [id]);
      const movements = await client.query(
        `SELECT type, COALESCE(SUM(amount),0)::bigint AS total
         FROM cash_movements WHERE shift_id = $1 GROUP BY type`, [id]);
      const visits = await client.query(
        `SELECT count(*)::int AS visits, COALESCE(SUM(guests_count),0)::int AS guests
         FROM visits WHERE shift_id = $1`, [id]);
      const items = await client.query(
        `SELECT oi.kind, COALESCE(SUM(oi.total),0)::bigint AS total, count(*)::int AS count
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.shift_id = $1 GROUP BY oi.kind`, [id]);
      const discounts = await client.query(
        `SELECT COALESCE(SUM(oi.discount),0)::bigint AS total
         FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.shift_id = $1`, [id]);

      const movementOf = (type: string) =>
        Number(movements.rows.find((r) => r.type === type)?.total ?? 0);
      const cashPaid = Number(byMethod.rows.find((r) => r.method === "cash")?.total ?? 0);

      const expected =
        Number(shift.opening_cash) + cashPaid - Number(cashRefunds.rows[0].total) +
        movementOf("cash_in") - movementOf("cash_out") - movementOf("collection");
      const counted = Math.round(countedCash);

      const zReport = {
        shiftId: id,
        openedAt: shift.opened_at,
        closedAt: new Date().toISOString(),
        openingCash: Number(shift.opening_cash),
        payments: byMethod.rows.map((r) => ({ method: r.method, total: Number(r.total), count: r.count })),
        revenueTotal: byMethod.rows.reduce((a, r) => a + Number(r.total), 0),
        refunds: { total: Number(refunds.rows[0].total), count: refunds.rows[0].count },
        discounts: Number(discounts.rows[0].total),
        cash: {
          in: movementOf("cash_in"), out: movementOf("cash_out"),
          collection: movementOf("collection"),
          expected, counted, discrepancy: counted - expected,
        },
        visits: visits.rows[0].visits,
        guests: visits.rows[0].guests,
        sales: items.rows.map((r) => ({ kind: r.kind, total: Number(r.total), count: r.count })),
      };

      const { rows } = await client.query(
        `UPDATE shifts SET status='closed', closed_by=$2, closed_at=now(),
                counted_cash=$3, expected_cash=$4, discrepancy=$5, z_report=$6
         WHERE id=$1 RETURNING *`,
        [id, ctx.userId, counted, expected, counted - expected, JSON.stringify(zReport)]);
      await audit(client, ctx, { entityType: "shift", entityId: id, action: "close",
                                 after: zReport, shiftId: id });
      return { shift: rows[0], zReport };
    });
  });

  app.post("/v1/shifts/:id/cash", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    const { type, amount, comment } =
      (request.body ?? {}) as { type?: string; amount?: number; comment?: string };
    if (!type || !amount || amount <= 0) {
      return reply.code(400).send({ error: "укажите тип операции и сумму больше нуля" });
    }
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO cash_movements (org_id, shift_id, type, amount, comment, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.orgId, id, type, Math.round(amount), comment ?? null, ctx.userId]);
      await audit(client, ctx, { entityType: "cash_movement", entityId: rows[0].id,
                                 action: type, after: rows[0], shiftId: id });
      return { movement: rows[0] };
    });
  });
}
