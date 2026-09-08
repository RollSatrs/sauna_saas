import type { FastifyInstance } from "fastify";
import { withTenant } from "../db.ts";
import { quoteVisit } from "../pricing-service.ts";

export function registerBoardRoutes(app: FastifyInstance): void {
  /**
   * Один запрос отдаёт всё состояние зала: кассиру нельзя ходить по разделам,
   * пока у стойки очередь. Серверное время возвращаем явно — касса считает
   * обратный отсчёт от него, а не от часов своего компьютера.
   */
  app.get("/v1/board", async (request) => {
    const ctx = request.ctx;
    return withTenant(ctx.orgId, async (client) => {
      const now = new Date();
      const shift = await client.query(
          `SELECT s.*, u.full_name AS opened_by_name FROM shifts s
           JOIN users u ON u.id = s.opened_by
           WHERE s.branch_id = $1 AND s.status = 'open' ORDER BY s.opened_at DESC LIMIT 1`,
          [ctx.branchId]);
      const resources = await client.query(
          `SELECT r.*, rt.name AS type_name,
                  v.id AS visit_id, v.started_at, v.planned_minutes, v.guests_count,
                  v.service_id, v.order_id, v.customer_id,
                  c.full_name AS customer_name, c.phone AS customer_phone,
                  sv.name AS service_name,
                  COALESCE(ext.total, 0) AS extension_minutes
           FROM resources r
           LEFT JOIN resource_types rt ON rt.id = r.type_id
           LEFT JOIN visits v ON v.resource_id = r.id AND v.status = 'active'
           LEFT JOIN customers c ON c.id = v.customer_id
           LEFT JOIN services sv ON sv.id = v.service_id
           LEFT JOIN LATERAL (
             SELECT SUM(minutes)::int AS total FROM visit_extensions e WHERE e.visit_id = v.id
           ) ext ON true
           WHERE r.branch_id = $1 AND r.archived_at IS NULL
           ORDER BY r.sort_order, r.name`, [ctx.branchId]);
      const bookings = await client.query(
          `SELECT b.*, c.full_name AS customer_name FROM bookings b
           LEFT JOIN customers c ON c.id = b.customer_id
           WHERE b.branch_id = $1 AND b.status = 'booked'
             AND b.starts_at BETWEEN now() - interval '1 hour' AND now() + interval '24 hours'
           ORDER BY b.starts_at`, [ctx.branchId]);

      const tiles = [];
      for (const r of resources.rows) {
        const base = {
          resourceId: r.id, name: r.name, typeName: r.type_name, capacity: r.capacity,
          bufferMinutes: r.buffer_minutes, defaultServiceId: r.default_service_id,
        };
        const upcoming = bookings.rows.find((b) => b.resource_id === r.id) ?? null;
        if (!r.visit_id) {
          tiles.push({ ...base, state: upcoming ? "booked" : "free", visit: null, upcoming });
          continue;
        }
        const visit = {
          id: r.visit_id, startedAt: r.started_at, plannedMinutes: r.planned_minutes,
          extensionMinutes: Number(r.extension_minutes ?? 0), guestsCount: r.guests_count,
          serviceName: r.service_name, orderId: r.order_id,
          customerName: r.customer_name, customerPhone: r.customer_phone,
        };
        const plannedEnd = new Date(
          new Date(r.started_at).getTime() + (r.planned_minutes + visit.extensionMinutes) * 60000);
        const quote = await quoteVisit(client, {
          id: r.visit_id, branch_id: ctx.branchId!, service_id: r.service_id,
          started_at: new Date(r.started_at), planned_minutes: r.planned_minutes, ended_at: null,
        }, now);
        const extras = await client.query(
          "SELECT COALESCE(SUM(total),0)::bigint AS total FROM order_items WHERE order_id = $1",
          [r.order_id]);
        const minutesLeft = Math.round((plannedEnd.getTime() - now.getTime()) / 60000);
        tiles.push({
          ...base,
          state: minutesLeft < 0 ? "overtime" : minutesLeft <= 10 ? "ending" : "busy",
          visit: {
            ...visit,
            plannedEnd: plannedEnd.toISOString(),
            minutesLeft,
            timeTotal: quote.total,
            extrasTotal: Number(extras.rows[0].total),
            dueTotal: quote.total + Number(extras.rows[0].total),
          },
          upcoming,
        });
      }

      // Рассчитанные, но ещё не оплаченные заказы: визит уже закрыт и с доски
      // исчез, а деньги не приняты — без этого списка они потерялись бы.
      const unpaid = shift.rows[0]
        ? await client.query(
            `SELECT o.id, o.total, o.paid_total, r.name AS resource_name, c.full_name AS customer_name
             FROM orders o
             LEFT JOIN visits v ON v.id = o.visit_id
             LEFT JOIN resources r ON r.id = v.resource_id
             LEFT JOIN customers c ON c.id = o.customer_id
             WHERE o.shift_id = $1 AND o.status = 'open' AND o.total > 0
             ORDER BY o.created_at`, [shift.rows[0].id])
        : { rows: [] };

      return {
        serverTime: now.toISOString(),
        shift: shift.rows[0] ?? null,
        resources: tiles,
        bookings: bookings.rows,
        unpaidOrders: unpaid.rows,
      };
    });
  });
}
