import { useCallback, useEffect, useState } from "react";
import { api, auth, formatCompact, formatTenge, type Context } from "./api.ts";
import { BarList, MethodSplit, OccupancyHeatmap, RevenueChart } from "./charts.tsx";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { Settings } from "./Settings.tsx";
import { Input } from "@/ui/input";

type Summary = {
  range: { from: string; to: string };
  revenue: number; revenueGross: number; refunds: number; previousRevenue: number;
  orders: number; visits: number; guests: number; averageCheck: number;
  byDay: { day: string; revenue: number; orders: number }[];
  byMethod: { method: string; total: number; count: number }[];
};
type Sales = {
  byKind: { kind: string; total: number; covered: number; count: number }[];
  byItem: { name: string; kind: string; qty: number; total: number }[];
};
type Occupancy = {
  heatmap: { dow: number; hour: number; busyHours: number }[];
  byResource: { name: string; visits: number; hours: number; revenue: number }[];
};
type Shifts = {
  shifts: {
    id: string; opened_at: string; closed_at: string | null; status: string;
    cashier: string; branch: string; revenue: number; refunds: number;
    visits: number; discrepancy: number | null;
  }[];
};
type Subs = {
  plans: { name: string; type: string; price: number; sold: number; revenue: number;
           balanceLeft: number; liability: number }[];
  usage: { unitsUsed: number; moneyCovered: number; charges: number };
  totalLiability: number;
};

const KIND_LABEL: Record<string, string> = {
  service_time: "Время в парной",
  service_extra: "Доп. услуги",
  product: "Товары",
  subscription: "Абонементы",
};

const RANGES = [
  { id: "7", label: "7 дней", days: 7 },
  { id: "30", label: "30 дней", days: 30 },
  { id: "90", label: "Квартал", days: 90 },
];

const isoDay = (offsetDays: number) =>
  new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);

function Login({ onDone }: { onDone: (ctx: Context) => void }) {
  const [phone, setPhone] = useState("+77010000001");
  const [password, setPassword] = useState("owner123");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
      <form onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setError(null);
        try {
          const r = await api<{ token: string; context: Context }>("/v1/auth/login",
            { method: "POST", body: { phone, password } });
          auth.save(r.token, r.context);
          onDone(r.context);
        } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>
        <h1>Кабинет владельца</h1>
        <span className="muted">Вход по телефону и паролю</span>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)}
               autoComplete="username" className="h-11!" />
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
               autoComplete="current-password" className="h-11!" />
        {error && <div className="error">{error}</div>}
        <button className="btn" disabled={busy}>{busy ? "Проверяю…" : "Войти"}</button>
      </form>
    </div>
  );
}

function Kpi({ label, value, delta, note, alarm }: {
  label: string; value: string; delta?: number | null; note?: string; alarm?: boolean;
}) {
  return (
    <div className={`kpi ${alarm ? "alarm" : ""}`}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {delta !== undefined && delta !== null && (
        <span className={`delta ${delta >= 0 ? "up" : "down"}`}>
          {delta >= 0 ? "↑" : "↓"} {Math.abs(delta)}% к прошлому периоду
        </span>
      )}
      {note && <span className="delta muted">{note}</span>}
    </div>
  );
}

export function App() {
  const [context, setContext] = useState<Context | null>(auth.context());
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchId, setBranchId] = useState<string>("");
  const [rangeId, setRangeId] = useState("30");
  const [экран, setЭкран] = useState<"analytics" | "settings">("analytics");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sales, setSales] = useState<Sales | null>(null);
  const [occupancy, setOccupancy] = useState<Occupancy | null>(null);
  const [shifts, setShifts] = useState<Shifts | null>(null);
  const [subs, setSubs] = useState<Subs | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const days = RANGES.find((r) => r.id === rangeId)!.days;
    const query = `from=${isoDay(days - 1)}&to=${isoDay(0)}${branchId ? `&branchId=${branchId}` : ""}`;
    try {
      const [s, sl, oc, sh, sb] = await Promise.all([
        api<Summary>(`/v1/reports/summary?${query}`),
        api<Sales>(`/v1/reports/sales?${query}`),
        api<Occupancy>(`/v1/reports/occupancy?${query}`),
        api<Shifts>(`/v1/reports/shifts?${query}`),
        api<Subs>(`/v1/reports/subscriptions?${query}`),
      ]);
      setSummary(s); setSales(sl); setOccupancy(oc); setShifts(sh); setSubs(sb);
      setError(null);
    } catch (e) {
      if ((e as { status?: number }).status === 401) { setContext(null); return; }
      setError((e as Error).message);
    }
  }, [rangeId, branchId]);

  useEffect(() => {
    if (!context) return;
    api<{ branches: { id: string; name: string }[] }>("/v1/branches")
      .then((r) => setBranches(r.branches)).catch(() => {});
  }, [context]);

  useEffect(() => { if (context && экран === "analytics") void load(); }, [context, load, экран]);

  if (!context) return <Login onDone={setContext} />;

  const delta = summary && summary.previousRevenue > 0
    ? Math.round(((summary.revenue - summary.previousRevenue) / summary.previousRevenue) * 100)
    : null;
  const problemShifts = shifts?.shifts.filter((s) => (s.discrepancy ?? 0) !== 0) ?? [];

  return (
    <>
      <div className="top">
        <h1>{context.orgName}</h1>
        <Tabs value={экран} onValueChange={(v) => setЭкран(v as "analytics" | "settings")}>
          <TabsList className="h-10">
            <TabsTrigger value="analytics" className="h-8 px-4">Аналитика</TabsTrigger>
            <TabsTrigger value="settings" className="h-8 px-4">Настройки</TabsTrigger>
          </TabsList>
        </Tabs>
        {экран === "analytics" && <>
        {/* Радиксовый Select вместо нативного: одинаково выглядит во всех
            браузерах, слушается клавиатуры и не ломает тёмную тему. */}
        <Select value={branchId || "all"}
                onValueChange={(v) => setBranchId(v === "all" ? "" : v)}>
          <SelectTrigger className="h-11! min-w-[200px]" aria-label="Филиал">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* 44px — минимальная цель для пальца: кабинет открывают и с телефона */}
            <SelectItem value="all" className="h-11 text-[15px]">Все филиалы</SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.id} value={b.id} className="h-11 text-[15px]">{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Tabs value={rangeId} onValueChange={setRangeId}>
          <TabsList className="h-10">
            {RANGES.map((r) => (
              <TabsTrigger key={r.id} value={r.id} className="h-8 px-4">{r.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        </>}
        <div className="spacer" />
        <button className="btn ghost" onClick={() => { auth.clear(); setContext(null); }}>Выйти</button>
      </div>

      <div className="page">
        {экран === "settings" ? <Settings branches={branches} /> : <>
        {error && <div className="error">{error}</div>}

        <div className="kpis">
          <Kpi label="Выручка" value={summary ? formatCompact(summary.revenue) : "—"} delta={delta}
               note={summary && summary.refunds > 0 ? `возвраты ${formatTenge(summary.refunds)}` : undefined} />
          <Kpi label="Средний чек" value={summary ? formatTenge(summary.averageCheck) : "—"}
               note={summary ? `${summary.orders} чек(ов)` : undefined} />
          <Kpi label="Визитов" value={summary ? String(summary.visits) : "—"}
               note={summary ? `${summary.guests} гостей` : undefined} />
          <Kpi label="Долг по абонементам"
               value={subs ? formatCompact(subs.totalLiability) : "—"}
               note="оплачено, но не отгуляно" />
          <Kpi label="Расхождения по кассе"
               value={problemShifts.length === 0 ? "нет" : String(problemShifts.length)}
               note={problemShifts.length === 0 ? "все смены сошлись" : "смен с недостачей или излишком"}
               alarm={problemShifts.length > 0} />
        </div>

        <div className="card">
          <h2>Выручка по дням</h2>
          <span className="sub">Полученные деньги за вычетом возвратов. Наведите курсор — покажем день.</span>
          {summary && <RevenueChart data={summary.byDay} />}
        </div>

        <div className="two-col">
          <div className="card">
            <h2>Чем платят</h2>
            <span className="sub">Доли способов оплаты за период</span>
            {summary && <MethodSplit items={summary.byMethod} />}
          </div>
          <div className="card">
            <h2>На чём зарабатываем</h2>
            <span className="sub">Выручка по видам позиций</span>
            {sales && (
              <BarList
                items={sales.byKind.map((k) => ({
                  label: KIND_LABEL[k.kind] ?? k.kind,
                  value: k.total,
                  note: k.covered > 0 ? `+${formatTenge(k.covered)} по абонементам` : undefined,
                }))}
                total={sales.byKind.reduce((a, k) => a + k.total, 0)} />
            )}
          </div>
        </div>

        <div className="card">
          <h2>Загрузка по дням недели и часам</h2>
          <span className="sub">
            Где простой, а где не хватает мощности. Это главный аргумент при пересмотре тарифов.
          </span>
          {occupancy && <OccupancyHeatmap data={occupancy.heatmap} />}
        </div>

        <div className="two-col">
          <div className="card">
            <h2>Ресурсы</h2>
            <span className="sub">Что приносит деньги, а что простаивает</span>
            {occupancy && (
              <BarList items={occupancy.byResource.map((r) => ({
                label: r.name, value: r.revenue, note: `${r.visits} визитов · ${r.hours} ч`,
              }))} />
            )}
          </div>
          <div className="card">
            <h2>Что продаём</h2>
            <span className="sub">Топ позиций за период</span>
            {sales && (
              <BarList items={sales.byItem.slice(0, 8).map((i) => ({
                label: i.name, value: i.total, note: `${i.qty} шт`,
              }))} />
            )}
          </div>
        </div>

        <div className="card">
          <h2>Смены</h2>
          <span className="sub">Расхождение — это разница между ожидаемой и пересчитанной наличностью</span>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Открыта</th><th>Кассир</th><th>Филиал</th>
                  <th className="num">Визитов</th><th className="num">Выручка</th>
                  <th className="num">Возвраты</th><th className="num">Расхождение</th><th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {(shifts?.shifts ?? []).map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.opened_at).toLocaleString("ru-RU",
                      { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                    <td>{s.cashier}</td>
                    <td>{s.branch}</td>
                    <td className="num">{s.visits}</td>
                    <td className="num">{formatTenge(s.revenue)}</td>
                    <td className="num">{s.refunds > 0 ? formatTenge(s.refunds) : "—"}</td>
                    <td className="num">
                      {s.discrepancy === null ? "—" : (
                        <span className={`chip ${s.discrepancy === 0 ? "ok" : "bad"}`}>
                          {s.discrepancy === 0 ? "сошлась" : formatTenge(s.discrepancy)}
                        </span>
                      )}
                    </td>
                    <td>{s.status === "open" ? "открыта" : "закрыта"}</td>
                  </tr>
                ))}
                {(shifts?.shifts.length ?? 0) === 0 && (
                  <tr><td colSpan={8}><div className="empty">За период смен не было</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>Абонементы</h2>
          <span className="sub">
            Проданные, но не отгулянные абонементы — обязательство перед гостем, а не прибыль
          </span>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Абонемент</th><th className="num">Продано</th><th className="num">Выручка</th>
                  <th className="num">Остаток по балансам</th><th className="num">Долг перед гостями</th>
                </tr>
              </thead>
              <tbody>
                {(subs?.plans ?? []).map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td className="num">{p.sold}</td>
                    <td className="num">{formatTenge(p.revenue)}</td>
                    <td className="num">{p.type === "unlimited_period" ? "—" : p.balanceLeft}</td>
                    <td className="num">{formatTenge(p.liability)}</td>
                  </tr>
                ))}
                {(subs?.plans.length ?? 0) === 0 && (
                  <tr><td colSpan={5}><div className="empty">Абонементы не заведены</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
          {subs && subs.usage.charges > 0 && (
            <div className="note" style={{ marginTop: 12 }}>
              За период абонементами закрыто услуг на {formatTenge(subs.usage.moneyCovered)} —
              это выручка, которую вы уже получили раньше, при продаже абонемента.
              Списаний: {subs.usage.charges}.
            </div>
          )}
        </div>
        </>}
      </div>
    </>
  );
}
