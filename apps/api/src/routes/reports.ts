import type { FastifyInstance } from "fastify";
import { withTenant } from "../db.ts";
import { can } from "../auth.ts";

/**
 * Отчёты считаются из первичных данных — заказов, позиций и платежей.
 * Отдельной «таблицы выручки» нет намеренно: два источника правды рано или
 * поздно разойдутся, и никто не поймёт, какой из них верный.
 */
type Range = { from: string; to: string; branchId: string | null };

function readRange(request: { query: unknown; ctx: { branchId: string | null } }): Range {
  const q = (request.query ?? {}) as { from?: string; to?: string; branchId?: string };
  const to = q.to ?? new Date().toISOString().slice(0, 10);
  const from = q.from ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  // Кассир и управляющий видят только свой филиал, владелец — любой или все сразу.
  return { from, to, branchId: q.branchId ?? request.ctx.branchId ?? null };
}

const BRANCH_FILTER = "($3::uuid IS NULL OR o.branch_id = $3)";

export function registerReportRoutes(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/reports")) return;
    if (!can(request.ctx, "report.revenue.read") && !can(request.ctx, "report.read")) {
      return reply.code(403).send({ error: "нет доступа к отчётам" });
    }
  });

  // Сводка: выручка, визиты, гости, средний чек и динамика по дням.
  app.get("/v1/reports/summary", async (request) => {
    const ctx = request.ctx;
    const { from, to, branchId } = readRange(request);
    return withTenant(ctx.orgId, async (client) => {
      const args = [from, to, branchId];
      // Запросы идут по очереди: один клиент pg параллелить не умеет.
      // Визиты считаются отдельным запросом. В соединении с платежами заказ
      // с двумя платежами размножил бы строку визита, и гости удвоились бы.
      const totals = await client.query(
          `SELECT COALESCE(SUM(p.amount),0)::bigint AS revenue,
                  count(DISTINCT o.id)::int AS orders
           FROM orders o
           JOIN payments p ON p.order_id = o.id
           WHERE p.created_at::date BETWEEN $1 AND $2 AND ${BRANCH_FILTER}`, args);
      const visitTotals = await client.query(
          `SELECT count(*)::int AS visits, COALESCE(SUM(v.guests_count),0)::int AS guests
           FROM visits v
           WHERE v.started_at::date BETWEEN $1 AND $2
             AND ($3::uuid IS NULL OR v.branch_id = $3)`, args);
      const byDay = await client.query(
          `SELECT p.created_at::date AS day,
                  COALESCE(SUM(p.amount),0)::bigint AS revenue,
                  count(DISTINCT o.id)::int AS orders
           FROM orders o JOIN payments p ON p.order_id = o.id
           WHERE p.created_at::date BETWEEN $1 AND $2 AND ${BRANCH_FILTER}
           GROUP BY 1 ORDER BY 1`, args);
      const previous = await client.query(
          `SELECT COALESCE(SUM(p.amount),0)::bigint AS revenue
           FROM orders o JOIN payments p ON p.order_id = o.id
           WHERE p.created_at::date BETWEEN ($1::date - ($2::date - $1::date + 1))
                                        AND ($1::date - 1) AND ${BRANCH_FILTER}`, args);
      const byMethod = await client.query(
          `SELECT p.method, COALESCE(SUM(p.amount),0)::bigint AS total, count(*)::int AS count
           FROM orders o JOIN payments p ON p.order_id = o.id
           WHERE p.created_at::date BETWEEN $1 AND $2 AND ${BRANCH_FILTER}
           GROUP BY 1 ORDER BY 2 DESC`, args);
      const t = totals.rows[0];
      const refunds = await client.query(
        `SELECT COALESCE(SUM(r.amount),0)::bigint AS total FROM orders o
         JOIN refunds r ON r.order_id = o.id
         WHERE r.created_at::date BETWEEN $1 AND $2 AND ${BRANCH_FILTER}`, args);
      return {
        range: { from, to },
        revenue: Number(t.revenue) - Number(refunds.rows[0].total),
        revenueGross: Number(t.revenue),
        refunds: Number(refunds.rows[0].total),
        previousRevenue: Number(previous.rows[0].revenue),
        orders: t.orders,
        visits: visitTotals.rows[0].visits,
        guests: visitTotals.rows[0].guests,
        averageCheck: t.orders > 0 ? Math.round(Number(t.revenue) / t.orders) : 0,
        byDay: byDay.rows.map((r) => ({ day: r.day, revenue: Number(r.revenue), orders: r.orders })),
        byMethod: byMethod.rows.map((r) => ({ method: r.method, total: Number(r.total), count: r.count })),
      };
    });
  });

  // Что именно приносит деньги: услуги, время, товары, абонементы.
  app.get("/v1/reports/sales", async (request) => {
    const ctx = request.ctx;
    const { from, to, branchId } = readRange(request);
    return withTenant(ctx.orgId, async (client) => {
      const args = [from, to, branchId];
      const byKind = await client.query(
          `SELECT oi.kind, COALESCE(SUM(oi.total),0)::bigint AS total,
                  COALESCE(SUM(oi.covered_amount),0)::bigint AS covered,
                  count(*)::int AS count
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE oi.created_at::date BETWEEN $1 AND $2 AND ${BRANCH_FILTER}
           GROUP BY 1 ORDER BY 2 DESC`, args);
      const byItem = await client.query(
          `SELECT oi.name_snapshot AS name, oi.kind,
                  SUM(oi.qty)::numeric AS qty,
                  COALESCE(SUM(oi.total),0)::bigint AS total
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE oi.created_at::date BETWEEN $1 AND $2 AND ${BRANCH_FILTER}
           GROUP BY 1,2 ORDER BY 4 DESC LIMIT 30`, args);
      return {
        range: { from, to },
        byKind: byKind.rows.map((r) => ({
          kind: r.kind, total: Number(r.total), covered: Number(r.covered), count: r.count })),
        byItem: byItem.rows.map((r) => ({
          name: r.name, kind: r.kind, qty: Number(r.qty), total: Number(r.total) })),
      };
    });
  });

  /**
   * Загрузка ресурсов по дням недели и часам. Главный инструмент управления
   * тарифами: видно, где простой, а где не хватает мощности.
   */
  app.get("/v1/reports/occupancy", async (request) => {
    const ctx = request.ctx;
    const { from, to, branchId } = readRange(request);
    return withTenant(ctx.orgId, async (client) => {
      const args = [from, to, branchId];
      const heat = await client.query(
          `SELECT EXTRACT(ISODOW FROM slot AT TIME ZONE b.timezone)::int AS dow,
                  EXTRACT(HOUR FROM slot AT TIME ZONE b.timezone)::int AS hour,
                  count(*)::int AS busy_hours
           FROM visits v
           JOIN branches b ON b.id = v.branch_id
           JOIN orders o ON o.id = v.order_id,
                LATERAL generate_series(
                  date_trunc('hour', v.started_at),
                  COALESCE(v.ended_at, now()) - interval '1 second',
                  interval '1 hour') AS slot
           WHERE v.started_at::date BETWEEN $1 AND $2 AND ${BRANCH_FILTER}
           GROUP BY 1,2 ORDER BY 1,2`, args);
      const byResource = await client.query(
          `SELECT r.name, count(v.id)::int AS visits,
                  COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(v.ended_at, now()) - v.started_at)) / 3600), 0)::numeric(10,1) AS hours,
                  COALESCE(SUM(o.total),0)::bigint AS revenue
           FROM resources r
           LEFT JOIN visits v ON v.resource_id = r.id AND v.started_at::date BETWEEN $1 AND $2
           LEFT JOIN orders o ON o.id = v.order_id
           WHERE ($3::uuid IS NULL OR r.branch_id = $3) AND r.archived_at IS NULL
           GROUP BY r.id, r.name ORDER BY revenue DESC`, args);
      return {
        range: { from, to },
        heatmap: heat.rows.map((r) => ({ dow: r.dow, hour: r.hour, busyHours: r.busy_hours })),
        byResource: byResource.rows.map((r) => ({
          name: r.name, visits: r.visits, hours: Number(r.hours), revenue: Number(r.revenue) })),
      };
    });
  });

  // Смены и персонал: расхождения по кассе, скидки, возвраты.
  app.get("/v1/reports/shifts", async (request) => {
    const ctx = request.ctx;
    const { from, to, branchId } = readRange(request);
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.opened_at, s.closed_at, s.status,
                s.opening_cash, s.counted_cash, s.expected_cash, s.discrepancy,
                u.full_name AS cashier, b.name AS branch,
                COALESCE(pay.total, 0)::bigint AS revenue,
                COALESCE(pay.count, 0)::int AS payments,
                COALESCE(ref.total, 0)::bigint AS refunds,
                COALESCE(vis.count, 0)::int AS visits
         FROM shifts s
         JOIN users u ON u.id = s.opened_by
         JOIN branches b ON b.id = s.branch_id
         LEFT JOIN LATERAL (SELECT SUM(amount) AS total, count(*) AS count
                            FROM payments p WHERE p.shift_id = s.id) pay ON true
         LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM refunds r WHERE r.shift_id = s.id) ref ON true
         LEFT JOIN LATERAL (SELECT count(*) AS count FROM visits v WHERE v.shift_id = s.id) vis ON true
         WHERE s.opened_at::date BETWEEN $1 AND $2
           AND ($3::uuid IS NULL OR s.branch_id = $3)
         ORDER BY s.opened_at DESC`, [from, to, branchId]);
      return {
        range: { from, to },
        shifts: rows.map((r) => ({
          ...r,
          opening_cash: Number(r.opening_cash), counted_cash: r.counted_cash === null ? null : Number(r.counted_cash),
          expected_cash: r.expected_cash === null ? null : Number(r.expected_cash),
          discrepancy: r.discrepancy === null ? null : Number(r.discrepancy),
          revenue: Number(r.revenue), refunds: Number(r.refunds),
        })),
      };
    });
  });

  /**
   * Абонементы. Отдельно показываем остаток обязательств: деньги за проданный,
   * но не отгулянный абонемент — это долг перед гостем, а не прибыль.
   */
  app.get("/v1/reports/subscriptions", async (request) => {
    const ctx = request.ctx;
    const { from, to } = readRange(request);
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT p.name, p.type, p.price, p.allowance,
                count(s.id)::int AS sold,
                COALESCE(SUM(s.price_paid),0)::bigint AS revenue,
                COALESCE(SUM(GREATEST(subscription_balance(s.id), 0)),0)::numeric AS balance_left,
                COALESCE(SUM(CASE WHEN s.status = 'active' THEN
                  ROUND(p.price * GREATEST(subscription_balance(s.id), 0)
                        / NULLIF(p.allowance, 0)) ELSE 0 END), 0)::bigint AS liability
         FROM subscription_plans p
         LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.purchased_at::date BETWEEN $1 AND $2
         GROUP BY p.id, p.name, p.type, p.price, p.allowance
         ORDER BY revenue DESC`, [from, to]);

      const usage = await client.query(
        `SELECT COALESCE(SUM(-e.amount),0)::numeric AS units_used,
                COALESCE(SUM(e.covered_money),0)::bigint AS money_covered,
                count(*)::int AS charges
         FROM subscription_entries e
         WHERE e.type = 'charge' AND e.created_at::date BETWEEN $1 AND $2`, [from, to]);

      return {
        range: { from, to },
        plans: rows.map((r) => ({
          name: r.name, type: r.type, price: Number(r.price), sold: r.sold,
          revenue: Number(r.revenue), balanceLeft: Number(r.balance_left),
          liability: Number(r.liability),
        })),
        usage: {
          unitsUsed: Number(usage.rows[0].units_used),
          moneyCovered: Number(usage.rows[0].money_covered),
          charges: usage.rows[0].charges,
        },
        totalLiability: rows.reduce((a, r) => a + Number(r.liability), 0),
      };
    });
  });

  app.get("/v1/reports/customers", async (request) => {
    const ctx = request.ctx;
    const { from, to, branchId } = readRange(request);
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.full_name, c.phone,
                count(v.id)::int AS visits,
                COALESCE(SUM(o.total),0)::bigint AS spent,
                MAX(v.started_at) AS last_visit,
                (c.created_at::date BETWEEN $1 AND $2) AS is_new
         FROM customers c
         LEFT JOIN visits v ON v.customer_id = c.id AND v.started_at::date BETWEEN $1 AND $2
         LEFT JOIN orders o ON o.id = v.order_id AND ${BRANCH_FILTER}
         GROUP BY c.id ORDER BY spent DESC LIMIT 50`, [from, to, branchId]);
      return {
        range: { from, to },
        customers: rows.map((r) => ({ ...r, spent: Number(r.spent) })),
        newCount: rows.filter((r) => r.is_new).length,
        returningCount: rows.filter((r) => !r.is_new && r.visits > 0).length,
      };
    });
  });

  // Филиалы организации — для переключателя в кабинете владельца.
  app.get("/v1/branches", async (request) => {
    const ctx = request.ctx;
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        "SELECT id, name, timezone FROM branches WHERE archived_at IS NULL ORDER BY name");
      return { branches: rows };
    });
  });
}
