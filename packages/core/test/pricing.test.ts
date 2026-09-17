// Тарификация — место, где система теряет деньги тише всего.
// Сценарии повторяют прайс демо-бани: будни день/вечер и выходные с минимумом.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { billedMinutesFor, quoteTime, quotePiece, splitByCoveredMinutes, PricingError } from "../src/pricing.ts";
import type { BranchPricing, PriceRule } from "../src/pricing.ts";
import { instantFromLocal, localParts } from "../src/time.ts";
import { formatTenge, tenge } from "../src/money.ts";

const TZ = "Asia/Almaty";
const branch: BranchPricing = { timezone: TZ, stepMinutes: 30, rounding: "up", graceMinutes: 5 };

const WEEKDAYS = 0b0011111;  // пн-пт
const WEEKEND = 0b1100000;   // сб-вс

const rules: PriceRule[] = [
  { id: "day",     priority: 0,  dowMask: WEEKDAYS, timeFrom: "00:00", timeTo: "24:00", amount: tenge(6000),  unit: "hour", minUnits: 1 },
  { id: "evening", priority: 10, dowMask: WEEKDAYS, timeFrom: "18:00", timeTo: "24:00", amount: tenge(9000),  unit: "hour", minUnits: 1 },
  { id: "weekend", priority: 20, dowMask: WEEKEND,  timeFrom: "00:00", timeTo: "24:00", amount: tenge(12000), unit: "hour", minUnits: 2 },
];

/** 2026-09-09 — среда, 2026-09-11 — пятница, 2026-09-12 — суббота. */
const at = (day: number, hour: number, minute = 0) =>
  instantFromLocal(TZ, 2026, 9, day, hour, minute);

describe("часовой пояс филиала", () => {
  test("местное время разбирается по поясу, а не по часам сервера", () => {
    const p = localParts(at(9, 14), TZ);
    assert.deepEqual([p.year, p.month, p.day, p.hour, p.weekday], [2026, 9, 9, 14, 3]);
  });

  test("полночь по Алматы — это 19:00 UTC предыдущего дня", () => {
    assert.equal(at(12, 0).toISOString(), "2026-09-11T19:00:00.000Z");
  });
});

describe("округление до шага тарификации", () => {
  test("ровное время не округляется", () => {
    assert.equal(billedMinutesFor(120, branch), 120);
  });

  test("переработка в пределах льготных минут не оплачивается", () => {
    assert.equal(billedMinutesFor(123, branch), 120);
  });

  test("переработка сверх льготных минут поднимает до следующего шага", () => {
    assert.equal(billedMinutesFor(130, branch), 150);
  });

  test("режим «по факту» не округляет вовсе", () => {
    assert.equal(billedMinutesFor(133, { ...branch, rounding: "exact" }), 133);
  });

  test("меньше шага всё равно оплачивается как один шаг", () => {
    assert.equal(billedMinutesFor(4, branch), 30);
  });
});

describe("почасовая тарификация", () => {
  test("будни, дневной тариф: два часа по 6000", () => {
    const q = quoteTime({ rules, branch, from: at(9, 14), to: at(9, 16) });
    assert.equal(q.segments.length, 1);
    assert.equal(q.billedMinutes, 120);
    assert.equal(q.total, tenge(12000));
    assert.equal(formatTenge(q.total), "12\u00A0000\u00A0₸");
  });

  test("переход через 18:00 считается посегментно, а не по времени входа", () => {
    const q = quoteTime({ rules, branch, from: at(9, 17, 40), to: at(9, 19, 40) });
    assert.equal(q.segments.length, 2);
    assert.deepEqual(q.segments.map((s) => [s.ruleId, s.minutes]), [["day", 20], ["evening", 100]]);
    // 20 мин × 6000/ч = 2000 ₸, 100 мин × 9000/ч = 15 000 ₸
    assert.equal(q.total, tenge(17000));
  });

  test("тариф по времени входа дал бы другую сумму — разница и есть цена ошибки", () => {
    const q = quoteTime({ rules, branch, from: at(9, 17, 40), to: at(9, 19, 40) });
    const naive = tenge(6000) * 2; // как если бы считали весь визит по дневному
    assert.equal(q.total - naive, tenge(5000));
  });

  test("режим «по времени входа»: пересечение 18:00 не режется, весь визит по дневному", () => {
    const q = quoteTime({ rules, branch, from: at(9, 17, 40), to: at(9, 19, 40), mode: "at_start" });
    assert.equal(q.segments.length, 1);
    assert.equal(q.segments[0].ruleId, "day");
    assert.equal(q.billedMinutes, 120);
    assert.equal(q.total, tenge(12000)); // 2 часа по дневному тарифу целиком
  });

  test("режим «по времени входа»: минимум и округление действуют как обычно", () => {
    const q = quoteTime({ rules, branch, from: at(12, 12), to: at(12, 13), mode: "at_start" });
    assert.equal(q.actualMinutes, 60);
    assert.equal(q.billedMinutes, 120); // минимум выходного тарифа — 2 часа
    assert.equal(q.minimumApplied, true);
    assert.equal(q.total, tenge(24000));
  });

  test("без указания режима считаем как раньше — посегментно", () => {
    const segmented = quoteTime({ rules, branch, from: at(9, 17, 40), to: at(9, 19, 40) });
    const entry = quoteTime({ rules, branch, from: at(9, 17, 40), to: at(9, 19, 40), mode: "segments" });
    assert.deepEqual(segmented, entry);
  });

  test("выходной: минимальная длительность тарифа поднимает сумму", () => {
    const q = quoteTime({ rules, branch, from: at(12, 12), to: at(12, 13) });
    assert.equal(q.actualMinutes, 60);
    assert.equal(q.billedMinutes, 120);
    assert.equal(q.minimumApplied, true);
    assert.equal(q.total, tenge(24000));
  });

  test("визит через полночь меняет тариф на границе суток", () => {
    const q = quoteTime({ rules, branch, from: at(11, 23), to: at(12, 1) });
    assert.deepEqual(q.segments.map((s) => [s.ruleId, s.minutes]), [["evening", 60], ["weekend", 60]]);
    assert.equal(q.total, tenge(9000) + tenge(12000));
  });

  test("минимум берётся у тарифа на момент входа, а не у самого дорогого", () => {
    // вход в пятницу вечером (минимум 1 ч), выход в субботу (там минимум 2 ч)
    const q = quoteTime({ rules, branch, from: at(11, 23), to: at(12, 1) });
    assert.equal(q.billedMinutes, 120);
    assert.equal(q.minimumApplied, false);
  });

  test("округление применяется до нарезки на сегменты", () => {
    const q = quoteTime({ rules, branch, from: at(9, 17, 40), to: at(9, 19, 50) });
    assert.equal(q.billedMinutes, 150); // 130 мин -> 2,5 часа
    assert.equal(q.segments.at(-1)?.to.getTime(), at(9, 20, 10).getTime());
  });

  test("сумма сегментов всегда равна итогу", () => {
    const q = quoteTime({ rules, branch, from: at(11, 16, 15), to: at(12, 2, 45) });
    assert.equal(q.segments.reduce((a, s) => a + s.amount, 0), q.total);
  });

  test("деньги остаются целыми тиынами при любой длительности", () => {
    for (const minutes of [7, 13, 41, 97, 181]) {
      const q = quoteTime({ rules, branch, from: at(9, 10), to: at(9, 10, minutes) });
      assert.equal(Number.isInteger(q.total), true, `дробь при ${minutes} мин`);
    }
  });

  test("без действующего тарифа считать отказываемся, а не показываем ноль", () => {
    assert.throws(
      () => quoteTime({ rules: [], branch, from: at(9, 14), to: at(9, 16) }),
      PricingError,
    );
  });

  test("конец раньше начала — ошибка, а не отрицательный чек", () => {
    assert.throws(() => quoteTime({ rules, branch, from: at(9, 16), to: at(9, 14) }), PricingError);
  });
});

describe("штучные позиции", () => {
  const extras: PriceRule[] = [
    { id: "broom", priority: 0, dowMask: 127, timeFrom: "00:00", timeTo: "24:00", amount: tenge(1500), unit: "piece", minUnits: 1 },
  ];

  test("веники считаются по количеству", () => {
    const q = quotePiece({ rules: extras, at: at(9, 14), timezone: TZ, qty: 3 });
    assert.equal(q.total, tenge(4500));
  });
});

describe("покрытие абонементом", () => {
  const twoHoursAcrossTariffs = () =>
    quoteTime({ rules, branch, from: at(9, 17, 40), to: at(9, 19, 40) });

  test("абонемент закрывает весь визит", () => {
    const q = twoHoursAcrossTariffs();
    const split = splitByCoveredMinutes(q, q.billedMinutes);
    assert.equal(split.coveredAmount, q.total);
    assert.equal(split.remainderAmount, 0);
  });

  test("частичное покрытие считается по сегментам, а не долей от итога", () => {
    const q = twoHoursAcrossTariffs();          // 20 мин по 6000 + 100 мин по 9000
    const split = splitByCoveredMinutes(q, 60); // абонемент закрывает первый час
    // 20 мин дневного (2000 ₸) + 40 мин вечернего (6000 ₸) = 8000 ₸
    assert.equal(split.coveredAmount, tenge(8000));
    assert.equal(split.remainderAmount, tenge(9000));
    // доля от итога дала бы 8500 ₸ — расхождение в пользу заведения или гостя
    assert.notEqual(split.coveredAmount, Math.round(q.total / 2));
  });

  test("сумма покрытия и остатка всегда равна итогу", () => {
    const q = twoHoursAcrossTariffs();
    for (const minutes of [0, 1, 19, 20, 21, 60, 119, 120, 500]) {
      const s = splitByCoveredMinutes(q, minutes);
      assert.equal(s.coveredAmount + s.remainderAmount, q.total, `при ${minutes} мин`);
    }
  });

  test("покрытие больше визита не создаёт отрицательный остаток", () => {
    const q = twoHoursAcrossTariffs();
    const split = splitByCoveredMinutes(q, 10000);
    assert.equal(split.remainderMinutes, 0);
    assert.equal(split.remainderAmount, 0);
  });
});

describe("край суток", () => {
  const круглосуточно: PriceRule[] = [
    { id: "day", priority: 0, dowMask: 127, timeFrom: "00:00", timeTo: "24:00",
      amount: tenge(5000), unit: "hour", minUnits: 1 },
  ];

  test("визит, заканчивающийся в последнюю минуту суток, считается", () => {
    const q = quoteTime({ rules: круглосуточно, branch,
      from: at(9, 22, 30), to: at(9, 23, 59) });
    assert.ok(q.total > 0);
    assert.equal(q.segments.length, 1, "сутки не разрываются лишний раз");
  });

  test("тариф действует и в 23:59, и в 00:00 следующих суток", () => {
    const через = quoteTime({ rules: круглосуточно, branch,
      from: at(9, 23, 30), to: at(10, 0, 30) });
    assert.equal(через.billedMinutes, 60);
    assert.equal(через.total, tenge(5000));
  });
});
