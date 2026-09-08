// Время хранится в UTC, а тарифы живут по местному времени филиала.
// Temporal в Node ещё нет, поэтому пояс разбираем через Intl.

export type LocalParts = {
  year: number; month: number; day: number;
  hour: number; minute: number;
  /** 1 = понедельник … 7 = воскресенье */
  weekday: number;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    formatters.set(timezone, fmt);
  }
  return fmt;
}

export function localParts(instant: Date, timezone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timezone).formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday) + 1,
  };
}

/** Смещение пояса в минутах для конкретного момента (учитывает переводы часов). */
function offsetMinutes(instant: Date, timezone: string): number {
  const p = localParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return (asUtc - Math.floor(instant.getTime() / 60000) * 60000) / 60000;
}

/**
 * Момент времени по местным «настенным» часам филиала.
 * Смещение подбирается в два прохода: первый даёт приближение,
 * второй ловит случай, когда точка попала на перевод часов.
 */
export function instantFromLocal(
  timezone: string, year: number, month: number, day: number, hour = 0, minute = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = new Date(naive - offsetMinutes(new Date(naive), timezone) * 60000);
  const corrected = new Date(naive - offsetMinutes(guess, timezone) * 60000);
  if (corrected.getTime() !== guess.getTime()) guess = corrected;
  return guess;
}

/** "18:30" или "24:00" -> минуты от начала местных суток. */
export function parseClock(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60000);
}
