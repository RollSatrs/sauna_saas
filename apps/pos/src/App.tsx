import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, auth, formatTenge, отправитьОчередь, очередь, следитьЗаСвязью, type Context,
} from "./api.ts";
import { BoardGrid } from "./Board.tsx";
import { Login } from "./Login.tsx";
import { Bookings } from "./Bookings.tsx";
import { PaymentPanel, StartVisit, VisitPanel } from "./Panel.tsx";
import { Receipts } from "./Receipts.tsx";
import { SubscriptionsView } from "./Subscriptions.tsx";
import type { Board, Catalog, Tile } from "./types.ts";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
// @ts-expect-error — виртуальный модуль vite-plugin-pwa
import { useRegisterSW } from "virtual:pwa-register/react";
import { Input } from "@/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/ui/dialog";

type View = "board" | "bookings" | "receipts" | "subscriptions";

const VIEWS: { id: View; label: string }[] = [
  { id: "board", label: "Зал" },
  { id: "bookings", label: "Брони" },
  { id: "receipts", label: "Чеки" },
  { id: "subscriptions", label: "Абонементы" },
];

function ShiftDialog({ shift, onOpened, onClosed }: {
  shift: Board["shift"]; onOpened: () => void; onClosed: (report: unknown) => void;
}) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <h2>{shift ? "Закрытие смены" : "Открытие смены"}</h2>
      <span className="hint">
        {shift
          ? "Пересчитайте наличные в ящике и введите фактическую сумму. Система сравнит её с ожидаемой."
          : "Укажите, сколько наличных в ящике на начало смены. Без открытой смены касса работает только на просмотр."}
      </span>
      <Input inputMode="numeric" placeholder="сумма, ₸" value={amount} className="h-12!"
             onChange={(e) => setAmount(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <button className="btn primary" disabled={busy || amount === ""} onClick={() => run(async () => {
        const tiyn = Math.round(Number(amount) * 100);
        if (shift) {
          const r = await api<{ zReport: unknown }>(`/v1/shifts/${shift.id}/close`,
            { method: "POST", body: { countedCash: tiyn } });
          onClosed(r.zReport);
        } else {
          await api("/v1/shifts", { method: "POST", body: { openingCash: tiyn } });
          onOpened();
        }
      })}>
        {shift ? "Закрыть смену" : "Открыть смену"}
      </button>
    </div>
  );
}

function ZReport({ report, onClose }: { report: any; onClose: () => void }) {
  return (
    <div className="panel">
      <h2>Z-отчёт</h2>
      <span className="hint">Снимок итогов смены. Изменить его задним числом нельзя.</span>
      <div className="items">
        {report.payments.map((p: any) => (
          <div className="item" key={p.method}>
            <span>{p.method === "cash" ? "Наличные" : p.method === "card" ? "Карта" : p.method}</span>
            <span className="price">{formatTenge(p.total)}</span>
            <span>{p.count}</span>
          </div>
        ))}
        <div className="item"><span>Визитов</span><span className="price">{report.visits}</span><span /></div>
        <div className="item"><span>Гостей</span><span className="price">{report.guests}</span><span /></div>
        {report.refunds.count > 0 && (
          <div className="item"><span>Возвраты</span>
            <span className="price">{formatTenge(report.refunds.total)}</span>
            <span>{report.refunds.count}</span></div>
        )}
        <div className="item"><span>Ожидалось в кассе</span>
          <span className="price">{formatTenge(report.cash.expected)}</span><span /></div>
        <div className="item"><span>Фактически</span>
          <span className="price">{formatTenge(report.cash.counted)}</span><span /></div>
      </div>
      <div className="total">
        <span>{report.cash.discrepancy === 0 ? "Касса сошлась" : "Расхождение"}</span>
        <span className="value" style={{ color: report.cash.discrepancy === 0 ? "var(--ok)" : "var(--danger)" }}>
          {formatTenge(report.cash.discrepancy)}
        </span>
      </div>
      <button className="btn" onClick={onClose}>Готово</button>
    </div>
  );
}

export function App() {
  const [context, setContext] = useState<Context | null>(auth.context());
  const [board, setBoard] = useState<Board | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [view, setView] = useState<View>("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "shift" | "report" | "payment">("idle");
  const [payOrderId, setPayOrderId] = useState<string | null>(null);
  const [report, setReport] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [наСвязи, setНаСвязи] = useState(navigator.onLine);
  const [вОчереди, setВОчереди] = useState(0);
  const [снимокОт, setСнимокОт] = useState<number | null>(null);
  const [выход, setВыход] = useState(false);
  const offset = useRef(0);

  // Новая версия кассы ставится только по нажатию: перезагрузка в момент
  // приёма оплаты потеряла бы введённое.
  const { needRefresh: [естьОбновление], updateServiceWorker } = useRegisterSW({
    onRegisterError: () => { /* без service worker касса просто работает онлайн */ },
  });

  const load = useCallback(async () => {
    if (!auth.token()) return;
    try {
      const data = await api<Board & { offline?: boolean; snapshotAt?: number }>("/v1/board");
      // Разница между часами сервера и кассы: таймер обязан идти по серверу.
      // Из снимка её не берём — там время устаревшее, а часы кассы идут сами.
      if (!data.offline) offset.current = new Date(data.serverTime).getTime() - Date.now();
      setBoard(data);
      setСнимокОт(data.offline ? (data.snapshotAt ?? null) : null);
      setError(null);

      // Пока связь есть, подтягиваем карточки всех активных визитов в кэш.
      // Иначе при обрыве кассир смог бы открыть только те, что уже смотрел, —
      // а нужен любой: гость подходит доплатить именно тогда, когда сети нет.
      if (!data.offline) {
        for (const плитка of data.resources) {
          if (плитка.visit) {
            void api(`/v1/visits/${плитка.visit.id}`).catch(() => { /* прогрев не критичен */ });
          }
        }
      }
    } catch (e) {
      if ((e as { status?: number }).status === 401) { setContext(null); return; }
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!context) return;
    void load();
    void api<Catalog>("/v1/catalog").then(setCatalog).catch(() => {});
    const poll = setInterval(load, 8000);
    return () => clearInterval(poll);
  }, [context, load]);

  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now() + offset.current), 1000);
    return () => clearInterval(tick);
  }, []);

  // Сколько операций ждёт отправки — кассир должен это видеть, а не догадываться.
  const пересчитатьОчередь = useCallback(async () => {
    try { setВОчереди((await очередь.все()).length); } catch { /* хранилище недоступно */ }
  }, []);

  useEffect(() => {
    void пересчитатьОчередь();
    const таймер = setInterval(пересчитатьОчередь, 3000);
    return () => clearInterval(таймер);
  }, [пересчитатьОчередь]);

  // Связь вернулась — доотправляем накопленное и обновляем зал.
  const догнать = useCallback(async () => {
    const итог = await отправитьОчередь();
    await пересчитатьОчередь();
    if (итог.ошибки.length > 0) setError(`Не приняты сервером: ${итог.ошибки.join("; ")}`);
    await load();
  }, [load, пересчитатьОчередь]);

  useEffect(() => следитьЗаСвязью((связь) => {
    setНаСвязи(связь);
    if (связь) void догнать();
  }), [догнать]);

  // Горячие клавиши: у стойки очередь, мышь — не самый быстрый способ.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSelectedId(null); setMode("idle"); }
      if (event.key === "F2") {
        event.preventDefault();
        setView("board");
        const free = board?.resources.find((t) => !t.visit);
        if (free) setSelectedId(free.resourceId);
      }
      if (event.key === "F3") { event.preventDefault(); setView("bookings"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [board]);

  const selected = useMemo(
    () => board?.resources.find((t) => t.resourceId === selectedId) ?? null,
    [board, selectedId]);

  if (!context) return <Login onDone={setContext} />;

  const shift = board?.shift ?? null;
  const unpaid = board?.unpaidOrders ?? [];
  const showPanel = view === "board" && (mode !== "idle" || selected !== null);

  return (
    <div className="app">
      <div className="topbar">
        <h1>{catalog?.branch.name ?? context.branchName ?? context.orgName}</h1>
        <span className="muted">{context.orgName}</span>
        {/* Radix Tabs: стрелки, Home/End и роли для скринридера — бесплатно */}
        <Tabs value={view}
              onValueChange={(next) => { setView(next as View); setSelectedId(null); setMode("idle"); }}>
          <TabsList className="h-11 bg-secondary">
            {VIEWS.map((v) => (
              <TabsTrigger key={v.id} value={v.id} className="h-9 px-4 text-sm">
                {v.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="spacer" />
        {!наСвязи && (
          <span className="offline-chip">
            <span className="dot off" />
            Нет связи
            {вОчереди > 0 && <b> · {вОчереди} операц. ждут</b>}
            {снимокОт && (
              <em>зал на {new Date(снимокОт).toLocaleTimeString("ru-RU",
                { hour: "2-digit", minute: "2-digit" })}</em>
            )}
          </span>
        )}
        {наСвязи && вОчереди > 0 && (
          <button className="offline-chip sending" onClick={() => void догнать()}>
            <span className="dot" />
            Отправляю накопленное: {вОчереди}
          </button>
        )}
        {error && наСвязи && <span className="warn">{error}</span>}
        {unpaid.length > 0 && (
          <button className="shift-chip" onClick={() => {
            setView("board"); setSelectedId(null);
            setPayOrderId(unpaid[0].id); setMode("payment");
          }}>
            <span className="dot" style={{ background: "var(--warn)" }} />
            Не оплачено: {unpaid.length} ·{" "}
            {formatTenge(unpaid.reduce((a, o) => a + (o.total - o.paid_total), 0))}
          </button>
        )}
        {естьОбновление && (
          <button className="offline-chip sending" onClick={() => void updateServiceWorker(true)}>
            <span className="dot" />
            Готово обновление · применить
          </button>
        )}
        <button className="shift-chip" onClick={() => {
          setView("board"); setSelectedId(null); setMode("shift");
        }}>
          <span className={`dot ${shift ? "" : "off"}`} />
          {shift ? `Смена открыта · ${shift.opened_by_name}` : "Смена закрыта — открыть"}
        </button>

        {/* Кто за кассой. Нажатие — выход: при пересменке следующий
            администратор обязан войти под собой, иначе его действия
            запишутся на предыдущего. */}
        <button className="shift-chip user" onClick={() => setВыход(true)}
                title="Выйти из кассы">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          {context.userName ?? "Выйти"}
        </button>
      </div>

      <Dialog open={выход} onOpenChange={setВыход}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Выйти из кассы?</DialogTitle>
            <DialogDescription>
              {shift
                ? "Смена останется открытой — вы или сменщик сможете её продолжить. "
                  + "Закрывать смену нужно в конце дня, а не при выходе."
                : "Касса останется привязанной к филиалу. Для входа снова понадобится только PIN."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button className="btn ghost" onClick={() => setВыход(false)}>Остаться</button>
            <button className="btn primary" onClick={() => {
              auth.clear(); setВыход(false); setContext(null);
            }}>Выйти</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className={`layout ${showPanel ? "" : "solo"}`}>
        {view === "board" && (
          <div className="board">
            {board
              ? <BoardGrid tiles={board.resources} nowMs={nowMs} selectedId={selectedId}
                           onSelect={(t: Tile) => { setMode("idle"); setSelectedId(t.resourceId); }} />
              : <div className="empty">Загружаю зал…</div>}
          </div>
        )}
        {view === "bookings" && <Bookings catalog={catalog} />}
        {view === "receipts" && <Receipts onChanged={load} />}
        {view === "subscriptions" && <SubscriptionsView onChanged={load} />}

        {view === "board" && mode === "shift" && (
          <ShiftDialog shift={shift}
                       onOpened={() => { setMode("idle"); void load(); }}
                       onClosed={(r) => { setReport(r); setMode("report"); void load(); }} />
        )}
        {view === "board" && mode === "report" && report && (
          <ZReport report={report} onClose={() => { setMode("idle"); setReport(null); }} />
        )}
        {view === "board" && mode === "idle" && selected && !selected.visit && (
          <StartVisit tile={selected}
                      onDone={() => { setSelectedId(null); void load(); }}
                      onClose={() => setSelectedId(null)} />
        )}
        {view === "board" && mode === "idle" && selected?.visit && (
          <VisitPanel tile={selected} catalog={catalog} nowMs={nowMs} onChanged={load}
                      onFinished={(orderId) => {
                        setSelectedId(null); setPayOrderId(orderId);
                        setMode("payment"); void load();
                      }}
                      onClose={() => { setSelectedId(null); void load(); }} />
        )}
        {view === "board" && mode === "payment" && payOrderId && (
          <PaymentPanel orderId={payOrderId}
                        onPaid={() => { setPayOrderId(null); setMode("idle"); void load(); }}
                        onClose={() => { setPayOrderId(null); setMode("idle"); void load(); }} />
        )}
      </div>
    </div>
  );
}
