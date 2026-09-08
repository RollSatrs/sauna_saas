// Деньги — целые тиыны. Ни float, ни Number с дробями: иначе Z-отчёт
// не сойдётся с денежным ящиком на копейки, и объяснить это будет нечем.
export type Tiyn = number;

export const TIYN_IN_TENGE = 100;

export function tenge(amount: number): Tiyn {
  return Math.round(amount * TIYN_IN_TENGE);
}

/**
 * Разряды разделяются неразрывным пробелом, чтобы сумма не переносилась
 * посреди числа на плитке кассы. Формат задан явно, а не через toLocaleString:
 * данные локали разнятся между окружениями, а чек должен выглядеть одинаково.
 */
export function formatTenge(value: Tiyn): string {
  const sign = value < 0 ? "−" : "";
  const whole = Math.round(Math.abs(value) / TIYN_IN_TENGE);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0");
  return `${sign}${grouped}\u00A0₸`;
}

/** Доля от суммы с округлением до тиына — единственное место, где появляется дробь. */
export function share(amount: Tiyn, numerator: number, denominator: number): Tiyn {
  if (denominator === 0) return 0;
  return Math.round((amount * numerator) / denominator);
}

export function sum(values: readonly Tiyn[]): Tiyn {
  return values.reduce((a, b) => a + b, 0);
}
