import type { FastifyInstance } from "fastify";
import { withTenant } from "../db.ts";
import { loadBranchPricing, loadRules, loadTimePricingMode } from "../pricing-service.ts";
import { quoteTime } from "@sauna/core";

export function registerCatalogRoutes(app: FastifyInstance): void {
  // Всё, что нужно кассе для работы, одним запросом — чтобы экран открывался сразу.
  app.get("/v1/catalog", async (request) => {
    const ctx = request.ctx;
    return withTenant(ctx.orgId, async (client) => {
      const services = await client.query(
          `SELECT id, name, kind, unit, default_duration_min, resource_type_id, time_pricing_mode
           FROM services WHERE archived_at IS NULL ORDER BY kind, name`);
      const products = await client.query(
          `SELECT p.id, p.name, p.category, p.unit, p.price,
                  COALESCE(st.qty, 0) AS stock
           FROM products p
           LEFT JOIN LATERAL (
             SELECT SUM(delta) AS qty FROM stock_movements m
             WHERE m.product_id = p.id AND m.branch_id = $1
           ) st ON true
           WHERE p.archived_at IS NULL ORDER BY p.category, p.name`, [ctx.branchId]);
      const resources = await client.query(
          `SELECT r.*, rt.name AS type_name FROM resources r
           LEFT JOIN resource_types rt ON rt.id = r.type_id
           WHERE r.branch_id = $1 AND r.archived_at IS NULL ORDER BY r.sort_order`, [ctx.branchId]);
      const branch = await client.query(
        "SELECT id, name, timezone, settings FROM branches WHERE id = $1", [ctx.branchId]);
      return {
        services: services.rows, products: products.rows,
        resources: resources.rows, branch: branch.rows[0],
      };
    });
  });

  app.get("/v1/customers", async (request) => {
    const ctx = request.ctx;
    const { q } = request.query as { q?: string };
    return withTenant(ctx.orgId, async (client) => {
      // Поиск по последним цифрам телефона: кассир не набирает номер целиком.
      const { rows } = await client.query(
        `SELECT id, phone, full_name FROM customers
         WHERE ($1::text IS NULL OR phone LIKE '%' || $1 || '%' OR full_name ILIKE '%' || $1 || '%')
         ORDER BY full_name LIMIT 20`, [q ?? null]);
      return { customers: rows };
    });
  });

  app.post("/v1/customers", async (request, reply) => {
    const ctx = request.ctx;
    const { phone, fullName } = (request.body ?? {}) as { phone?: string; fullName?: string };
    if (!phone) return reply.code(400).send({ error: "телефон обязателен" });
    return withTenant(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO customers (org_id, phone, full_name) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, phone) DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, customers.full_name)
         RETURNING *`, [ctx.orgId, phone, fullName ?? null]);
      return { customer: rows[0] };
    });
  });

  // Предварительный расчёт: единая точка правды о цене для кассы и брони.
  app.post("/v1/pricing/quote", async (request, reply) => {
    const ctx = request.ctx;
    const { serviceId, from, to } = (request.body ?? {}) as
      { serviceId?: string; from?: string; to?: string };
    if (!serviceId || !from || !to) {
      return reply.code(400).send({ error: "укажите услугу и интервал" });
    }
    return withTenant(ctx.orgId, async (client) => {
      const branch = await loadBranchPricing(client, ctx.branchId!);
      const rules = await loadRules(client, serviceId, ctx.branchId!);
      const mode = await loadTimePricingMode(client, serviceId);
      try {
        const quote = quoteTime({ rules, branch, from: new Date(from), to: new Date(to), mode });
        return { quote };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    });
  });
}
