import type { FastifyInstance } from "fastify";
import { audit, withTenant } from "../db.ts";

export function registerBookingRoutes(app: FastifyInstance): void {
  app.get("/v1/bookings", async (request) => {
    const ctx = request.ctx;
    const { date } = request.query as { date?: string };
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT b.*, c.full_name AS customer_name, c.phone AS customer_phone, r.name AS resource_name
         FROM bookings b
         LEFT JOIN customers c ON c.id = b.customer_id
         JOIN resources r ON r.id = b.resource_id
         WHERE b.branch_id = $1
           AND ($2::date IS NULL OR b.starts_at::date = $2::date)
         ORDER BY b.starts_at`, [ctx.branchId, date ?? null]);
      return { bookings: rows };
    });
  });

  /**
   * Пересечение проверяет не приложение, а ограничение EXCLUDE в PostgreSQL.
   * Проверка «свободно?» в коде не закрывает гонку двух кассиров: оба получат
   * «да» и оба запишут гостей на одну парную.
   */
  app.post("/v1/bookings", async (request, reply) => {
    const ctx = request.ctx;
    const body = (request.body ?? {}) as {
      resourceId?: string; customerId?: string; serviceId?: string;
      startsAt?: string; endsAt?: string; guestsCount?: number; comment?: string;
    };
    if (!body.resourceId || !body.startsAt || !body.endsAt) {
      return reply.code(400).send({ error: "укажите ресурс и интервал" });
    }
    return withTenant(ctx.orgId, async (client) => {
      const resource = (await client.query(
        "SELECT * FROM resources WHERE id = $1 AND branch_id = $2", [body.resourceId, ctx.branchId])).rows[0];
      if (!resource) return reply.code(404).send({ error: "ресурс не найден" });

      try {
        const { rows } = await client.query(
          `INSERT INTO bookings (org_id, branch_id, resource_id, customer_id, service_id,
                                 starts_at, ends_at, buffer_minutes, guests_count, comment, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [ctx.orgId, ctx.branchId, body.resourceId, body.customerId ?? null,
           body.serviceId ?? resource.default_service_id, body.startsAt, body.endsAt,
           resource.buffer_minutes, body.guestsCount ?? 1, body.comment ?? null, ctx.userId]);
        await audit(client, ctx, { entityType: "booking", entityId: rows[0].id,
                                   action: "create", after: rows[0] });
        return { booking: rows[0] };
      } catch (error) {
        if ((error as { constraint?: string }).constraint === "bookings_no_overlap") {
          return reply.code(409).send({
            error: "это время уже занято — с учётом времени на уборку после предыдущей брони",
          });
        }
        throw error;
      }
    });
  });

  app.post("/v1/bookings/:id/cancel", async (request, reply) => {
    const ctx = request.ctx;
    const { id } = request.params as { id: string };
    const { status = "cancelled" } = (request.body ?? {}) as { status?: string };
    if (status !== "cancelled" && status !== "no_show") {
      return reply.code(400).send({ error: "статус может быть cancelled или no_show" });
    }
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        "UPDATE bookings SET status = $2 WHERE id = $1 AND status = 'booked' RETURNING *", [id, status]);
      if (rows.length === 0) return reply.code(404).send({ error: "бронь не найдена" });
      await audit(client, ctx, { entityType: "booking", entityId: id, action: status, after: rows[0] });
      return { booking: rows[0] };
    });
  });
}
