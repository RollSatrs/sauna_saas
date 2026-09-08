// Мост между таблицами тарифов и чистым движком из @sauna/core.
// Вся арифметика живёт в ядре, здесь только загрузка правил.
import { quotePiece, quoteTime } from "@sauna/core";
import type { BranchPricing, PriceRule, TimeQuote } from "@sauna/core";
import type { Client } from "./db.ts";

export async function loadBranchPricing(client: Client, branchId: string): Promise<BranchPricing> {
  const { rows } = await client.query(
    "SELECT timezone, settings FROM branches WHERE id = $1", [branchId]);
  if (rows.length === 0) throw new Error("филиал не найден");
  const s = rows[0].settings ?? {};
  return {
    timezone: rows[0].timezone,
    stepMinutes: Number(s.pricing_step_min ?? 30),
    rounding: s.rounding === "exact" ? "exact" : "up",
    graceMinutes: Number(s.grace_minutes ?? 0),
  };
}

export async function loadRules(
  client: Client, serviceId: string, branchId: string,
): Promise<PriceRule[]> {
  const { rows } = await client.query(
    `SELECT id, priority, dow_mask, time_from, time_to, date_from, date_to, amount, unit, min_units
     FROM price_rules
     WHERE service_id = $1 AND is_active AND (branch_id IS NULL OR branch_id = $2)`,
    [serviceId, branchId]);
  return rows.map((r) => ({
    id: r.id,
    priority: r.priority,
    dowMask: r.dow_mask,
    timeFrom: String(r.time_from).slice(0, 5),
    timeTo: String(r.time_to).slice(0, 5) === "00:00" ? "24:00" : String(r.time_to).slice(0, 5),
    dateFrom: r.date_from ? new Date(r.date_from).toISOString().slice(0, 10) : null,
    dateTo: r.date_to ? new Date(r.date_to).toISOString().slice(0, 10) : null,
    amount: Number(r.amount),
    unit: r.unit,
    minUnits: Number(r.min_units),
  }));
}

/**
 * Плановое окончание визита: старт плюс заказанное время и все продления.
 * Отдельным полем не храним — иначе оно разойдётся с таблицей продлений.
 */
export function plannedEnd(visit: { started_at: Date; planned_minutes: number }, extraMinutes: number): Date {
  return new Date(visit.started_at.getTime() + (visit.planned_minutes + extraMinutes) * 60000);
}

/**
 * Оплачиваемый интервал визита.
 * Клиент оплачивает заказанное время как минимум: ушёл раньше — платит за план,
 * задержался — за фактическое. Это бизнес-правило, а не техническое ограничение.
 */
export async function quoteVisit(client: Client, visit: {
  id: string; branch_id: string; service_id: string;
  started_at: Date; planned_minutes: number; ended_at: Date | null;
}, at: Date = new Date()): Promise<TimeQuote> {
  // Один клиент pg выполняет запросы строго по очереди, поэтому идём
  // последовательно: Promise.all здесь дал бы ложное ощущение параллельности.
  const branch = await loadBranchPricing(client, visit.branch_id);
  const rules = await loadRules(client, visit.service_id, visit.branch_id);
  const ext = await client.query<{ total: number }>(
    "SELECT COALESCE(SUM(minutes),0)::bigint AS total FROM visit_extensions WHERE visit_id = $1",
    [visit.id]);
  const planned = plannedEnd(visit, Number(ext.rows[0].total));
  const actual = visit.ended_at ?? at;
  const to = actual > planned ? actual : planned;
  return quoteTime({ rules, branch, from: visit.started_at, to });
}

export async function quoteExtraService(
  client: Client, serviceId: string, branchId: string, qty: number, at: Date = new Date(),
) {
  const branch = await loadBranchPricing(client, branchId);
  const rules = await loadRules(client, serviceId, branchId);
  return quotePiece({ rules, at, timezone: branch.timezone, qty });
}
