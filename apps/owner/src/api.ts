// Тонкий клиент API. Токен держим в localStorage: смена длиннее сессии вкладки,
// а кассир перезагружает страницу чаще, чем логинится.
const TOKEN_KEY = "sauna.owner.token";
const CONTEXT_KEY = "sauna.owner.context";

export type Context = {
  orgId: string; orgName: string;
  branchId: string; branchName: string; role: string;
};

export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  context: (): Context | null => {
    const raw = localStorage.getItem(CONTEXT_KEY);
    return raw ? (JSON.parse(raw) as Context) : null;
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

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: {
  method?: string; body?: unknown; idempotencyKey?: string;
} = {}): Promise<T> {
  // Заголовок content-type ставим только когда тело действительно есть:
  // пустое тело с объявленным JSON сервер справедливо считает ошибкой.
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const token = auth.token();
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) auth.clear();
    throw new ApiError(response.status, payload.error ?? "не удалось выполнить операцию");
  }
  return payload as T;
}

/** Ключ идемпотентности на операцию: повтор при обрыве сети не создаст второй чек. */
export const newKey = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const formatTenge = (tiyn: number): string => {
  const whole = Math.round(Math.abs(tiyn) / 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${tiyn < 0 ? "−" : ""}${grouped} ₸`;
};

/** Короткая форма для крупных чисел на плитках: 1 240 000 ₸ -> 1,24 млн ₸ */
export const formatCompact = (tiyn: number): string => {
  const tenge = Math.round(tiyn / 100);
  if (Math.abs(tenge) >= 1_000_000) return `${(tenge / 1_000_000).toFixed(2).replace(".", ",")} млн ₸`;
  if (Math.abs(tenge) >= 10_000) return `${(tenge / 1000).toFixed(0)} тыс ₸`;
  return formatTenge(tiyn);
};

export const formatDay = (iso: string): string =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
