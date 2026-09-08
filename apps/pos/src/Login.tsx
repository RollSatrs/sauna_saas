import { useCallback, useEffect, useRef, useState } from "react";
import { api, auth, device, server, type Context } from "./api.ts";
import { Input } from "@/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/ui/select";

/**
 * Вход на кассу. Раскладка цифр — калькуляторная (7-8-9 сверху), как на
 * привычном кассовом оборудовании: у администраторов на неё мышечная память,
 * и телефонная раскладка стоила бы ошибок ввода в первые недели.
 */
const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3"];
const PIN_MAX = 8;
const PIN_AUTO = 4; // обычная длина: вход происходит сам, без лишнего нажатия

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
                "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div>
      <div className="clock">
        {String(now.getHours()).padStart(2, "0")}:{String(now.getMinutes()).padStart(2, "0")}
      </div>
      <div className="clock-date">
        {now.getDate()} {MONTHS[now.getMonth()]} {now.getFullYear()}, {WEEKDAYS[now.getDay()]}
      </div>
    </div>
  );
}

function Aside({ bound, onRebind }: {
  bound: { orgName: string; branchName: string; name: string } | null;
  onRebind: () => void;
}) {
  return (
    <aside className="signin-aside">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff"
               strokeWidth="1.8" strokeLinecap="round">
            <path d="M8 14c0-2 2-2.6 2-4.4C10 7.8 8.6 7 8 6" />
            <path d="M12 14c0-2 2-2.6 2-4.4C14 7.8 12.6 7 12 6" />
            <path d="M16 14c0-2 2-2.6 2-4.4C18 7.8 16.6 7 16 6" />
            <path d="M4 17.5h16M4 20.5h16" />
          </svg>
        </span>
        <span>
          <span className="brand-name">Касса</span>
          <span className="brand-sub">Баня · сауна · комплекс</span>
        </span>
      </div>

      {bound ? (
        <>
          <div className="aside-field">
            <span className="k">Торговая точка</span>
            <span className="v">{bound.orgName}</span>
          </div>
          <div className="aside-field">
            <span className="k">Филиал</span>
            <span className="v">{bound.branchName}</span>
          </div>
          <div className="aside-field">
            <span className="k">Рабочее место</span>
            <span className="v">{bound.name}</span>
          </div>
        </>
      ) : (
        <div className="aside-field">
          <span className="k">Рабочее место</span>
          <span className="v">Не привязано</span>
        </div>
      )}

      <div className="aside-foot">
        <span>Версия 0.1 · MVP</span>
        <span className="support">
          Поддержка<br />
          <a href="tel:+77000000000">+7 700 000-00-00</a>
        </span>
        {bound && (
          <button className="pad-link" style={{ alignSelf: "start" }} onClick={onRebind}>
            Перепривязать кассу
          </button>
        )}
      </div>
    </aside>
  );
}

/** Ежедневный вход: четыре цифры. Пароль на кассе больше не набирается. */
function PinPad({ bound, onDone, onRebind }: {
  bound: { orgName: string; branchName: string; name: string };
  onDone: (ctx: Context) => void;
  onRebind: () => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);

  const submit = useCallback(async (value: string) => {
    setBusy(true); setError(null);
    try {
      const saved = device.read()!;
      const r = await api<{ token: string; context: Context; user: { fullName: string } }>(
        "/v1/auth/pin", {
          method: "POST",
          body: { deviceId: saved.id, deviceToken: saved.token, pin: value },
        });
      const контекст = { ...r.context, userName: r.user.fullName };
      auth.save(r.token, контекст);
      onDone(контекст);
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      setBad(true);
      setPin("");
      setTimeout(() => setBad(false), 400);
      if (message.includes("не привязана")) onRebind();
    } finally {
      setBusy(false);
    }
  }, [onDone, onRebind]);

  const press = useCallback((digit: string) => {
    if (busy) return;
    setError(null);
    setPin((current) => {
      if (current.length >= PIN_MAX) return current;
      const next = current + digit;
      // Вход при обычной длине происходит сам — это экономит нажатие
      // на каждом входе за смену; для длинных PIN остаётся кнопка.
      if (next.length === PIN_AUTO) void submit(next);
      return next;
    });
  }, [busy, submit]);

  // Физическая клавиатура: у части касс она есть, и это самый быстрый ввод.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key >= "0" && event.key <= "9") { event.preventDefault(); press(event.key); }
      if (event.key === "Backspace") { event.preventDefault(); setPin((p) => p.slice(0, -1)); }
      if (event.key === "Escape") { setPin(""); setError(null); }
      if (event.key === "Enter" && pin.length >= PIN_AUTO) { event.preventDefault(); void submit(pin); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, pin, submit]);

  return (
    <div className="pad">
      <Clock />
      <p className="pad-prompt">Введите PIN сотрудника</p>

      <div className={`pin-box ${bad ? "bad shake" : ""}`}
           role="status" aria-live="polite"
           aria-label={`Введено цифр: ${pin.length}`}>
        {pin.length === 0
          ? <span className="pin-empty">— — — —</span>
          : Array.from({ length: Math.max(pin.length, PIN_AUTO) }, (_, i) => (
              <span key={i} className={`pin-dot ${i < pin.length ? "on" : ""}`} />
            ))}
      </div>

      {error && <div className="pad-error">{error}</div>}

      <div className="keys">
        {KEYS.map((k) => (
          <button key={k} className="key" onClick={() => press(k)} disabled={busy}
                  aria-label={`Цифра ${k}`}>
            {k}
          </button>
        ))}
        <button className="key secondary" onClick={() => { setPin(""); setError(null); }}
                disabled={busy} aria-label="Очистить">
          Сброс
        </button>
        <button className="key" onClick={() => press("0")} disabled={busy} aria-label="Цифра 0">
          0
        </button>
        <button className="key secondary" onClick={() => setPin((p) => p.slice(0, -1))}
                disabled={busy} aria-label="Стереть последнюю цифру">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6H9l-5 6 5 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z" />
            <path d="M17 10l-4 4M13 10l4 4" />
          </svg>
        </button>
      </div>

      <button className="key-enter" disabled={busy || pin.length < PIN_AUTO}
              onClick={() => void submit(pin)}>
        {busy ? "Проверяю…" : "Войти"}
      </button>

      <span className="pad-prompt" style={{ fontSize: 13, color: "var(--ink-3)" }}>
        {bound.branchName} · {bound.name}
      </span>
    </div>
  );
}

/** Привязка кассы. Экран разовый: делается при установке руководителем. */
function BindDevice({ onBound, onCancel }: {
  onBound: () => void; onCancel: (() => void) | null;
}) {
  const [phone, setPhone] = useState("+77010000001");
  const [password, setPassword] = useState("owner123");
  const [name, setName] = useState("Касса 1");
  const [адрес, setАдрес] = useState(server.base());
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchId, setBranchId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBranches = async () => {
    setBusy(true); setError(null);
    if (server.вПриложении() || адрес) server.save(адрес);
    try {
      const login = await api<{ token: string; memberships: { branchId: string | null }[] }>(
        "/v1/auth/login", { method: "POST", body: { phone, password } });
      // Токен нужен только чтобы показать список филиалов; сессию он не открывает.
      const previous = auth.token();
      auth.save(login.token, { orgId: "", orgName: "", branchId: "", branchName: "", role: "" });
      const list = await api<{ branches: { id: string; name: string }[] }>("/v1/branches");
      if (!previous) auth.clear();
      setBranches(list.branches);
      setBranchId(list.branches[0]?.id ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const bind = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ device: { id: string; token: string; name: string };
                            context: { orgName: string; branchName: string } }>(
        "/v1/auth/device", { method: "POST", body: { phone, password, branchId, name } });
      device.save({
        id: r.device.id, token: r.device.token, name: r.device.name,
        orgName: r.context.orgName, branchName: r.context.branchName,
      });
      auth.clear();
      onBound();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bind">
      <h2>Привязка кассы</h2>
      <span className="pad-prompt" style={{ textAlign: "left" }}>
        Делается один раз при установке. Нужен доступ владельца или управляющего —
        дальше сотрудники входят по PIN.
      </span>

      {(server.вПриложении() || адрес) && (
        <label>
          Адрес сервера
          <Input value={адрес} onChange={(e) => setАдрес(e.target.value)}
                 className="h-12!" placeholder="https://kassa.вашабаня.kz" />
          <span className="hint">Выдаётся при подключении заведения</span>
        </label>
      )}

      <label>
        Телефон руководителя
        <Input value={phone} onChange={(e) => setPhone(e.target.value)}
               autoComplete="username" className="h-12!" />
      </label>
      <label>
        Пароль
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
               autoComplete="current-password" className="h-12!" />
      </label>

      {branches.length === 0 ? (
        <button className="key-enter" style={{ height: 56 }} onClick={loadBranches} disabled={busy}>
          {busy ? "Проверяю…" : "Далее"}
        </button>
      ) : (
        <>
          <label>
            Филиал
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="h-12!"><SelectValue placeholder="Выберите филиал" /></SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id} className="h-11 text-base">{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label>
            Название рабочего места
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-12!" />
          </label>
          <button className="key-enter" style={{ height: 56 }} onClick={bind} disabled={busy || !branchId}>
            {busy ? "Привязываю…" : "Привязать кассу"}
          </button>
        </>
      )}

      {error && <div className="pad-error">{error}</div>}
      {onCancel && <button className="pad-link" onClick={onCancel}>Отмена</button>}
    </div>
  );
}

export function Login({ onDone }: { onDone: (ctx: Context) => void }) {
  const [bound, setBound] = useState(device.read());
  const [binding, setBinding] = useState(bound === null);
  const first = useRef(true);

  useEffect(() => { first.current = false; }, []);

  return (
    <div className="signin">
      <Aside bound={bound} onRebind={() => setBinding(true)} />
      <main className="signin-main">
        {binding || !bound ? (
          <BindDevice
            onBound={() => { setBound(device.read()); setBinding(false); }}
            onCancel={bound ? () => setBinding(false) : null} />
        ) : (
          <PinPad bound={bound} onDone={onDone}
                  onRebind={() => { device.clear(); setBound(null); setBinding(true); }} />
        )}
      </main>
    </div>
  );
}
