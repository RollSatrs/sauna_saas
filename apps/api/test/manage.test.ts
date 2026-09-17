// Управление справочниками из кабинета. Проверяем, что владелец может завести
// бизнес сам, а изменения не ломают уже проданное и не открываются кассиру.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool } from "../src/db.ts";

const app = buildServer();
let owner = "";
let cashier = "";
let branchId = "";

const call = async (method: string, url: string, body?: unknown, token = owner) => {
  const res = await app.inject({
    method: method as "GET", url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() as any };
};

before(async () => {
  await app.ready();
  owner = (await call("POST", "/v1/auth/login",
    { phone: "+77010000001", password: "owner123" }, "")).body.token;
  cashier = (await call("POST", "/v1/auth/login",
    { phone: "+77010000002", password: "cash123" }, "")).body.token;
  branchId = (await call("GET", "/v1/branches")).body.branches[0].id;
});

after(async () => {
  await app.close();
  await pool.end();
});

describe("права", () => {
  test("кассир не может менять справочники", async () => {
    const r = await call("GET", "/v1/manage/services", undefined, cashier);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /только владелец/);
  });

  test("кассир не может заводить сотрудников", async () => {
    const r = await call("POST", "/v1/manage/staff",
      { phone: "+77010009999", fullName: "Свой человек", role: "cashier", pin: "5555" }, cashier);
    assert.equal(r.status, 403);
  });
});

describe("абонементы", () => {
  let planId = "";

  test("владелец создаёт абонемент", async () => {
    const services = (await call("GET", "/v1/manage/services")).body.services;
    const сауна = services.find((s: any) => s.kind === "time_based");
    const r = await call("POST", "/v1/manage/subscription-plans", {
      name: "Утренний, 8 посещений", type: "visits", allowance: 8,
      validityDays: 60, price: 36000, serviceIds: [сауна.id], freezeDaysLimit: 7,
    });
    assert.equal(r.status, 200);
    assert.equal(Number(r.body.plan.price), 3600000, "36 000 ₸ сохранены в тиынах");
    assert.equal(Number(r.body.plan.allowance), 8);
    planId = r.body.plan.id;
  });

  test("созданный абонемент сразу можно продать на кассе", async () => {
    const plans = (await call("GET", "/v1/subscription-plans", undefined, cashier)).body.plans;
    assert.ok(plans.some((p: any) => p.id === planId), "появился в списке кассы");

    const customerId = (await call("GET", "/v1/customers", undefined, cashier)).body.customers[0].id;
    await call("POST", "/v1/shifts", { openingCash: 0 }, cashier);
    const sold = await call("POST", "/v1/subscriptions", { planId, customerId }, cashier);
    assert.equal(sold.status, 200);
    assert.equal(Number(sold.body.order.total), 3600000);
  });

  test("цена правится, но проданные абонементы не меняются", async () => {
    const было = (await call("GET", `/v1/subscriptions/${
      (await call("GET", "/v1/manage/subscription-plans")).body.plans.find((p: any) => p.id === planId).id
    }`)).status;
    await call("PATCH", `/v1/manage/subscription-plans/${planId}`, {
      name: "Утренний, 8 посещений", type: "visits", allowance: 8,
      validityDays: 60, price: 40000, serviceIds: [],
    });
    const продан = (await call("GET", "/v1/manage/subscription-plans")).body.plans
      .find((p: any) => p.id === planId);
    assert.equal(Number(продан.price), 4000000, "новая цена в плане");
    assert.equal(продан.sold, 1, "проданный экземпляр остался");
    assert.ok(было >= 200);
  });

  test("пустое название отклоняется с понятной причиной", async () => {
    const r = await call("POST", "/v1/manage/subscription-plans",
      { name: "  ", type: "visits", allowance: 5, validityDays: 30, price: 1000 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /заполните поле «название»/);
  });

  test("архивный абонемент исчезает из продажи, но остаётся в отчётах", async () => {
    await call("POST", `/v1/manage/subscription-plans/${planId}/archive`, {});
    const plans = (await call("GET", "/v1/subscription-plans", undefined, cashier)).body.plans;
    assert.ok(!plans.some((p: any) => p.id === planId), "кассир его больше не видит");
    const отчёт = await call("GET", "/v1/reports/subscriptions");
    assert.ok(отчёт.body.plans.some((p: any) => p.name.startsWith("Утренний")), "в отчёте остался");
  });
});

describe("услуги и тарифы", () => {
  let serviceId = "";

  test("услуга создаётся вместе с тарифами", async () => {
    const r = await call("POST", "/v1/manage/services", {
      name: "Хаммам", kind: "time_based", defaultDuration: 90,
      rules: [
        { days: "будни", from: "00:00", to: "18:00", price: 5000, priority: 0, minUnits: 1 },
        { days: "будни", from: "18:00", to: "24:00", price: 8000, priority: 10, minUnits: 1 },
        { days: "выходные", from: "00:00", to: "24:00", price: 10000, priority: 20, minUnits: 2 },
      ],
    });
    assert.equal(r.status, 200);
    serviceId = r.body.service.id;

    const услуги = (await call("GET", "/v1/manage/services")).body.services;
    const хаммам = услуги.find((s: any) => s.id === serviceId);
    assert.equal(хаммам.rules.length, 3, "все три тарифа сохранены");
  });

  test("новые тарифы сразу применяются к расчёту", async () => {
    const from = new Date(); from.setHours(14, 0, 0, 0);
    const to = new Date(from.getTime() + 2 * 3600000);
    const r = await call("POST", "/v1/pricing/quote", {
      serviceId, from: from.toISOString(), to: to.toISOString(),
    }, cashier);
    assert.equal(r.status, 200);
    assert.ok(r.body.quote.total > 0, "движок увидел свежие тарифы");
    assert.equal(r.body.quote.segments.length >= 1, true);
  });

  test("режим «по времени входа» считает весь визит по тарифу на момент старта", async () => {
    const created = await call("POST", "/v1/manage/services", {
      name: "Кедровая бочка", kind: "time_based", defaultDuration: 60,
      timePricingMode: "at_start",
      rules: [
        { days: "все", from: "00:00", to: "14:00", price: 5000, priority: 0, minUnits: 1 },
        { days: "все", from: "14:00", to: "24:00", price: 9000, priority: 0, minUnits: 1 },
      ],
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.service.time_pricing_mode, "at_start");

    // 13:00–15:00 по Алматы (UTC+5): визит переходит границу 14:00.
    const r = await call("POST", "/v1/pricing/quote", {
      serviceId: created.body.service.id,
      from: "2030-06-10T08:00:00.000Z", to: "2030-06-10T10:00:00.000Z",
    }, cashier);
    assert.equal(r.status, 200);
    assert.equal(r.body.quote.segments.length, 1, "по времени входа не режется на куски");
    assert.equal(Number(r.body.quote.total), 1000000, "оба часа по тарифу на момент входа — 5000 ₸/ч");
  });

  test("услуга без тарифов не сохраняется", async () => {
    const r = await call("POST", "/v1/manage/services",
      { name: "Без цены", kind: "time_based", rules: [] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /хотя бы один тариф/);
  });

  test("тариф с концом раньше начала отклоняется", async () => {
    const r = await call("POST", "/v1/manage/services", {
      name: "Кривой", kind: "time_based",
      rules: [{ days: "все", from: "20:00", to: "08:00", price: 1000 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /позже начала/);
  });

  test("услугу, назначенную помещению, нельзя убрать в архив", async () => {
    const услуги = (await call("GET", "/v1/manage/services")).body.services;
    const занятая = услуги.find((s: any) => s.name === "Аренда сауны");
    const r = await call("POST", `/v1/manage/services/${занятая.id}/archive`, {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /помещению/);
  });
});

describe("помещения", () => {
  test("новое помещение появляется в зале кассира", async () => {
    const услуги = (await call("GET", "/v1/manage/services")).body.services;
    const хаммам = услуги.find((s: any) => s.name === "Хаммам");
    const r = await call("POST", "/v1/manage/resources", {
      name: "Хаммам восточный", capacity: 6, serviceId: хаммам.id,
      bufferMinutes: 20, branchId, sortOrder: 9,
    });
    assert.equal(r.status, 200);

    const board = await call("GET", "/v1/board", undefined, cashier);
    assert.ok(board.body.resources.some((t: any) => t.name === "Хаммам восточный"));
  });

  test("вместимость нулём не принимается", async () => {
    const r = await call("POST", "/v1/manage/resources", { name: "Пустое", capacity: 0, branchId });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /вместимость/);
  });
});

describe("товары и остатки", () => {
  test("товар заводится и получает приход", async () => {
    const created = await call("POST", "/v1/manage/products",
      { name: "Квас", category: "Напитки", price: 700 });
    assert.equal(created.status, 200);
    assert.equal(Number(created.body.product.price), 70000);

    await call("POST", `/v1/manage/products/${created.body.product.id}/stock`,
      { delta: 24, branchId });
    const товары = (await call("GET", "/v1/manage/products")).body.products;
    assert.equal(Number(товары.find((p: any) => p.name === "Квас").stock), 24);
  });

  test("списание уменьшает остаток", async () => {
    const товар = (await call("GET", "/v1/manage/products")).body.products
      .find((p: any) => p.name === "Квас");
    await call("POST", `/v1/manage/products/${товар.id}/stock`,
      { delta: -4, reason: "writeoff", branchId });
    const после = (await call("GET", "/v1/manage/products")).body.products
      .find((p: any) => p.name === "Квас");
    assert.equal(Number(после.stock), 20);
  });

  test("нулевое движение отклоняется", async () => {
    const товар = (await call("GET", "/v1/manage/products")).body.products[0];
    const r = await call("POST", `/v1/manage/products/${товар.id}/stock`, { delta: 0, branchId });
    assert.equal(r.status, 400);
  });
});

describe("настройки филиала", () => {
  test("шаг тарификации меняется", async () => {
    const r = await call("PATCH", `/v1/manage/branches/${branchId}`,
      { pricingStep: 60, graceMinutes: 10 });
    assert.equal(r.status, 200);
    assert.equal(r.body.branch.settings.pricing_step_min, 60);
  });

  test("льготные минуты больше шага не принимаются", async () => {
    const r = await call("PATCH", `/v1/manage/branches/${branchId}`,
      { pricingStep: 30, graceMinutes: 45 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /меньше шага/);
  });
});

describe("сотрудники", () => {
  test("владелец заводит кассира с PIN", async () => {
    const r = await call("POST", "/v1/manage/staff", {
      phone: "+77010005555", fullName: "Новый Кассир", role: "cashier",
      pin: "4321", password: "temp12345", branchId,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.membership.role, "cashier");
  });

  test("занятый PIN в том же филиале отклоняется", async () => {
    const r = await call("POST", "/v1/manage/staff", {
      phone: "+77010006666", fullName: "Второй", role: "cashier",
      pin: "4321", password: "temp12345", branchId,
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /PIN уже занят/);
  });

  test("короткий PIN отклоняется", async () => {
    const r = await call("POST", "/v1/manage/staff", {
      phone: "+77010007777", fullName: "Третий", role: "cashier", pin: "12", branchId,
    });
    assert.equal(r.status, 400);
  });

  test("владельца изменить нельзя", async () => {
    const свои = (await call("GET", "/v1/manage/staff")).body.staff;
    const хозяин = свои.find((s: any) => s.role === "owner");
    const r = await call("PATCH", `/v1/manage/staff/${хозяин.membership_id}`, { role: "cashier" });
    assert.equal(r.status, 409);
  });
});
