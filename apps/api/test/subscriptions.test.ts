// Абонементы: продажа, списание, заморозка, границы применимости.
// Проверяем леджер, а не кэш баланса: расхождение между ними — тихая потеря денег.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool, withTenant } from "../src/db.ts";

const app = buildServer();
let token = "";
let managerToken = "";
let orgId = "";
let customerId = "";
let saunaId = "";
let visitsPlanId = "";
let hoursPlanId = "";

const call = async (method: string, url: string, body?: unknown, auth = token) => {
  const res = await app.inject({
    method: method as "GET", url,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() as any };
};

before(async () => {
  await app.ready();
  const cashier = await call("POST", "/v1/auth/login",
    { phone: "+77010000002", password: "cash123" }, "");
  token = cashier.body.token;
  orgId = cashier.body.context.orgId;
  const owner = await call("POST", "/v1/auth/login",
    { phone: "+77010000001", password: "owner123" }, "");
  managerToken = owner.body.token;

  const catalog = await call("GET", "/v1/catalog");
  saunaId = catalog.body.resources.find((r: any) => r.name.startsWith("Сауна 1")).id;
  const customers = await call("GET", "/v1/customers?q=Данияр");
  customerId = customers.body.customers[0].id;
  const plans = await call("GET", "/v1/subscription-plans");
  visitsPlanId = plans.body.plans.find((p: any) => p.type === "visits").id;
  hoursPlanId = plans.body.plans.find((p: any) => p.type === "hours").id;
  await call("POST", "/v1/shifts", { openingCash: 0 });
});

after(async () => {
  await app.close();
  await pool.end();
});

describe("продажа абонемента", () => {
  test("абонемент продаётся через смену и попадает в заказ", async () => {
    const r = await call("POST", "/v1/subscriptions", { planId: visitsPlanId, customerId });
    assert.equal(r.status, 200);
    assert.equal(Number(r.body.subscription.balance_cache), 10);
    assert.equal(Number(r.body.order.total), 5000000);

    const order = await call("GET", `/v1/orders/${r.body.order.id}`);
    assert.equal(order.body.items[0].kind, "subscription");
    assert.equal(order.body.items[0].name_snapshot, "Абонемент 10 посещений");
  });

  test("в персональный абонемент нельзя вписать лишних держателей", async () => {
    const r = await call("POST", "/v1/subscriptions",
      { planId: visitsPlanId, customerId, holderIds: [customerId, customerId] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /не больше 1 человек/);
  });
});

describe("списание за визит", () => {
  let visitId = "";
  let subscriptionId = "";

  test("система сама предлагает подходящий абонемент", async () => {
    const sold = await call("POST", "/v1/subscriptions", { planId: hoursPlanId, customerId });
    subscriptionId = sold.body.subscription.id;

    const visit = await call("POST", "/v1/visits",
      { resourceId: saunaId, plannedMinutes: 120, guestsCount: 2, customerId });
    visitId = visit.body.visit.id;

    const details = await call("GET", `/v1/visits/${visitId}`);
    const offered = details.body.subscriptions.map((s: any) => s.planName);
    assert.ok(offered.includes("Абонемент 20 часов"), "часовой абонемент предложен");
    assert.ok(offered.includes("Абонемент 10 посещений"), "абонемент на посещения предложен");
  });

  test("часовой абонемент закрывает время, деньгами платится только остаток", async () => {
    const before = await call("GET", `/v1/visits/${visitId}`);
    const r = await call("POST", `/v1/visits/${visitId}/finish`, { subscriptionId });
    assert.equal(r.status, 200);
    assert.equal(r.body.covered.coveredMinutes, 120, "два часа закрыты абонементом");
    assert.equal(Number(r.body.order.total), before.body.items.reduce(
      (a: number, i: any) => a + Number(i.total), 0), "к оплате остались только доп. позиции");
    assert.equal(Number(r.body.subscription.balance_cache), 18, "20 часов минус два");
  });

  test("баланс из леджера совпадает с кэшем", async () => {
    const [ledger, cache] = await withTenant(orgId, async (client) => [
      Number((await client.query("SELECT subscription_balance($1) AS b", [subscriptionId])).rows[0].b),
      Number((await client.query("SELECT balance_cache FROM subscriptions WHERE id = $1",
        [subscriptionId])).rows[0].balance_cache),
    ]);
    assert.equal(ledger, cache);
    assert.equal(ledger, 18);
  });

  test("позиция помнит, что закрыта абонементом", async () => {
    const details = await call("GET", `/v1/subscriptions/${subscriptionId}`);
    const charge = details.body.history.find((h: any) => h.type === "charge");
    assert.equal(Number(charge.amount), -2, "списано два часа");
    assert.ok(Number(charge.covered_money) > 0, "видно, сколько денег закрыл абонемент");
  });

  test("запись о списании нельзя изменить", async () => {
    await assert.rejects(
      () => withTenant(orgId, (client) =>
        client.query("UPDATE subscription_entries SET amount = 0 WHERE subscription_id = $1",
          [subscriptionId])),
      /неизменяемы/);
  });
});

describe("границы применимости", () => {
  test("исчерпанный абонемент больше не предлагается и не списывается", async () => {
    const sold = await call("POST", "/v1/subscriptions", { planId: hoursPlanId, customerId });
    const id = sold.body.subscription.id;
    // Обнуляем баланс корректировкой от владельца — так же, как это делает жизнь.
    const zeroed = await call("POST", `/v1/subscriptions/${id}/adjust`,
      { amount: -20, comment: "тест: обнуление" }, managerToken);
    assert.equal(zeroed.status, 200);
    assert.equal(zeroed.body.subscription.status, "used_up");

    const visit = await call("POST", "/v1/visits",
      { resourceId: saunaId, plannedMinutes: 60, customerId });
    const details = await call("GET", `/v1/visits/${visit.body.visit.id}`);
    assert.ok(!details.body.subscriptions.some((s: any) => s.id === id),
      "исчерпанный абонемент не предлагается");

    const finish = await call("POST", `/v1/visits/${visit.body.visit.id}/finish`,
      { subscriptionId: id });
    assert.equal(finish.status, 409, "списать с исчерпанного нельзя");
    await call("POST", `/v1/visits/${visit.body.visit.id}/finish`);
  });

  test("корректировать баланс кассиру нельзя", async () => {
    const sold = await call("POST", "/v1/subscriptions", { planId: visitsPlanId, customerId });
    const r = await call("POST", `/v1/subscriptions/${sold.body.subscription.id}/adjust`,
      { amount: 5, comment: "себе" });
    assert.equal(r.status, 403);
  });
});

describe("заморозка", () => {
  test("заморозка сдвигает срок, а не переписывает его", async () => {
    const sold = await call("POST", "/v1/subscriptions", { planId: visitsPlanId, customerId });
    const id = sold.body.subscription.id;
    const base = sold.body.subscription.valid_to_base;

    const frozen = await call("POST", `/v1/subscriptions/${id}/freeze`, { reason: "отпуск" });
    assert.equal(frozen.status, 200);
    assert.equal(frozen.body.subscription.status, "frozen");
    assert.equal(String(frozen.body.subscription.valid_to).slice(0, 10),
      String(base).slice(0, 10), "в день заморозки срок ещё не сдвинулся");

    const details = await call("GET", `/v1/subscriptions/${id}`);
    assert.equal(details.body.freezes.length, 1, "интервал заморозки сохранён в истории");
    assert.equal(details.body.freezes[0].ends_on, null, "заморозка ещё открыта");

    const back = await call("POST", `/v1/subscriptions/${id}/unfreeze`);
    assert.equal(back.body.subscription.status, "active");
  });

  test("повторная заморозка без разморозки отклоняется", async () => {
    const sold = await call("POST", "/v1/subscriptions", { planId: visitsPlanId, customerId });
    const id = sold.body.subscription.id;
    await call("POST", `/v1/subscriptions/${id}/freeze`, {});
    const again = await call("POST", `/v1/subscriptions/${id}/freeze`, {});
    assert.equal(again.status, 409);
  });
});
