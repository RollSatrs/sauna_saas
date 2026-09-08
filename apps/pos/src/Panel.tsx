import { useEffect, useState } from "react";
import { api, formatClock, formatTenge, newKey } from "./api.ts";
import type { Catalog, OrderDetails, Tile, VisitDetails } from "./types.ts";
import { Input } from "@/ui/input";

const DURATIONS = [60, 120, 180];

/** Приём гостя: ресурс уже выбран, дальше — длительность, гости, старт. */
export function StartVisit({ tile, onDone, onClose }: {
  tile: Tile; onDone: () => void; onClose: () => void;
}) {
  const booking = tile.upcoming;
  const [minutes, setMinutes] = useState(120);
  const [guests, setGuests] = useState(2);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ id: string; phone: string; full_name: string | null }[]>([]);
  const [customer, setCustomer] = useState<{ id: string; full_name: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.length < 2) { setFound([]); return; }
    const timer = setTimeout(() => {
      api<{ customers: typeof found }>(`/v1/customers?q=${encodeURIComponent(query)}`)
        .then((r) => setFound(r.customers)).catch(() => setFound([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const start = async (fromBooking = false) => {
    setBusy(true); setError(null);
    try {
      // Приём по брони: длительность, гости и клиент берутся из неё —
      // кассиру не нужно ничего вводить заново.
      const body = fromBooking && booking
        ? {
            resourceId: tile.resourceId,
            bookingId: booking.id,
            serviceId: booking.service_id ?? undefined,
            plannedMinutes: Math.round(
              (new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 60000),
            guestsCount: booking.guests_count,
            customerId: booking.customer_id,
          }
        : {
            resourceId: tile.resourceId, plannedMinutes: minutes,
            guestsCount: guests, customerId: customer?.id ?? null,
          };
      await api("/v1/visits", { method: "POST", body });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="section">
        <h2>{tile.name}</h2>
        <span className="hint">{tile.typeName ?? "Ресурс"} · до {tile.capacity} человек</span>
      </div>

      {booking && (
        <div className="booking-card">
          <span className="label">Есть бронь на это помещение</span>
          <strong>
            {new Date(booking.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            –{new Date(booking.ends_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
          </strong>
          <span className="hint">
            {booking.customer_name ?? "Без имени"} · {booking.guests_count} чел.
          </span>
          <button className="btn primary" onClick={() => start(true)} disabled={busy}>
            {busy ? "Открываю…" : "Гость пришёл"}
          </button>
          <span className="hint">
            Время, число гостей и имя подставятся из брони. Ниже — если гость без брони.
          </span>
        </div>
      )}

      <div className="section">
        <span className="label">{booking ? "Или принять без брони" : "Сколько времени"}</span>
        <div className="row">
          {DURATIONS.map((m) => (
            <button key={m} className={`btn ${minutes === m ? "active" : ""}`} onClick={() => setMinutes(m)}>
              {m / 60} ч
            </button>
          ))}
        </div>
        <Input type="number" min={30} step={30} value={minutes} className="h-12!"
               onChange={(e) => setMinutes(Number(e.target.value))} />
      </div>

      <div className="section">
        <span className="label">Гостей</span>
        <div className="row">
          {[1, 2, 4, 6, 8].filter((n) => n <= tile.capacity).map((n) => (
            <button key={n} className={`btn ${guests === n ? "active" : ""}`} onClick={() => setGuests(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <span className="label">Гость (необязательно)</span>
        {customer ? (
          <div className="item">
            <span>{customer.full_name ?? "Без имени"}</span>
            <span />
            <button onClick={() => setCustomer(null)}>×</button>
          </div>
        ) : (
          <>
            <Input placeholder="Последние цифры телефона или имя" className="h-12!"
                   value={query} onChange={(e) => setQuery(e.target.value)} />
            {found.map((c) => (
              <button key={c.id} className="btn small ghost" onClick={() => { setCustomer(c); setQuery(""); }}>
                {c.full_name ?? "Без имени"} · {c.phone}
              </button>
            ))}
            {query.length >= 5 && found.length === 0 && (
              <button className="btn small" onClick={async () => {
                const r = await api<{ customer: { id: string; full_name: string | null } }>(
                  "/v1/customers", { method: "POST", body: { phone: query } });
                setCustomer(r.customer); setQuery("");
              }}>
                Завести гостя {query}
              </button>
            )}
          </>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="row">
        <button className="btn ghost" onClick={onClose}>Отмена</button>
        <button className={`btn ${booking ? "" : "primary"}`} onClick={() => start(false)} disabled={busy}>
          {busy ? "Открываю…" : "Начать"}
        </button>
      </div>
      <span className="hint">
        Стоимость посчитает система по тарифам филиала — вводить сумму вручную не нужно.
      </span>
    </div>
  );
}

/** Открытый визит: время, позиции, продление, расчёт. Деньги принимает PaymentPanel. */
export function VisitPanel({ tile, catalog, nowMs, onChanged, onFinished, onClose }: {
  tile: Tile; catalog: Catalog | null; nowMs: number;
  onChanged: () => void; onFinished: (orderId: string) => void; onClose: () => void;
}) {
  const visitId = tile.visit!.id;
  const [details, setDetails] = useState<VisitDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try { setDetails(await api<VisitDetails>(`/v1/visits/${visitId}`)); }
    catch (e) { setError((e as Error).message); }
  };

  useEffect(() => { void reload(); }, [visitId]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await reload(); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const extend = (minutes: number) => act(async () => {
    const r = await api<{ warning: string | null }>(`/v1/visits/${visitId}/extend`,
      { method: "POST", body: { minutes } });
    setWarning(r.warning);
  });

  const addItem = (kind: "product" | "service_extra", refId: string) => act(async () => {
    await api(`/v1/visits/${visitId}/items`, { method: "POST", body: { kind, refId, qty: 1 } });
  });

  const removeItem = (itemId: string) => act(async () => {
    await api(`/v1/visits/${visitId}/items/${itemId}`, { method: "DELETE" });
  });

  // Расчёт закрывает визит: плитка освобождается, а заказ уходит в оплату
  // отдельной панелью — иначе он исчез бы вместе с плиткой.
  const [useSubscription, setUseSubscription] = useState<string | null>(null);

  const finish = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ order: { id: string } }>(`/v1/visits/${visitId}/finish`,
        { method: "POST", body: useSubscription ? { subscriptionId: useSubscription } : undefined });
      onChanged();
      onFinished(r.order.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (!details) return <div className="panel"><span className="hint">Загружаю…</span></div>;

  const left = Math.round((new Date(tile.visit!.plannedEnd).getTime() - nowMs) / 60000);
  const extras = catalog?.services.filter((s) => s.kind === "extra") ?? [];

  return (
    <div className="panel">
      <div className="section">
        <h2>{details.visit.resource_name}</h2>
        <span className="hint">
          {details.visit.service_name} · {details.visit.guests_count} чел.
          {details.visit.customer_name ? ` · ${details.visit.customer_name}` : ""}
        </span>
      </div>

      <div className="section">
        <span className="label">{left < 0 ? "Переработка" : "Осталось"}</span>
        <span className="timer" style={{ fontSize: 40, fontWeight: 600 }}>
          {left < 0 ? `+${formatClock(-left)}` : formatClock(left)}
        </span>
        <div className="row">
          <button className="btn" onClick={() => extend(30)} disabled={busy}>+30 мин</button>
          <button className="btn" onClick={() => extend(60)} disabled={busy}>+1 час</button>
        </div>
        {warning && <span className="warn">{warning}</span>}
      </div>

      <div className="section">
        <span className="label">Время по тарифу</span>
        <div className="segments">
          {details.timeQuote.segments.map((s, i) => (
            <span key={i}>
              {new Date(s.from).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}–
              {new Date(s.to).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
              {" · "}{s.minutes} мин по {formatTenge(s.ratePerHour)}/ч = {formatTenge(s.amount)}
            </span>
          ))}
          {details.timeQuote.minimumApplied && (
            <span className="warn">Применена минимальная длительность тарифа</span>
          )}
        </div>
      </div>

      {details.items.length > 0 && (
        <div className="section">
          <span className="label">Позиции</span>
          <div className="items">
            {details.items.map((item) => (
              <div className="item" key={item.id}>
                <span>{item.name_snapshot}{item.kind !== "service_time" && Number(item.qty) > 1 ? ` × ${Number(item.qty)}` : ""}</span>
                <span className="price">{formatTenge(item.total)}</span>
                {item.kind === "service_time"
                  ? <span />
                  : <button onClick={() => removeItem(item.id)} title="Убрать">×</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <span className="label">Добавить</span>
        <div className="row">
          {extras.map((s) => (
            <button key={s.id} className="btn small" onClick={() => addItem("service_extra", s.id)} disabled={busy}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="row">
          {(catalog?.products ?? []).map((p) => (
            <button key={p.id} className="btn small" onClick={() => addItem("product", p.id)} disabled={busy}>
              {p.name} · {formatTenge(p.price)}
            </button>
          ))}
        </div>
      </div>

      {details.subscriptions.length > 0 && (
        <div className="section">
          <span className="label">Абонемент гостя</span>
          {details.subscriptions.map((sub) => (
            <button key={sub.id}
                    className={`btn small ${useSubscription === sub.id ? "active" : ""}`}
                    onClick={() => setUseSubscription(useSubscription === sub.id ? null : sub.id)}>
              {sub.planName} ·{" "}
              {sub.type === "unlimited_period"
                ? `безлимит до ${sub.validTo}`
                : sub.type === "hours"
                  ? `осталось ${sub.balance} ч`
                  : `осталось ${sub.balance} посещений`}
            </button>
          ))}
          <span className="hint">
            {useSubscription
              ? "Время спишется с абонемента, деньгами гость доплатит только остаток."
              : "Нажмите, чтобы закрыть время абонементом."}
          </span>
        </div>
      )}

      {(details as { offline?: boolean }).offline && (
        <span className="warn">
          Нет связи — показан последний известный расчёт. Добавленное сейчас
          уйдёт на сервер, когда интернет вернётся.
        </span>
      )}

      <div className="total">
        <span>К оплате</span>
        <span className="value">{formatTenge(details.dueTotal)}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn ghost" onClick={onClose}>Закрыть</button>
        <button className="btn primary" onClick={finish} disabled={busy}>
          {useSubscription ? "Рассчитать по абонементу" : "Рассчитать"}
        </button>
      </div>
    </div>
  );
}

/**
 * Приём денег по рассчитанному заказу. Живёт отдельно от визита: гость уже вышел
 * из парной, плитка освободилась, а заказ ещё существует и потеряться не должен.
 */
export function PaymentPanel({ orderId, onPaid, onClose }: {
  orderId: string; onPaid: () => void; onClose: () => void;
}) {
  const [details, setDetails] = useState<OrderDetails | null>(null);
  const [given, setGiven] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try { setDetails(await api<OrderDetails>(`/v1/orders/${orderId}`)); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void reload(); }, [orderId]);

  if (!details) return <div className="panel"><span className="hint">Загружаю заказ…</span></div>;

  const remaining = details.order.total - details.order.paid_total;
  const change = given ? Math.round(Number(given) * 100) - remaining : 0;

  const pay = async (method: "cash" | "card") => {
    setBusy(true); setError(null);
    try {
      // Ключ идемпотентности: повтор при обрыве сети не создаст второй чек.
      const r = await api<{ order: { paid_total: number; total: number } }>(
        `/v1/orders/${orderId}/payments`,
        { method: "POST", idempotencyKey: newKey("pay"), body: { method, amount: remaining } });
      if (Number(r.order.paid_total) >= Number(r.order.total)) onPaid();
      else await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Оплата</h2>
      <div className="items">
        {details.items.map((item) => (
          <div className="item" key={item.id}>
            <span>{item.name_snapshot}{item.kind !== "service_time" && Number(item.qty) > 1 ? ` × ${Number(item.qty)}` : ""}</span>
            <span className="price">{formatTenge(item.total)}</span>
            <span />
          </div>
        ))}
      </div>

      {details.payments.length > 0 && (
        <div className="section">
          <span className="label">Уже внесено</span>
          {details.payments.map((p) => (
            <div className="item" key={p.id}>
              <span>{p.method === "cash" ? "Наличные" : "Карта"}</span>
              <span className="price">{formatTenge(p.amount)}</span>
              <span />
            </div>
          ))}
        </div>
      )}

      <div className="total">
        <span>К оплате</span>
        <span className="value">{formatTenge(Math.max(remaining, 0))}</span>
      </div>

      {remaining <= 0 ? (
        <>
          <span className="hint">
            Платить нечего: всё закрыто абонементом. Гостя можно отпускать.
          </span>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" onClick={onPaid}>Готово</button>
        </>
      ) : (
        <>
          <div className="section">
            <span className="label">Наличными — получено</span>
            <Input inputMode="numeric" placeholder="сумма от гостя, ₸" className="h-12!"
                   value={given} onChange={(e) => setGiven(e.target.value)} />
            {given && (
              <span className={change >= 0 ? "hint" : "warn"}>
                {change >= 0 ? `Сдача: ${formatTenge(change)}` : `Не хватает ${formatTenge(-change)}`}
              </span>
            )}
          </div>

          {error && <div className="error">{error}</div>}
          <div className="row">
            <button className="btn" onClick={() => pay("cash")} disabled={busy || change < 0}>Наличными</button>
            <button className="btn primary" onClick={() => pay("card")} disabled={busy}>Картой</button>
          </div>
          <button className="btn ghost small" onClick={onClose}>Отложить</button>
          <span className="hint">
            Отложенный заказ виден в счётчике неоплаченных наверху — он не потеряется.
          </span>
        </>
      )}
    </div>
  );
}
