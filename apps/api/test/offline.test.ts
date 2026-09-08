// Офлайн-очередь кассы доотправляет накопленное при возврате связи.
// Повтор случается штатно: ответ мог потеряться, а операция — пройти.
// Здесь проверяем, что повтор не создаёт дублей ни в одной операции.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool } from "../src/db.ts";

const app = buildServer();
let token = "";
let saunaId = "";

const call = async (method: string, url: string, body?: unknown, key?: string) => {
  const res = await app.inject({
    method: method as "GET", url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(key ? { "idempotency-key": key } : {}),
    },
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() as any };
};

before(async () => {
  await app.ready();
  token = (await (async () => {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login",
      payload: { phone: "+77010000002", password: "cash123" } });
    return r.json() as any;
  })()).token;
  saunaId = (await call("GET", "/v1/catalog")).body.resources
    .find((r: any) => r.name.startsWith("Сауна 1")).id;
  await call("POST", "/v1/shifts", { openingCash: 0 });
});

after(async () => {
  await app.close();
  await pool.end();
});

describe("повтор операций из очереди", () => {
  let visitId = "";
  let orderId = "";

  test("повторное открытие визита не создаёт второй визит", async () => {
    const key = "offline-visit-000001";
    const первый = await call("POST", "/v1/visits",
      { resourceId: saunaId, plannedMinutes: 120, guestsCount: 2 }, key);
    assert.equal(первый.status, 200);
    visitId = первый.body.visit.id;
    orderId = первый.body.orderId;

    const повтор = await call("POST", "/v1/visits",
      { resourceId: saunaId, plannedMinutes: 120, guestsCount: 2 }, key);
    assert.equal(повтор.status, 200);
    assert.equal(повтор.body.visit.id, visitId, "вернулся тот же визит");
    assert.equal(повтор.body.repeated, true);

    const board = await call("GET", "/v1/board");
    const занятых = board.body.resources.filter((t: any) => t.visit).length;
    assert.equal(занятых, 1, "занято одно помещение, а не два");
  });

  test("повторное добавление товара не задваивает позицию", async () => {
    const чай = (await call("GET", "/v1/catalog")).body.products
      .find((p: any) => p.name.startsWith("Чай"));
    const key = "offline-item-000001";

    await call("POST", `/v1/visits/${visitId}/items`,
      { kind: "product", refId: чай.id, qty: 2 }, key);
    const повтор = await call("POST", `/v1/visits/${visitId}/items`,
      { kind: "product", refId: чай.id, qty: 2 }, key);
    assert.equal(повтор.body.repeated, true);

    const order = await call("GET", `/v1/orders/${orderId}`);
    const позиции = order.body.items.filter((i: any) => i.kind === "product");
    assert.equal(позиции.length, 1, "позиция одна");

    const остаток = (await call("GET", "/v1/catalog")).body.products
      .find((p: any) => p.name.startsWith("Чай")).stock;
    assert.equal(Number(остаток), 48, "со склада списано 2, а не 4");
  });

  test("повторное продление не добавляет лишнего времени", async () => {
    const key = "offline-extend-00001";
    const первый = await call("POST", `/v1/visits/${visitId}/extend`, { minutes: 30 }, key);
    const повтор = await call("POST", `/v1/visits/${visitId}/extend`, { minutes: 30 }, key);
    assert.equal(повтор.body.repeated, true);
    assert.equal(повтор.body.timeQuote.billedMinutes, первый.body.timeQuote.billedMinutes);

    const детали = await call("GET", `/v1/visits/${visitId}`);
    assert.equal(детали.body.extensions.length, 1, "продление одно");
    assert.equal(детали.body.timeQuote.billedMinutes, 150, "2 часа плюс 30 минут");
  });

  test("повторное завершение визита возвращает прежний расчёт", async () => {
    const key = "offline-finish-00001";
    const первый = await call("POST", `/v1/visits/${visitId}/finish`, {}, key);
    assert.equal(первый.status, 200);
    const повтор = await call("POST", `/v1/visits/${visitId}/finish`, {}, key);
    assert.equal(повтор.status, 200, "повтор не падает, хотя визит уже закрыт");
    assert.equal(повтор.body.repeated, true);
    assert.equal(Number(повтор.body.order.total), Number(первый.body.order.total));

    const order = await call("GET", `/v1/orders/${orderId}`);
    const время = order.body.items.filter((i: any) => i.kind === "service_time");
    assert.equal(время.length, 1, "позиция за время одна");
  });

  test("повторная оплата не берёт деньги дважды", async () => {
    const order = await call("GET", `/v1/orders/${orderId}`);
    const сумма = Number(order.body.order.total);
    const key = "offline-pay-0000001";

    await call("POST", `/v1/orders/${orderId}/payments`,
      { method: "cash", amount: сумма, idempotencyKey: key });
    const повтор = await call("POST", `/v1/orders/${orderId}/payments`,
      { method: "cash", amount: сумма, idempotencyKey: key });
    assert.equal(повтор.body.repeated, true);

    const после = await call("GET", `/v1/orders/${orderId}`);
    assert.equal(после.body.payments.length, 1);
    assert.equal(Number(после.body.order.paid_total), сумма);
  });

  test("два одновременных запроса с одним ключом выполняются один раз", async () => {
    // Так бывает в жизни: связь вернулась, и сигнал об этом пришёл дважды —
    // от браузера и от таймера. Обе отправки стартуют одновременно.
    const визит = await call("POST", "/v1/visits",
      { resourceId: (await call("GET", "/v1/catalog")).body.resources
          .find((r: any) => r.name.startsWith("Сауна 2")).id,
        plannedMinutes: 60 }, "race-visit-0000001");
    const id = визит.body.visit.id;
    const key = "race-extend-000001";

    const [a, b] = await Promise.all([
      call("POST", `/v1/visits/${id}/extend`, { minutes: 30 }, key),
      call("POST", `/v1/visits/${id}/extend`, { minutes: 30 }, key),
    ]);
    assert.ok(a.status === 200 && b.status === 200, "оба запроса завершились без ошибки");

    const детали = await call("GET", `/v1/visits/${id}`);
    assert.equal(детали.body.extensions.length, 1, "продление записано один раз");
    assert.equal(
      детали.body.extensions.reduce((a: number, e: any) => a + e.minutes, 0), 30,
      "добавлено ровно полчаса");
    // Оплаченные минуты здесь не проверяем: в выходные действует тариф
    // с минимумом в два часа, и итог зависит от дня недели, а не от повтора.
  });

  test("без ключа повтор проходит как обычная новая операция", async () => {
    // Так и должно быть: ключ — осознанное решение кассы, а не магия сервера.
    const r1 = await call("POST", "/v1/visits", { resourceId: saunaId, plannedMinutes: 60 });
    assert.equal(r1.status, 200);
    const r2 = await call("POST", "/v1/visits", { resourceId: saunaId, plannedMinutes: 60 });
    assert.equal(r2.status, 409, "второй визит на занятый ресурс отклонён по-старому");
  });
});
