import { useCallback, useEffect, useMemo, useState } from "react";
import { api, formatClock, formatTenge } from "./api.ts";
import type { Board, Catalog, PublicVisit, VisitDetails } from "./types.ts";

type Mode = "list" | "start" | "visit" | "sale";

export function PublicBath({ catalog, shift, nowMs, onPayment, onChanged }: {
  catalog: Catalog | null;
  shift: Board["shift"];
  nowMs: number;
  onPayment: (orderId: string) => void;
  onChanged: () => void;
}) {
  const [visits, setVisits] = useState<PublicVisit[]>([]);
  const [mode, setMode] = useState<Mode>("list");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await api<{ visits: PublicVisit[] }>("/v1/visits/public");
      setVisits(data.visits);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(reload, 8000);
    return () => clearInterval(timer);
  }, [reload]);

  const entries = catalog?.services.filter(
    (service) => (service.kind === "entry" || service.kind === "per_person") && service.current_price !== null,
  ) ?? [];

  if (mode === "start" && serviceId) {
    const service = entries.find((item) => item.id === serviceId);
    if (service) {
      return <StartPublicVisit service={service} onClose={() => setMode("list")} onDone={(id) => {
        setVisitId(id); setMode("visit"); void reload(); onChanged();
      }} />;
    }
  }

  if (mode === "visit" && visitId) {
    return <PublicVisitPanel visitId={visitId} catalog={catalog} nowMs={nowMs}
      onClose={() => { setVisitId(null); setMode("list"); void reload(); }}
      onChanged={() => { void reload(); onChanged(); }}
      onFinished={(orderId) => { setVisitId(null); setMode("list"); onPayment(orderId); }} />;
  }

  if (mode === "sale") {
    return <QuickSale catalog={catalog} onClose={() => setMode("list")}
      onPayment={(orderId) => { setMode("list"); onPayment(orderId); onChanged(); }} />;
  }

  return (
    <div className="public-bath">
      <div className="section public-actions">
        <div>
          <h2>Новый посетитель</h2>
          <span className="hint">Выберите готовый тариф — помещение и почасовой расчёт не нужны.</span>
        </div>
        <button className="btn" onClick={() => setMode("sale")} disabled={!shift}>
          Быстрая продажа без визита
        </button>
      </div>

      {!shift && <div className="warn">Откройте смену, чтобы принимать посетителей и продажи.</div>}
      {error && <div className="error">{error}</div>}

      <div className="grid entry-grid">
        {entries.map((service) => (
          <button key={service.id} className="tile free" disabled={!shift}
            onClick={() => { setServiceId(service.id); setMode("start"); }}>
            <span className="badge">тариф посещения</span>
            <span className="name">{service.name}</span>
            <span className="sub">{service.kind === "per_person" ? "за каждого гостя" : "за один визит"}</span>
            <span className="amount">{formatTenge(service.current_price ?? 0)}</span>
          </button>
        ))}
        {entries.length === 0 && <div className="empty">Нет действующих тарифов посещения.</div>}
      </div>

      <div className="section">
        <h2>Сейчас в бане</h2>
        <span className="hint">Время показано информационно и не меняет фиксированную цену.</span>
      </div>
      <div className="grid entry-grid">
        {visits.map((visit) => {
          const elapsed = Math.max(0, Math.floor((nowMs - new Date(visit.started_at).getTime()) / 60000));
          return (
            <button key={visit.id} className="tile busy" onClick={() => {
              setVisitId(visit.id); setMode("visit");
            }}>
              <span className="badge">в бане</span>
              <span className="name">{visit.service_name}</span>
              <span className="sub">{visit.customer_name ?? "Без имени"} · {visit.guests_count} чел.</span>
              <span className="timer">прошло {formatClock(elapsed)}</span>
              <span className="amount">{formatTenge(Number(visit.total))}</span>
            </button>
          );
        })}
        {visits.length === 0 && <div className="empty">Открытых посещений пока нет.</div>}
      </div>
    </div>
  );
}

function StartPublicVisit({ service, onDone, onClose }: {
  service: Catalog["services"][number];
  onDone: (visitId: string) => void;
  onClose: () => void;
}) {
  const [guests, setGuests] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = (service.current_price ?? 0) * (service.kind === "per_person" ? guests : 1);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api<{ visit: { id: string } }>("/v1/visits", {
        method: "POST", body: { serviceId: service.id, guestsCount: guests },
      });
      onDone(result.visit.id);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="panel public-panel">
      <h2>{service.name}</h2>
      <span className="hint">Цена фиксируется сейчас и не изменится от времени выхода.</span>
      <div className="section">
        <span className="label">Гостей</span>
        <div className="row">
          {[1, 2, 3, 4, 5, 6].map((count) => (
            <button key={count} className={`btn ${guests === count ? "active" : ""}`}
              onClick={() => setGuests(count)}>{count}</button>
          ))}
        </div>
      </div>
      <div className="total"><span>Стоимость входа</span><span className="value">{formatTenge(total)}</span></div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn ghost" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={start} disabled={busy}>
          {busy ? "Открываю…" : "Открыть посещение"}
        </button>
      </div>
    </div>
  );
}

function PublicVisitPanel({ visitId, catalog, nowMs, onChanged, onFinished, onClose }: {
  visitId: string; catalog: Catalog | null; nowMs: number;
  onChanged: () => void; onFinished: (orderId: string) => void; onClose: () => void;
}) {
  const [details, setDetails] = useState<VisitDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try { setDetails(await api<VisitDetails>(`/v1/visits/${visitId}`)); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void reload(); }, [visitId]);

  const addItem = async (kind: "product" | "service_extra", refId: string) => {
    setBusy(true); setError(null);
    try {
      await api(`/v1/visits/${visitId}/items`, { method: "POST", body: { kind, refId, qty: 1 } });
      await reload(); onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const finish = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api<{ order: { id: string } }>(`/v1/visits/${visitId}/finish`, { method: "POST" });
      onFinished(result.order.id);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  if (!details) return <div className="panel"><span className="hint">Загружаю посещение…</span></div>;
  const elapsed = Math.max(0, Math.floor((nowMs - new Date(details.visit.started_at).getTime()) / 60000));
  const extras = catalog?.services.filter((service) => service.kind === "extra") ?? [];

  return (
    <div className="panel public-panel">
      <div className="section">
        <h2>{details.visit.service_name}</h2>
        <span className="hint">{details.visit.guests_count} чел. · прошло {formatClock(elapsed)}</span>
      </div>
      {details.items.length > 0 && (
        <div className="items">
          {details.items.map((item) => (
            <div className="item" key={item.id}>
              <span>{item.name_snapshot}{Number(item.qty) > 1 ? ` × ${Number(item.qty)}` : ""}</span>
              <span className="price">{formatTenge(item.total)}</span><span />
            </div>
          ))}
        </div>
      )}
      <div className="section">
        <span className="label">Добавить</span>
        <div className="row">
          {extras.map((service) => (
            <button key={service.id} className="btn small" disabled={busy || service.current_price === null}
              onClick={() => addItem("service_extra", service.id)}>
              {service.name}{service.current_price !== null ? ` · ${formatTenge(service.current_price)}` : ""}
            </button>
          ))}
          {(catalog?.products ?? []).map((product) => (
            <button key={product.id} className="btn small" disabled={busy}
              onClick={() => addItem("product", product.id)}>
              {product.name} · {formatTenge(product.price)}
            </button>
          ))}
        </div>
      </div>
      <div className="total"><span>К оплате</span><span className="value">{formatTenge(details.dueTotal)}</span></div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn ghost" onClick={onClose}>Закрыть</button>
        <button className="btn primary" onClick={finish} disabled={busy}>Завершить и оплатить</button>
      </div>
    </div>
  );
}

type CartItem = { kind: "product" | "service_extra"; refId: string; name: string; price: number; qty: number };

function QuickSale({ catalog, onClose, onPayment }: {
  catalog: Catalog | null; onClose: () => void; onPayment: (orderId: string) => void;
}) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = useMemo(() => cart.reduce((sum, item) => sum + item.price * item.qty, 0), [cart]);

  const add = (item: Omit<CartItem, "qty">) => setCart((current) => {
    const found = current.find((row) => row.kind === item.kind && row.refId === item.refId);
    return found
      ? current.map((row) => row === found ? { ...row, qty: row.qty + 1 } : row)
      : [...current, { ...item, qty: 1 }];
  });

  const checkout = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api<{ order: { id: string } }>("/v1/orders", {
        method: "POST", body: { items: cart.map(({ kind, refId, qty }) => ({ kind, refId, qty })) },
      });
      onPayment(result.order.id);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="panel public-panel">
      <h2>Быстрая продажа</h2>
      <span className="hint">Без визита, тарифа входа и таймера.</span>
      <div className="section">
        <span className="label">Дополнительные услуги</span>
        <div className="row">
          {(catalog?.services ?? []).filter((service) => service.kind === "extra" && service.current_price !== null)
            .map((service) => (
              <button key={service.id} className="btn small" onClick={() => add({
                kind: "service_extra", refId: service.id, name: service.name,
                price: service.current_price ?? 0,
              })}>{service.name} · {formatTenge(service.current_price ?? 0)}</button>
            ))}
        </div>
      </div>
      <div className="section">
        <span className="label">Товары</span>
        <div className="row">
          {(catalog?.products ?? []).map((product) => (
            <button key={product.id} className="btn small" onClick={() => add({
              kind: "product", refId: product.id, name: product.name, price: product.price,
            })}>{product.name} · {formatTenge(product.price)}</button>
          ))}
        </div>
      </div>
      {cart.length > 0 && <div className="items">
        {cart.map((item) => (
          <div className="item" key={`${item.kind}:${item.refId}`}>
            <span>{item.name} × {item.qty}</span>
            <span className="price">{formatTenge(item.price * item.qty)}</span>
            <button onClick={() => setCart((current) => current.flatMap((row) =>
              row === item ? row.qty > 1 ? [{ ...row, qty: row.qty - 1 }] : [] : [row]))}>×</button>
          </div>
        ))}
      </div>}
      <div className="total"><span>Итого</span><span className="value">{formatTenge(total)}</span></div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn ghost" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={checkout} disabled={busy || cart.length === 0}>К оплате</button>
      </div>
    </div>
  );
}
