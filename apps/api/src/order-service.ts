import type { Client, Ctx } from "./db.ts";
import { quoteExtraService } from "./pricing-service.ts";

export class OrderError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Итоги заказа всегда пересчитываются из позиций — второго источника правды нет. */
export async function recalcOrder(client: Client, orderId: string) {
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

export async function requireOpenShift(client: Client, ctx: Ctx): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open' AND opened_by = $2
     ORDER BY opened_at DESC LIMIT 1`, [ctx.branchId, ctx.userId]);
  return rows[0]?.id ?? null;
}

export type SellableItem = {
  kind?: string;
  refId?: string;
  qty?: number;
};

/** Одинаковый снимок цены и движение склада для визита и быстрой продажи. */
export async function addSellableItem(
  client: Client,
  ctx: Ctx,
  order: { id: string; status: string; branch_id: string },
  input: SellableItem,
) {
  const { kind, refId } = input;
  const qty = Number(input.qty ?? 1);
  if (!refId || (kind !== "service_extra" && kind !== "product")) {
    throw new OrderError("укажите товар или доп. услугу");
  }
  if (!Number.isFinite(qty) || qty <= 0) throw new OrderError("количество должно быть больше нуля");
  if (order.status !== "open") throw new OrderError("заказ уже закрыт", 409);

  let name: string;
  let unitPrice: number;
  let unit: string;
  let ruleId: string | null = null;
  if (kind === "product") {
    const product = (await client.query(
      "SELECT * FROM products WHERE id = $1 AND archived_at IS NULL", [refId])).rows[0];
    if (!product) throw new OrderError("товар не найден", 404);
    name = product.name;
    unitPrice = Number(product.price);
    unit = product.unit;
  } else {
    const service = (await client.query(
      "SELECT * FROM services WHERE id = $1 AND kind = 'extra' AND archived_at IS NULL",
      [refId])).rows[0];
    if (!service) throw new OrderError("доп. услуга не найдена", 404);
    const priced = await quoteExtraService(client, refId, order.branch_id, qty);
    name = service.name;
    unitPrice = priced.unitPrice;
    unit = service.unit;
    ruleId = priced.ruleId;
  }

  const item = (await client.query(
    `INSERT INTO order_items (org_id, order_id, kind, ref_id, name_snapshot, qty, unit,
                              unit_price, price_rule_id, total, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ctx.orgId, order.id, kind, refId, name, qty, unit, unitPrice, ruleId,
     Math.round(unitPrice * qty), ctx.userId])).rows[0];

  if (kind === "product") {
    await client.query(
      `INSERT INTO stock_movements (org_id, branch_id, product_id, delta, reason, order_id, created_by)
       VALUES ($1,$2,$3,$4,'sale',$5,$6)`,
      [ctx.orgId, order.branch_id, refId, -qty, order.id, ctx.userId]);
  }
  return { item, order: await recalcOrder(client, order.id) };
}
