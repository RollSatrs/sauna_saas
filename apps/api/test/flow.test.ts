// Сквозной сценарий рабочего дня кассира через API.
// Суммы зависят от дня недели и времени запуска, поэтому проверяем не абсолютные
// числа, а то, что части системы сходятся между собой.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool, withTenant } from "../src/db.ts";

const app = buildServer();
let token = "";
let otherToken = "";
let shiftId = "";
let visitId = "";
let orderId = "";
let saunaId = "";
let orgId = "";

const call = async (method: string, url: string, body?: unknown, auth = token) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() as any };
};

before(async () => {
  await app.ready();
});

after(async () => {
  await app.close();
  await pool.end();
});

describe("вход в систему", () => {
  test("неверный пароль не пускает", async () => {
    const r = await call("POST", "/v1/auth/login", { phone: "+77010000002", password: "неверный" }, "");
    assert.equal(r.status, 401);
  });

  test("кассир входит и получает токен своего филиала", async () => {
    const r = await call("POST", "/v1/auth/login", { phone: "+77010000002", password: "cash123" }, "");
    assert.equal(r.status, 200);
    assert.equal(r.body.context.role, "cashier");
    assert.ok(r.body.token);
    token = r.body.token;
    orgId = r.body.context.orgId;
  });

  test("кассир чужой организации входит в свою", async () => {
    const r = await call("POST", "/v1/auth/login", { phone: "+77010000009", password: "other123" }, "");
    assert.equal(r.status, 200);
    otherToken = r.body.token;
  });

  test("без токена доступа нет", async () => {
    const r = await call("GET", "/v1/board", undefined, "");
    assert.equal(r.status, 401);
  });
});

describe("изоляция организаций", () => {
  test("кассир видит только ресурсы своего филиала", async () => {
    const mine = await call("GET", "/v1/catalog");
    const theirs = await call("GET", "/v1/catalog", undefined, otherToken);
    assert.equal(mine.body.resources.length, 4);
    assert.equal(theirs.body.resources.length, 0);
    saunaId = mine.body.resources.find((r: any) => r.name.startsWith("Сауна 1")).id;
  });

  test("клиенты чужой организации не видны", async () => {
    const mine = await call("GET", "/v1/customers");
    const theirs = await call("GET", "/v1/customers", undefined, otherToken);
    const names = mine.body.customers.map((c: any) => c.full_name);
    assert.ok(names.includes("Данияр Ахметов"));
    assert.ok(!names.includes("Клиент конкурента"));
    assert.deepEqual(theirs.body.customers.map((c: any) => c.full_name), ["Клиент конкурента"]);
  });
});

describe("смена", () => {
  test("без открытой смены визит открыть нельзя", async () => {
    const r = await call("POST", "/v1/visits", { resourceId: saunaId, plannedMinutes: 120 });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /смена не открыта/);
  });

  test("смена открывается с суммой в ящике", async () => {
    const r = await call("POST", "/v1/shifts", { openingCash: 5000000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.shift.status, "open");
    shiftId = r.body.shift.id;
  });

  test("вторую смену тот же кассир открыть не может", async () => {
    const r = await call("POST", "/v1/shifts", { openingCash: 0 });
    assert.equal(r.status, 409);
  });
});

describe("визит", () => {
  test("зал показывает четыре свободных ресурса", async () => {
    const r = await call("GET", "/v1/board");
    assert.equal(r.body.resources.length, 4);
    assert.ok(r.body.resources.every((t: any) => t.state === "free"));
    assert.ok(r.body.serverTime, "касса считает таймер от серверного времени");
  });

  test("визит открывается на два часа", async () => {
    const r = await call("POST", "/v1/visits", { resourceId: saunaId, plannedMinutes: 120, guestsCount: 4 });
    assert.equal(r.status, 200);
    visitId = r.body.visit.id;
    orderId = r.body.orderId;
  });

  test("на занятый ресурс второй визит не открыть", async () => {
    const r = await call("POST", "/v1/visits", { resourceId: saunaId, plannedMinutes: 60 });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /уже идёт визит/);
  });

  test("зал показывает таймер и текущую сумму", async () => {
    const r = await call("GET", "/v1/board");
    const tile = r.body.resources.find((t: any) => t.resourceId === saunaId);
    assert.equal(tile.state, "busy");
    assert.ok(tile.visit.minutesLeft > 110 && tile.visit.minutesLeft <= 120);
    assert.ok(tile.visit.timeTotal > 0, "стоимость времени считается сразу");
    assert.equal(tile.visit.dueTotal, tile.visit.timeTotal + tile.visit.extrasTotal);
  });

  test("товар и доп. услуга добавляются со снимком цены", async () => {
    const catalog = await call("GET", "/v1/catalog");
    const tea = catalog.body.products.find((p: any) => p.name.startsWith("Чай"));
    const broom = catalog.body.services.find((s: any) => s.name.startsWith("Веник"));

    const added = await call("POST", `/v1/visits/${visitId}/items`,
      { kind: "product", refId: tea.id, qty: 2 });
    assert.equal(added.status, 200);
    assert.equal(added.body.item.unit_price, Number(tea.price));
    assert.equal(added.body.item.total, Number(tea.price) * 2);
    assert.equal(added.body.item.name_snapshot, tea.name);

    const extra = await call("POST", `/v1/visits/${visitId}/items`,
      { kind: "service_extra", refId: broom.id, qty: 1 });
    assert.equal(extra.status, 200);
    assert.ok(extra.body.item.price_rule_id, "позиция помнит, по какому правилу посчитана");
  });

  test("продажа товара списывает остаток", async () => {
    const catalog = await call("GET", "/v1/catalog");
    const tea = catalog.body.products.find((p: any) => p.name.startsWith("Чай"));
    assert.equal(Number(tea.stock), 48, "было 50, продали 2");
  });

  test("продление увеличивает оплачиваемое время", async () => {
    const before = await call("GET", `/v1/visits/${visitId}`);
    const r = await call("POST", `/v1/visits/${visitId}/extend`, { minutes: 30 });
    assert.equal(r.status, 200);
    assert.equal(r.body.timeQuote.billedMinutes, before.body.timeQuote.billedMinutes + 30);
    assert.ok(r.body.timeQuote.total > before.body.timeQuote.total);
  });
});

describe("расчёт и оплата", () => {
  let dueTotal = 0;

  test("завершение визита фиксирует время и сегменты тарифа", async () => {
    const before = await call("GET", `/v1/visits/${visitId}`);
    dueTotal = before.body.dueTotal;

    const r = await call("POST", `/v1/visits/${visitId}/finish`);
    assert.equal(r.status, 200);
    assert.equal(r.body.visit.status, "finished");
    assert.equal(r.body.timeQuote.billedMinutes, 150, "2 часа плюс продление");
    assert.equal(Number(r.body.order.total), dueTotal, "итог совпадает с тем, что видел кассир");

    const order = await call("GET", `/v1/orders/${orderId}`);
    const timeItem = order.body.items.find((i: any) => i.kind === "service_time");
    assert.ok(timeItem.meta.segments.length >= 1, "сегменты тарификации сохранены в позиции");
    assert.equal(
      timeItem.meta.segments.reduce((a: number, s: any) => a + s.amount, 0),
      Number(timeItem.total));
  });

  test("ресурс освободился", async () => {
    const r = await call("GET", "/v1/board");
    const tile = r.body.resources.find((t: any) => t.resourceId === saunaId);
    assert.equal(tile.state, "free");
  });

  test("оплату больше суммы заказа не принять", async () => {
    const r = await call("POST", `/v1/orders/${orderId}/payments`,
      { method: "cash", amount: dueTotal + 100000, idempotencyKey: "test-overpay-0001" });
    assert.equal(r.status, 400);
  });

  test("смешанная оплата закрывает заказ", async () => {
    const half = Math.floor(dueTotal / 2);
    const first = await call("POST", `/v1/orders/${orderId}/payments`,
      { method: "card", amount: half, idempotencyKey: "test-pay-card-0001" });
    assert.equal(first.status, 200);
    assert.equal(first.body.order.status, "open");

    const second = await call("POST", `/v1/orders/${orderId}/payments`,
      { method: "cash", amount: dueTotal - half, idempotencyKey: "test-pay-cash-0001" });
    assert.equal(second.status, 200);
    assert.equal(second.body.order.status, "paid");
    assert.equal(Number(second.body.order.paid_total), dueTotal);
  });

  test("повтор запроса с тем же ключом не создаёт второй чек", async () => {
    const repeat = await call("POST", `/v1/orders/${orderId}/payments`,
      { method: "cash", amount: 100000, idempotencyKey: "test-pay-cash-0001" });
    assert.equal(repeat.body.repeated, true);

    const order = await call("GET", `/v1/orders/${orderId}`);
    assert.equal(order.body.payments.length, 2, "платежей ровно два, а не три");
    assert.equal(Number(order.body.order.paid_total), dueTotal);
  });

  test("вне контекста организации строка платежа вообще не видна", async () => {
    const paymentId = (await call("GET", `/v1/orders/${orderId}`)).body.payments[0].id;
    const res = await pool.query("UPDATE payments SET amount = 1 WHERE id = $1", [paymentId]);
    assert.equal(res.rowCount, 0, "RLS не отдал чужую строку даже на изменение");
  });

  test("платёж нельзя изменить даже внутри своей организации", async () => {
    const paymentId = (await call("GET", `/v1/orders/${orderId}`)).body.payments[0].id;
    await assert.rejects(
      () => withTenant(orgId, (client) =>
        client.query("UPDATE payments SET amount = 1 WHERE id = $1", [paymentId])),
      /неизменяемы/);
  });

  test("платёж нельзя удалить", async () => {
    const paymentId = (await call("GET", `/v1/orders/${orderId}`)).body.payments[0].id;
    await assert.rejects(
      () => withTenant(orgId, (client) =>
        client.query("DELETE FROM payments WHERE id = $1", [paymentId])),
      /неизменяемы/);
  });
});

describe("закрытие смены", () => {
  test("Z-отчёт сходится с фактическими деньгами", async () => {
    const order = await call("GET", `/v1/orders/${orderId}`);
    const cashPaid = order.body.payments
      .filter((p: any) => p.method === "cash")
      .reduce((a: number, p: any) => a + Number(p.amount), 0);
    const expected = 5000000 + cashPaid;

    const r = await call("POST", `/v1/shifts/${shiftId}/close`, { countedCash: expected });
    assert.equal(r.status, 200);
    const z = r.body.zReport;
    assert.equal(z.cash.expected, expected);
    assert.equal(z.cash.discrepancy, 0);
    assert.equal(z.visits, 1);
    assert.equal(z.guests, 4);
    assert.equal(z.revenueTotal, Number(order.body.order.total));
  });

  test("закрытую смену изменить нельзя", async () => {
    await assert.rejects(
      () => withTenant(orgId, (client) =>
        client.query("UPDATE shifts SET counted_cash = 0 WHERE id = $1", [shiftId])),
      /уже закрыта/);
  });

  test("недостача в кассе фиксируется, а не прячется", async () => {
    const opened = await call("POST", "/v1/shifts", { openingCash: 1000000 });
    const closed = await call("POST", `/v1/shifts/${opened.body.shift.id}/close`,
      { countedCash: 900000 });
    assert.equal(closed.body.zReport.cash.discrepancy, -100000);
  });
});
