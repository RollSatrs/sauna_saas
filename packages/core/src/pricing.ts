// Единственное место, где считается цена. Касса, бронирование и отчёты обязаны
// ходить сюда: иначе на вопрос «сколько должен клиент» система даст три ответа.
import type { Tiyn } from "./money.ts";
import {
  addMinutes, instantFromLocal, localParts, minutesBetween, parseClock,
} from "./time.ts";

export type Unit = "hour" | "visit" | "person" | "piece";
export type Rounding = "up" | "exact";

export type PriceRule = {
  id: string;
  priority: number;
  /** бит 0 = понедельник … бит 6 = воскресенье */
  dowMask: number;
  timeFrom: string;
  timeTo: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  amount: Tiyn;
  unit: Unit;
  minUnits: number;
};

export type BranchPricing = {
  timezone: string;
  /** шаг тарификации в минутах: 15 / 30 / 60 */
  stepMinutes: number;
  rounding: Rounding;
  /** льготные минуты: переработку меньше этого порога не считаем */
  graceMinutes: number;
};

export type Segment = {
  from: Date;
  to: Date;
  minutes: number;
  ruleId: string;
  ratePerHour: Tiyn;
  amount: Tiyn;
};

export type TimeQuote = {
  actualMinutes: number;
  billedMinutes: number;
  segments: Segment[];
  total: Tiyn;
  /** true, если сумму подняла минимальная длительность тарифа, а не факт */
  minimumApplied: boolean;
};

export class PricingError extends Error {}

function localDateKey(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function ruleMatches(rule: PriceRule, instant: Date, timezone: string): boolean {
  const p = localParts(instant, timezone);
  if ((rule.dowMask & (1 << (p.weekday - 1))) === 0) return false;
  const minutes = p.hour * 60 + p.minute;
  if (minutes < parseClock(rule.timeFrom) || minutes >= parseClock(rule.timeTo)) return false;
  const day = localDateKey(p);
  if (rule.dateFrom && day < rule.dateFrom) return false;
  if (rule.dateTo && day > rule.dateTo) return false;
  return true;
}

/** Побеждает правило с наибольшим приоритетом среди подходящих на этот момент. */
function ruleAt(rules: readonly PriceRule[], instant: Date, timezone: string): PriceRule | null {
  let best: PriceRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, instant, timezone)) continue;
    if (!best || rule.priority > best.priority) best = rule;
  }
  return best;
}

/**
 * Ближайшая граница тарифа после указанного момента: край любого правила
 * или местная полночь. Дальше этой точки цена измениться не может.
 */
function nextBoundary(rules: readonly PriceRule[], instant: Date, timezone: string): Date {
  const p = localParts(instant, timezone);
  const clocks = new Set<number>([24 * 60]);
  for (const rule of rules) {
    clocks.add(parseClock(rule.timeFrom));
    clocks.add(parseClock(rule.timeTo));
  }
  let nearest: Date | null = null;
  for (const minutes of clocks) {
    const candidate = instantFromLocal(
      timezone, p.year, p.month, p.day,
      Math.floor(minutes / 60), minutes % 60,
    );
    if (candidate.getTime() > instant.getTime() && (!nearest || candidate < nearest)) {
      nearest = candidate;
    }
  }
  // Подстраховка: если границ нет, шагаем на сутки вперёд, чтобы не зациклиться.
  return nearest ?? addMinutes(instant, 24 * 60);
}

/**
 * Округление фактического времени до шага тарификации.
 * Льготные минуты не дают выставить лишние полчаса за пятиминутное опоздание —
 * иначе каждый кассир будет решать это по-своему.
 */
export function billedMinutesFor(actualMinutes: number, branch: BranchPricing): number {
  if (actualMinutes <= 0) return 0;
  if (branch.rounding === "exact") return actualMinutes;
  const step = branch.stepMinutes;
  const steps = Math.floor(actualMinutes / step);
  const remainder = actualMinutes - steps * step;
  if (remainder === 0) return actualMinutes;
  if (remainder <= branch.graceMinutes) return Math.max(steps * step, step);
  return (steps + 1) * step;
}

/**
 * Почасовая услуга. Интервал режется по границам тарифов и считается посегментно:
 * гость, вошедший в 17:40, платит 20 минут по дневному тарифу и остаток по вечернему.
 */
export function quoteTime(input: {
  rules: readonly PriceRule[];
  branch: BranchPricing;
  from: Date;
  to: Date;
}): TimeQuote {
  const { rules, branch, from, to } = input;
  const hourly = rules.filter((r) => r.unit === "hour");
  if (hourly.length === 0) throw new PricingError("для услуги не задано ни одного почасового тарифа");

  const actualMinutes = minutesBetween(from, to);
  if (actualMinutes < 0) throw new PricingError("конец интервала раньше начала");

  const opening = ruleAt(hourly, from, branch.timezone);
  if (!opening) throw new PricingError("на момент начала визита не действует ни один тариф");

  const rounded = billedMinutesFor(actualMinutes, branch);
  const minimum = Math.round(opening.minUnits * 60);
  const billedMinutes = Math.max(rounded, minimum);
  const minimumApplied = billedMinutes > rounded;

  const segments: Segment[] = [];
  const billedEnd = addMinutes(from, billedMinutes);
  let cursor = from;

  while (cursor.getTime() < billedEnd.getTime()) {
    const rule = ruleAt(hourly, cursor, branch.timezone);
    if (!rule) throw new PricingError(`тариф не задан на ${cursor.toISOString()}`);
    const boundary = nextBoundary(hourly, cursor, branch.timezone);
    const segmentEnd = boundary < billedEnd ? boundary : billedEnd;
    const minutes = minutesBetween(cursor, segmentEnd);
    if (minutes <= 0) throw new PricingError("тарификация не продвигается: проверьте границы правил");
    segments.push({
      from: cursor,
      to: segmentEnd,
      minutes,
      ruleId: rule.id,
      ratePerHour: rule.amount,
      amount: Math.round((minutes * rule.amount) / 60),
    });
    cursor = segmentEnd;
  }

  return {
    actualMinutes,
    billedMinutes,
    segments,
    total: segments.reduce((acc, s) => acc + s.amount, 0),
    minimumApplied,
  };
}

/** Штучные услуги и товары: веник, простыня, массаж, чай. */
export function quotePiece(input: {
  rules: readonly PriceRule[];
  at: Date;
  timezone: string;
  qty: number;
}): { unitPrice: Tiyn; total: Tiyn; ruleId: string } {
  const pieces = input.rules.filter((r) => r.unit === "piece" || r.unit === "visit");
  const rule = ruleAt(pieces, input.at, input.timezone);
  if (!rule) throw new PricingError("для услуги не задан действующий тариф");
  return { unitPrice: rule.amount, total: rule.amount * input.qty, ruleId: rule.id };
}

/**
 * Делит уже посчитанный интервал на часть, закрытую абонементом, и остаток к оплате.
 * Идём по сегментам от начала визита: абонемент закрывает первые минуты,
 * остальное гость доплачивает по тарифу. Считаем по сегментам, а не долей от
 * итога, — иначе на границе тарифов возникнет расхождение в копейках.
 */
export function splitByCoveredMinutes(quote: TimeQuote, coveredMinutes: number): {
  coveredMinutes: number;
  coveredAmount: Tiyn;
  remainderMinutes: number;
  remainderAmount: Tiyn;
} {
  const covered = Math.max(0, Math.min(Math.round(coveredMinutes), quote.billedMinutes));
  let left = covered;
  let coveredAmount = 0;

  for (const segment of quote.segments) {
    if (left <= 0) break;
    const take = Math.min(left, segment.minutes);
    coveredAmount += take === segment.minutes
      ? segment.amount
      : Math.round((take * segment.ratePerHour) / 60);
    left -= take;
  }

  return {
    coveredMinutes: covered,
    coveredAmount,
    remainderMinutes: quote.billedMinutes - covered,
    remainderAmount: quote.total - coveredAmount,
  };
}
