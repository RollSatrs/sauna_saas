// Подбор и списание абонементов. Вся проверка применимости — в одном месте,
// чтобы касса и отчёты одинаково отвечали на вопрос «можно ли этим платить».
import type { Client } from "./db.ts";

export type ApplicableSubscription = {
  id: string;
  planName: string;
  type: "visits" | "hours" | "unlimited_period";
  balance: number;
  validTo: string;
  maxHolders: number;
  /** сколько минут визита абонемент способен закрыть */
  coverableMinutes: number | null;
};

const SELECT_APPLICABLE = `
  SELECT s.id, p.name AS plan_name, p.type, p.allowance,
         subscription_balance(s.id) AS balance,
         subscription_valid_to(s.id) AS valid_to,
         p.max_holders
  FROM subscriptions s
  JOIN subscription_plans p ON p.id = s.plan_id
  LEFT JOIN subscription_holders h ON h.subscription_id = s.id
  WHERE s.status = 'active'
    AND (s.customer_id = $1 OR h.customer_id = $1)
    AND s.valid_from <= CURRENT_DATE
    AND subscription_valid_to(s.id) >= CURRENT_DATE
    AND (cardinality(p.scope_services) = 0 OR $2 = ANY (p.scope_services))
    AND (cardinality(p.scope_branches) = 0 OR $3 = ANY (p.scope_branches))
    AND (p.dow_mask & (1 << (EXTRACT(ISODOW FROM now() AT TIME ZONE $4)::int - 1))) <> 0
    AND (now() AT TIME ZONE $4)::time >= p.time_from
    AND (now() AT TIME ZONE $4)::time <  p.time_to
    AND (p.type = 'unlimited_period' OR subscription_balance(s.id) > 0)
  GROUP BY s.id, p.name, p.type, p.allowance, p.max_holders
  ORDER BY p.type, subscription_valid_to(s.id)`;

export async function applicableSubscriptions(client: Client, input: {
  customerId: string | null; serviceId: string; branchId: string; timezone: string;
}): Promise<ApplicableSubscription[]> {
  if (!input.customerId) return [];
  const { rows } = await client.query(SELECT_APPLICABLE,
    [input.customerId, input.serviceId, input.branchId, input.timezone]);
  return rows.map((r) => ({
    id: r.id,
    planName: r.plan_name,
    type: r.type,
    balance: Number(r.balance),
    validTo: new Date(r.valid_to).toISOString().slice(0, 10),
    maxHolders: r.max_holders,
    coverableMinutes: r.type === "hours" ? Math.round(Number(r.balance) * 60) : null,
  }));
}

/** Сколько минут визита закроет абонемент этого типа. */
export function coverageMinutes(
  subscription: { type: string; balance: number }, billedMinutes: number,
): number {
  if (subscription.type === "hours") {
    return Math.min(billedMinutes, Math.round(subscription.balance * 60));
  }
  return billedMinutes; // visits и unlimited_period закрывают визит целиком
}

/** Сколько единиц спишется с баланса за это покрытие. */
export function chargedUnits(
  subscription: { type: string }, coveredMinutes: number,
): number {
  if (subscription.type === "hours") return Number((coveredMinutes / 60).toFixed(2));
  if (subscription.type === "visits") return 1;
  return 0; // безлимит расходует срок, а не баланс
}

/** Кэш баланса и статус пересчитываются из леджера, а не правятся вручную. */
export async function refreshSubscription(client: Client, subscriptionId: string) {
  const { rows } = await client.query(
    `UPDATE subscriptions s SET
       balance_cache = subscription_balance(s.id),
       status = CASE
         WHEN s.status IN ('cancelled','frozen') THEN s.status
         WHEN subscription_valid_to(s.id) < CURRENT_DATE THEN 'expired'
         WHEN p.type <> 'unlimited_period' AND subscription_balance(s.id) <= 0 THEN 'used_up'
         ELSE 'active' END
     FROM subscription_plans p
     WHERE s.id = $1 AND p.id = s.plan_id
     RETURNING s.*, subscription_valid_to(s.id) AS valid_to`, [subscriptionId]);
  return rows[0];
}
