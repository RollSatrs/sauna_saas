// Отчёты владельца. Главное, что здесь проверяется: цифры в кабинете сходятся
// с тем, что реально прошло через кассу, и не «протекают» между организациями.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool } from "../src/db.ts";

const app = buildServer();
let cashier = "";
let owner = "";
let stranger = "";
let saunaId = "";
let customerId = "";
let paidTotal = 0;
let cashPaid = 0;

const call = async (method: string, url: string, body?: unknown, auth = cashier) => {
  const res = await app.inject({
    method: method as "GET", url,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() as any };
};

const today = new Date().toISOString().slice(0, 10);
const range = `from=${today}&to=${today}`;

before(async () => {
  await app.ready();
  cashier = (await call("POST", "/v1/auth/login",
    { phone: "+77010000002", password: "cash123" }, "")).body.token;
  owner = (await call("POST", "/v1/auth/login",
    { phone: "+77010000001", password: "owner123" }, "")).body.token;
  stranger = (await call("POST", "/v1/auth/login",
    { phone: "+77010000009", password: "other123" }, "")).body.token;

  const catalog = await call("GET", "/v1/catalog");
  saunaId = catalog.body.resources.find((r: any) => r.name.startsWith("Сауна 1")).id;
  customerId = (await call("GET", "/v1/customers?q=Данияр")).body.customers[0].id;

  // Полный день: смена, визит с товаром, оплата пополам, продажа абонемента.
  await call("POST", "/v1/shifts", { openingCash: 1000000 });
  const visit = await call("POST", "/v1/visits",
    { resourceId: saunaId, plannedMinutes: 120, guestsCount: 3, customerId });
  const tea = catalog.body.products.find((p: any) => p.name.startsWith("Чай"));
  await call("POST", `/v1/visits/${visit.body.visit.id}/items`,
    { kind: "product", refId: tea.id, qty: 2 });
  const finished = await call("POST", `/v1/visits/${visit.body.visit.id}/finish`);
  paidTotal = Number(finished.body.order.total);
  cashPaid = Math.floor(paidTotal / 2);
  await call("POST", `/v1/orders/${finished.body.order.id}/payments`,
    { method: "cash", amount: cashPaid, idempotencyKey: "rep-cash-0001" });
  await call("POST", `/v1/orders/${finished.body.order.id}/payments`,
    { method: "card", amount: paidTotal - cashPaid, idempotencyKey: "rep-card-0001" });
});

after(async () => {
  await app.close();
  await pool.end();
});

describe("доступ к отчётам", () => {
  test("владелец видит отчёты", async () => {
    const r = await call("GET", `/v1/reports/summary?${range}`, undefined, owner);
    assert.equal(r.status, 200);
  });

  test("кассиру отчёты по выручке закрыты", async () => {
    const r = await call("GET", `/v1/reports/summary?${range}`, undefined, cashier);
    assert.equal(r.status, 403);
  });

  test("чужая организация не видит нашей выручки", async () => {
    const r = await call("GET", `/v1/reports/summary?${range}`, undefined, stranger);
    // роль кассира конкурента к отчётам не допущена; даже будь допущена — RLS вернёт свои данные
    assert.ok(r.status === 403 || Number(r.body.revenue) === 0);
  });
});

describe("сводка", () => {
  test("выручка в кабинете равна тому, что приняла касса", async () => {
    const r = await call("GET", `/v1/reports/summary?${range}`, undefined, owner);
    assert.equal(r.body.revenue, paidTotal);
    assert.equal(r.body.visits, 1);
    assert.equal(r.body.guests, 3);
    assert.equal(r.body.averageCheck, paidTotal, "один чек — средний равен ему");
  });

  test("разбивка по способам оплаты сходится с платежами", async () => {
    const r = await call("GET", `/v1/reports/summary?${range}`, undefined, owner);
    const cash = r.body.byMethod.find((m: any) => m.method === "cash");
    const card = r.body.byMethod.find((m: any) => m.method === "card");
    assert.equal(cash.total, cashPaid);
    assert.equal(card.total, paidTotal - cashPaid);
    assert.equal(cash.total + card.total, r.body.revenue);
  });

  test("динамика по дням суммируется в общую выручку", async () => {
    const r = await call("GET", `/v1/reports/summary?${range}`, undefined, owner);
    assert.equal(r.body.byDay.reduce((a: number, d: any) => a + d.revenue, 0), r.body.revenueGross);
  });
});

describe("продажи и загрузка", () => {
  test("позиции разложены по видам", async () => {
    const r = await call("GET", `/v1/reports/sales?${range}`, undefined, owner);
    const kinds = r.body.byKind.map((k: any) => k.kind);
    assert.ok(kinds.includes("service_time"), "время в парной");
    assert.ok(kinds.includes("product"), "товары");
    assert.equal(r.body.byKind.reduce((a: number, k: any) => a + k.total, 0), paidTotal);
  });

  test("загрузка считается по ресурсам", async () => {
    const r = await call("GET", `/v1/reports/occupancy?${range}`, undefined, owner);
    const sauna = r.body.byResource.find((x: any) => x.name.startsWith("Сауна 1"));
    assert.equal(sauna.visits, 1);
    assert.ok(r.body.byResource.length >= 4, "все ресурсы филиала в отчёте, даже пустые");
  });
});

describe("возврат", () => {
  test("возврат уменьшает выручку и виден в отчёте по сменам", async () => {
    const receipts = await call("GET", "/v1/shifts/current/receipts");
    const receipt = receipts.body.receipts[0];
    const cashPayment = receipt.payments.find((p: any) => p.method === "cash");

    const refunded = await call("POST", `/v1/orders/${receipt.id}/refunds`, {
      paymentId: cashPayment.id, amount: 100000,
      reason: "гость отказался от чая", idempotencyKey: "rep-refund-0001",
    });
    assert.equal(refunded.status, 200);

    const summary = await call("GET", `/v1/reports/summary?${range}`, undefined, owner);
    assert.equal(summary.body.refunds, 100000);
    assert.equal(summary.body.revenue, paidTotal - 100000, "выручка уменьшилась на возврат");

    const shifts = await call("GET", `/v1/reports/shifts?${range}`, undefined, owner);
    assert.equal(shifts.body.shifts[0].refunds, 100000);
  });

  test("вернуть больше, чем было оплачено, нельзя", async () => {
    const receipts = await call("GET", "/v1/shifts/current/receipts");
    const receipt = receipts.body.receipts[0];
    const cashPayment = receipt.payments.find((p: any) => p.method === "cash");
    const r = await call("POST", `/v1/orders/${receipt.id}/refunds`, {
      paymentId: cashPayment.id, amount: cashPaid,
      reason: "проверка границы", idempotencyKey: "rep-refund-0002",
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /превышает платёж/);
  });
});

describe("абонементы в отчёте", () => {
  test("долг перед гостями считается по остатку баланса", async () => {
    const plans = await call("GET", "/v1/subscription-plans");
    const plan = plans.body.plans.find((p: any) => p.type === "visits");
    await call("POST", "/v1/subscriptions", { planId: plan.id, customerId });

    const r = await call("GET", `/v1/reports/subscriptions?${range}`, undefined, owner);
    const row = r.body.plans.find((p: any) => p.name === plan.name);
    assert.equal(row.sold, 1);
    assert.equal(row.revenue, Number(plan.price));
    // ничего не отгуляно — долг равен полной цене
    assert.equal(row.liability, Number(plan.price));
    assert.equal(r.body.totalLiability, Number(plan.price));
  });
});

describe("Z-отчёт и кабинет", () => {
  test("сумма Z-отчётов сходится с выручкой в кабинете", async () => {
    const current = await call("GET", "/v1/shifts/current");
    const closed = await call("POST", `/v1/shifts/${current.body.shift.id}/close`,
      { countedCash: 0 });
    assert.equal(closed.status, 200);

    const shifts = await call("GET", `/v1/reports/shifts?${range}`, undefined, owner);
    const summary = await call("GET", `/v1/reports/summary?${range}`, undefined, owner);
    const fromShifts = shifts.body.shifts.reduce(
      (a: number, s: any) => a + s.revenue - s.refunds, 0);
    assert.equal(fromShifts, summary.body.revenue);
  });
});
