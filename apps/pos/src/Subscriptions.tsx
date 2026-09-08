import { useEffect, useState } from "react";
import { api, formatTenge, newKey } from "./api.ts";
import { Input } from "@/ui/input";

type Plan = {
  id: string; name: string; type: string; allowance: number;
  validity_days: number; price: number; max_holders: number; freeze_days_limit: number;
};
type Customer = { id: string; phone: string; full_name: string | null };
type Subscription = {
  id: string; plan_name: string; type: string; balance: number; allowance: number;
  valid_to: string; status: string; price_paid: number; freeze_days_limit: number;
};

const TYPE_LABEL: Record<string, string> = {
  visits: "посещений", hours: "часов", unlimited_period: "безлимит",
};
const STATUS_LABEL: Record<string, string> = {
  active: "действует", frozen: "заморожен", expired: "истёк",
  used_up: "исчерпан", cancelled: "отменён",
};

/** Продажа и обслуживание абонементов: баланс, срок, заморозка, история. */
export function SubscriptionsView({ onChanged }: { onChanged: () => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sold, setSold] = useState<{ orderId: string; total: number } | null>(null);

  useEffect(() => {
    api<{ plans: Plan[] }>("/v1/subscription-plans").then((r) => setPlans(r.plans)).catch(() => {});
  }, []);

  useEffect(() => {
    if (query.length < 2) { setFound([]); return; }
    const timer = setTimeout(() => {
      api<{ customers: Customer[] }>(`/v1/customers?q=${encodeURIComponent(query)}`)
        .then((r) => setFound(r.customers)).catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const loadFor = async (c: Customer) => {
    setCustomer(c); setQuery(""); setFound([]);
    const r = await api<{ subscriptions: Subscription[] }>(`/v1/customers/${c.id}/subscriptions`);
    setSubscriptions(r.subscriptions);
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); if (customer) await loadFor(customer); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const sell = (planId: string) => act(async () => {
    const r = await api<{ order: { id: string; total: number } }>("/v1/subscriptions",
      { method: "POST", body: { planId, customerId: customer!.id } });
    setSold({ orderId: r.order.id, total: Number(r.order.total) });
  });

  const payForSubscription = (method: "cash" | "card") => act(async () => {
    await api(`/v1/orders/${sold!.orderId}/payments`, {
      method: "POST", idempotencyKey: newKey("sub"),
      body: { method, amount: sold!.total },
    });
    setSold(null);
  });

  return (
    <div className="board">
      <h2 style={{ marginTop: 0 }}>Абонементы</h2>

      <div style={{ maxWidth: 620, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="section">
          <span className="label">Гость</span>
          {customer ? (
            <div className="item">
              <span>{customer.full_name ?? "Без имени"} · {customer.phone}</span>
              <span />
              <button onClick={() => { setCustomer(null); setSubscriptions([]); }}>×</button>
            </div>
          ) : (
            <>
              <Input placeholder="Последние цифры телефона или имя" className="h-12!"
                     value={query} onChange={(e) => setQuery(e.target.value)} />
              {found.map((c) => (
                <button key={c.id} className="btn small ghost" onClick={() => loadFor(c)}>
                  {c.full_name ?? "Без имени"} · {c.phone}
                </button>
              ))}
            </>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        {customer && subscriptions.length > 0 && (
          <div className="section">
            <span className="label">Абонементы гостя</span>
            {subscriptions.map((s) => (
              <div className="receipt" key={s.id}>
                <div className="receipt-head">
                  <strong>{s.plan_name}</strong>
                  <span className="hint">
                    {STATUS_LABEL[s.status] ?? s.status} · до {String(s.valid_to).slice(0, 10)}
                  </span>
                  <span className="price">
                    {s.type === "unlimited_period"
                      ? "безлимит"
                      : `${Number(s.balance)} из ${Number(s.allowance)} ${TYPE_LABEL[s.type]}`}
                  </span>
                </div>
                <div className="row">
                  {s.status === "frozen" ? (
                    <button className="btn small" disabled={busy}
                            onClick={() => act(async () => {
                              await api(`/v1/subscriptions/${s.id}/unfreeze`, { method: "POST" });
                            })}>
                      Разморозить
                    </button>
                  ) : (
                    <button className="btn small" disabled={busy || s.freeze_days_limit === 0}
                            title={s.freeze_days_limit === 0 ? "по этому абонементу заморозка не предусмотрена" : ""}
                            onClick={() => act(async () => {
                              await api(`/v1/subscriptions/${s.id}/freeze`,
                                { method: "POST", body: { reason: "по просьбе гостя" } });
                            })}>
                      Заморозить
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {customer && !sold && (
          <div className="section">
            <span className="label">Продать абонемент</span>
            {plans.map((p) => (
              <button key={p.id} className="btn" disabled={busy} onClick={() => sell(p.id)}>
                {p.name} · {formatTenge(p.price)} ·{" "}
                {p.type === "unlimited_period"
                  ? `${p.validity_days} дней`
                  : `${Number(p.allowance)} ${TYPE_LABEL[p.type]}, ${p.validity_days} дней`}
              </button>
            ))}
          </div>
        )}

        {sold && (
          <div className="section">
            <div className="total">
              <span>Абонемент продан — принять оплату</span>
              <span className="value">{formatTenge(sold.total)}</span>
            </div>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => payForSubscription("cash")}>Наличными</button>
              <button className="btn primary" disabled={busy} onClick={() => payForSubscription("card")}>Картой</button>
            </div>
            <span className="hint">
              Продажа проходит через смену и попадёт в Z-отчёт как обычная позиция.
            </span>
          </div>
        )}

        {!customer && (
          <span className="hint">
            Найдите гостя по телефону — покажем его абонементы и дадим продать новый.
            Деньги за проданный абонемент — обязательство перед гостем, а не прибыль:
            владелец видит этот долг в кабинете отдельной строкой.
          </span>
        )}
      </div>
    </div>
  );
}
