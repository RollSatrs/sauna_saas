// Тонкий клиент API кассы. Токен держим в localStorage: смена длиннее сессии
// вкладки, а кассир перезагружает страницу чаще, чем логинится.
//
// Здесь же живёт работа без интернета: что можно отложить в очередь,
// что показать из последнего снимка, а что честно запретить. Подробности
// и границы — в offline.ts.
import {
  можноОфлайн, отправитьНакопленное, очередь, снимок, стоитКэшировать,
} from "./offline.ts";

const TOKEN_KEY = "sauna.pos.token";
const CONTEXT_KEY = "sauna.pos.context";
const DEVICE_KEY = "sauna.pos.device";
const SERVER_KEY = "sauna.pos.server";

/**
 * Адрес сервера. В браузере пусто — запросы идут на тот же адрес, откуда
 * открыта касса. В настольном приложении страница лежит внутри программы,
 * поэтому адрес сервера задаётся явно при установке.
 */
export const server = {
  base: () => localStorage.getItem(SERVER_KEY) ?? "",
  save: (url: string) => localStorage.setItem(SERVER_KEY, url.replace(/\/+$/, "")),
  clear: () => localStorage.removeItem(SERVER_KEY),
  /** Приложение Tauri: страница отдаётся не по http, а из самой программы. */
  вПриложении: () => typeof location !== "undefined" && !location.protocol.startsWith("http"),
};

export type Context = {
  orgId: string; orgName: string;
  branchId: string; branchName: string; role: string;
  /** Кто сейчас за кассой — показываем в шапке, чтобы смена не путалась. */
  userName?: string;
};

export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  context: (): Context | null => {
    const raw = localStorage.getItem(CONTEXT_KEY);
    try { return raw ? (JSON.parse(raw) as Context) : null; } catch { return null; }
  },
  save: (token: string, context: Context) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
  },
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CONTEXT_KEY);
  },
};

/** Привязка кассы к филиалу живёт дольше сессии: пароль вводится один раз. */
export type Device = {
  id: string; token: string; name: string; orgName: string; branchName: string;
};

export const device = {
  read: (): Device | null => {
    const raw = localStorage.getItem(DEVICE_KEY);
    try { return raw ? (JSON.parse(raw) as Device) : null; } catch { return null; }
  },
  save: (value: Device) => localStorage.setItem(DEVICE_KEY, JSON.stringify(value)),
  clear: () => localStorage.removeItem(DEVICE_KEY),
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Операция сохранена в очередь и уйдёт на сервер, когда вернётся связь. */
export class ОтложеноОфлайн extends Error {
  constructor(public описание: string) {
    super(`Нет связи. ${описание} сохранено — уйдёт, когда интернет вернётся.`);
  }
}

/** Операция без связи невозможна — с объяснением, почему именно. */
export class НедоступноОфлайн extends Error {}

/** Ключ идемпотентности на операцию: повтор при обрыве сети не создаст второй чек. */
export const newKey = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export async function api<T>(path: string, options: {
  method?: string; body?: unknown; idempotencyKey?: string;
} = {}): Promise<T> {
  const method = options.method ?? "GET";
  const адрес = server.base() + path;
  const изменяющий = method !== "GET";
  const key = options.idempotencyKey ?? newKey("op");

  const изКэша = async (): Promise<T | null> => {
    if (!стоитКэшировать(path)) return null;
    const кэш = await снимок.прочитать(path);
    return кэш ? ({ ...(кэш.данные as object), offline: true, snapshotAt: кэш.когда } as T) : null;
  };

  const отложить = async (): Promise<never> => {
    const проверка = можноОфлайн(method, path);
    if (!проверка.да) throw new НедоступноОфлайн(проверка.причина!);
    await очередь.добавить({
      method, path, body: options.body, key,
      описание: проверка.описание!, создана: Date.now(),
    });
    throw new ОтложеноОфлайн(проверка.описание!);
  };

  if (!navigator.onLine) {
    if (изменяющий) return отложить();
    const кэш = await изКэша();
    if (кэш) return кэш;
    throw new НедоступноОфлайн("Нет связи, а эти данные ещё не загружались.");
  }

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const token = auth.token();
  if (token) headers.authorization = `Bearer ${token}`;
  // Ключ идёт со всеми изменяющими запросами: повтор из очереди должен
  // вернуть прежний ответ, а не создать вторую запись.
  if (изменяющий) headers["idempotency-key"] = key;

  let response: Response;
  try {
    response = await fetch(адрес, {
      method, headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    // Связь оборвалась на середине запроса — для кассира это то же самое,
    // что и её отсутствие.
    if (изменяющий) return отложить();
    const кэш = await изКэша();
    if (кэш) return кэш;
    throw new НедоступноОфлайн("Сервер не отвечает.");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) auth.clear();
    throw new ApiError(response.status,
      (payload as { error?: string }).error ?? "не удалось выполнить операцию");
  }

  if (method === "GET" && стоитКэшировать(path)) await снимок.сохранить(path, payload);
  return payload as T;
}

/**
 * Разряды разделяются неразрывным пробелом, чтобы сумма не переносилась
 * посреди числа на плитке кассы. Формат задан явно, а не через toLocaleString:
 * данные локали разнятся между окружениями, а чек должен выглядеть одинаково.
 */
export const formatTenge = (tiyn: number): string => {
  const sign = tiyn < 0 ? "−" : "";
  const whole = Math.round(Math.abs(tiyn) / 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${grouped} ₸`;
};

/** Время на таймере: 1:05 — час и пять минут, −0:12 — двенадцать минут переработки. */
export const formatClock = (minutes: number): string => {
  const sign = minutes < 0 ? "−" : "";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
};

/**
 * Отправляет всё, что накопилось за время без связи. Порядок сохраняется:
 * позиция уходит раньше расчёта, расчёт — раньше оплаты.
 */
let отправкаИдёт: Promise<{ отправлено: number; осталось: number; ошибки: string[] }> | null = null;

export async function отправитьОчередь() {
  // Сигнал «связь вернулась» приходит не единожды — от браузера, от таймера,
  // от кнопки. Без этой защёлки очередь ушла бы на сервер несколько раз сразу.
  if (отправкаИдёт) return отправкаИдёт;
  отправкаИдёт = отправитьОчередьВнутри().finally(() => { отправкаИдёт = null; });
  return отправкаИдёт;
}

async function отправитьОчередьВнутри() {
  const token = auth.token();
  return отправитьНакопленное((о) =>
    fetch(server.base() + о.path, {
      method: о.method,
      headers: {
        ...(о.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "idempotency-key": о.key,
      },
      body: о.body === undefined ? undefined : JSON.stringify(о.body),
    }));
}

export { очередь, следитьЗаСвязью } from "./offline.ts";
