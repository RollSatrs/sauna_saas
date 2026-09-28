import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool } from "../src/db.ts";

const app = buildServer();
let cashierToken = "";
let ownerToken = "";
let branchId = "";
let entryId = "";
let massageId = "";
let visitId = "";
let orderId = "";

const call = async (method: string, url: string, body?: unknown, token = cashierToken) => {
  const res = await app.inject({
    method: method as "GET", url,
    headers: token ? { authorization: `Bearer ${token}`, "idempotency-key": `test-${Date.now()}-${Math.random()}` } : {},
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() as any };
};

before(async () => {
  await app.ready();
  const owner = await call("POST", "/v1/auth/login",
    { phone: "+77010000001", password: "owner123" }, "");
  ownerToken = owner.body.token;
  const cashier = await call("POST", "/v1/auth/login",
    { phone: "+77010000002", password: "cash123" }, "");
  cashierToken = cashier.body.token;
  branchId = cashier.body.context.branchId;
});

after(async () => {
  await app.close();
  await pool.end();
});

describe("общественная баня", () => {
  test("владелец включает публичный каталог и создаёт фиксированные тарифы", async () => {
    const branch = await call("PATCH", `/v1/manage/branches/${branchId}`,
      { catalogMode: "public" }, ownerToken);
    assert.equal(branch.status, 200);

    const entry = await call("POST", "/v1/manage/services", {
      name: "Сеанс 3 часа", kind: "entry",
      rules: [{ days: "все", from: "00:00", to: "24:00", price: 10000, priority: 0 }],
    }, ownerToken);
    assert.equal(entry.status, 200);
    entryId = entry.body.service.id;

    const massage = await call("POST", "/v1/manage/services", {
      name: "Массаж головы, 20 мин", kind: "extra", price: 7000,
    }, ownerToken);
    assert.equal(massage.status, 200);
    massageId = massage.body.service.id;

    const catalog = await call("GET", "/v1/catalog");
    assert.equal(catalog.body.branch.settings.catalog_mode, "public");
    assert.equal(catalog.body.services.find((s: any) => s.id === entryId).current_price, 1_000_000);
  });

  test("два активных визита без помещения не конфликтуют по уникальному индексу", async () => {
    await call("POST", "/v1/shifts", { openingCash: 0 });
    const first = await call("POST", "/v1/visits", { serviceId: entryId, guestsCount: 1 });
    const second = await call("POST", "/v1/visits", { serviceId: entryId, guestsCount: 1 });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.visit.resource_id, null);
    assert.equal(second.body.visit.resource_id, null);
    visitId = first.body.visit.id;
    orderId = first.body.orderId;
  });

  test("сеанс плюс массаж дают 17 000 ₸ и время остаётся информационным", async () => {
    const added = await call("POST", `/v1/visits/${visitId}/items`,
      { kind: "service_extra", refId: massageId, qty: 1 });
    assert.equal(added.status, 200);

    const details = await call("GET", `/v1/visits/${visitId}`);
    assert.equal(details.status, 200);
    assert.equal(details.body.timeQuote, null);
    assert.equal(details.body.dueTotal, 1_700_000);
    const entryItem = details.body.items.find((item: any) => item.kind === "service_entry");
    assert.equal(entryItem.total, 1_000_000);
    const cannotRemove = await call("DELETE", `/v1/visits/${visitId}/items/${entryItem.id}`);
    assert.equal(cannotRemove.status, 409);
    assert.match(cannotRemove.body.error, /нельзя убрать/);

    const active = await call("GET", "/v1/visits/public");
    assert.ok(active.body.visits.some((visit: any) => visit.id === visitId));

    const finished = await call("POST", `/v1/visits/${visitId}/finish`);
    assert.equal(finished.status, 200);
    assert.equal(finished.body.timeQuote, null);
    assert.equal(finished.body.order.total, 1_700_000);

    const paid = await call("POST", `/v1/orders/${orderId}/payments`, {
      method: "card", amount: 1_700_000, idempotencyKey: "public-flow-payment",
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.order.status, "paid");

    const today = new Date().toISOString().slice(0, 10);
    const report = await call(
      "GET", `/v1/reports/summary?from=${today}&to=${today}&branchId=${branchId}`,
      undefined, ownerToken);
    assert.equal(report.status, 200);
    assert.equal(report.body.revenue, 1_700_000);
  });

  test("быстрая продажа создаёт оплачиваемый заказ без визита", async () => {
    const sale = await call("POST", "/v1/orders", {
      items: [{ kind: "service_extra", refId: massageId, qty: 1 }],
    });
    assert.equal(sale.status, 200);
    assert.equal(sale.body.order.visit_id, null);
    assert.equal(sale.body.order.total, 700_000);

    const added = await call("POST", `/v1/orders/${sale.body.order.id}/items`, {
      kind: "service_extra", refId: massageId, qty: 1,
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.order.total, 1_400_000);

    const order = await call("GET", `/v1/orders/${sale.body.order.id}`);
    assert.equal(order.body.items.length, 2);
    assert.equal(order.body.items[0].name_snapshot, "Массаж головы, 20 мин");

    const paid = await call("POST", `/v1/orders/${sale.body.order.id}/payments`, {
      method: "cash", amount: 1_400_000, idempotencyKey: "direct-sale-payment",
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.order.status, "paid");
  });

  test("публичный визит нельзя открыть в private-филиале", async () => {
    await call("PATCH", `/v1/manage/branches/${branchId}`, { catalogMode: "private" }, ownerToken);
    const denied = await call("POST", "/v1/visits", { serviceId: entryId });
    assert.equal(denied.status, 409);
    assert.match(denied.body.error, /отключены/);
  });
});
