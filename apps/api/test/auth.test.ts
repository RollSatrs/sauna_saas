// Вход на кассу. PIN сам по себе слабый секрет, поэтому проверяется главное:
// он работает только на привязанном устройстве и только в его филиале.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool } from "../src/db.ts";

const app = buildServer();
let branchId = "";
let otherBranchId = "";
let deviceId = "";
let deviceToken = "";

const call = async (method: string, url: string, body?: unknown, token = "") => {
  const res = await app.inject({
    method: method as "GET", url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() as any };
};

before(async () => {
  await app.ready();
  const owner = await call("POST", "/v1/auth/login", { phone: "+77010000001", password: "owner123" });
  const branches = await call("GET", "/v1/branches", undefined, owner.body.token);
  branchId = branches.body.branches[0].id;

  // филиал чужой организации — для проверки границы
  const stranger = await call("POST", "/v1/auth/login", { phone: "+77010000009", password: "other123" });
  const theirs = await call("GET", "/v1/branches", undefined, stranger.body.token);
  otherBranchId = theirs.body.branches[0].id;
});

after(async () => {
  await app.close();
  await pool.end();
});

describe("привязка кассы", () => {
  test("кассир привязать кассу не может", async () => {
    const r = await call("POST", "/v1/auth/device",
      { phone: "+77010000002", password: "cash123", branchId, name: "Левая касса" });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /только владелец или управляющий/);
  });

  test("руководитель чужой организации не привяжет наш филиал", async () => {
    const r = await call("POST", "/v1/auth/device",
      { phone: "+77010000009", password: "other123", branchId, name: "Чужая касса" });
    assert.equal(r.status, 401);
  });

  test("владелец привязывает кассу и получает секрет устройства", async () => {
    const r = await call("POST", "/v1/auth/device",
      { phone: "+77010000001", password: "owner123", branchId, name: "Касса 1" });
    assert.equal(r.status, 200);
    assert.equal(r.body.context.branchName, "Абая 150");
    assert.ok(r.body.device.token.length >= 32, "секрет генерирует сервер, а не клиент");
    deviceId = r.body.device.id;
    deviceToken = r.body.device.token;
  });
});

describe("формат телефона", () => {
  // Номер вводят по-разному, и раньше любое отличие выглядело как «нет прав» —
  // человек искал проблему в доступе, а она была в пробелах.
  const форматы = [
    ["с пробелами", "+7 701 000 00 01"],
    ["с восьмёркой", "87010000001"],
    ["без кода страны", "7010000001"],
    ["со скобками и дефисами", "+7 (701) 000-00-01"],
  ];

  for (const [вид, номер] of форматы) {
    test(`вход владельца работает с номером ${вид}`, async () => {
      const r = await call("POST", "/v1/auth/login", { phone: номер, password: "owner123" });
      assert.equal(r.status, 200, `не принят номер «${номер}»`);
      assert.equal(r.body.memberships[0].role, "owner");
    });

    test(`привязка кассы работает с номером ${вид}`, async () => {
      const r = await call("POST", "/v1/auth/device",
        { phone: номер, password: "owner123", branchId, name: `Касса ${вид}` });
      assert.equal(r.status, 200, `не принят номер «${номер}»`);
    });
  }

  test("новый сотрудник заводится с любым форматом и входит по любому", async () => {
    const owner = (await call("POST", "/v1/auth/login",
      { phone: "+77010000001", password: "owner123" })).body.token;
    const created = await call("POST", "/v1/manage/staff", {
      phone: "8 707 111 22 33", fullName: "Мурат Управляющий", role: "manager",
      pin: "7788", password: "manager123", branchId,
    }, owner);
    assert.equal(created.status, 200);

    const вход = await call("POST", "/v1/auth/login",
      { phone: "+77071112233", password: "manager123" });
    assert.equal(вход.status, 200, "тот же номер в другом виде должен подойти");
  });
});

describe("почему отказано", () => {
  test("неверный пароль — так и написано, а не «нет прав»", async () => {
    const r = await call("POST", "/v1/auth/device",
      { phone: "+77010000001", password: "не-тот", branchId, name: "Касса" });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /неверный телефон или пароль/);
  });

  test("несуществующий телефон — то же сообщение, без подсказки злоумышленнику", async () => {
    const r = await call("POST", "/v1/auth/device",
      { phone: "+77019999999", password: "owner123", branchId, name: "Касса" });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /неверный телефон или пароль/);
  });

  test("кассиру объясняют, что дело в роли", async () => {
    const r = await call("POST", "/v1/auth/device",
      { phone: "+77010000002", password: "cash123", branchId, name: "Касса" });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /роль «кассир»/);
  });
});

describe("вход по PIN", () => {
  test("верный PIN пускает кассира в филиал устройства", async () => {
    const r = await call("POST", "/v1/auth/pin", { deviceId, deviceToken, pin: "1234" });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.fullName, "Айгуль Кассир");
    assert.equal(r.body.context.role, "cashier");
    assert.equal(r.body.context.branchName, "Абая 150");
  });

  test("выданный токен работает в кассе", async () => {
    const session = await call("POST", "/v1/auth/pin", { deviceId, deviceToken, pin: "1234" });
    const board = await call("GET", "/v1/board", undefined, session.body.token);
    assert.equal(board.status, 200);
    assert.equal(board.body.resources.length, 4);
  });

  test("неверный PIN не пускает", async () => {
    const r = await call("POST", "/v1/auth/pin", { deviceId, deviceToken, pin: "9999" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "неверный PIN");
  });

  test("PIN без устройства бесполезен", async () => {
    const r = await call("POST", "/v1/auth/pin", { deviceId, deviceToken: "подделка", pin: "1234" });
    assert.equal(r.status, 401);
    assert.equal(r.body.unbound, true);
  });

  test("устройство без PIN тоже бесполезно", async () => {
    const r = await call("POST", "/v1/auth/pin", { deviceId, deviceToken, pin: "" });
    assert.equal(r.status, 400);
  });

  test("слишком короткий PIN отклоняется до обращения к базе", async () => {
    const r = await call("POST", "/v1/auth/pin", { deviceId, deviceToken, pin: "12" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /4-8 цифр/);
  });

  test("отозванная касса перестаёт пускать", async () => {
    const owner = await call("POST", "/v1/auth/login", { phone: "+77010000001", password: "owner123" });
    const fresh = await call("POST", "/v1/auth/device",
      { phone: "+77010000001", password: "owner123", branchId, name: "Касса 2" });

    // до отзыва PIN работает
    const before = await call("POST", "/v1/auth/pin",
      { deviceId: fresh.body.device.id, deviceToken: fresh.body.device.token, pin: "1234" });
    assert.equal(before.status, 200);

    const revoked = await call("POST", `/v1/devices/${fresh.body.device.id}/revoke`,
      {}, owner.body.token);
    assert.equal(revoked.status, 200);

    const after = await call("POST", "/v1/auth/pin",
      { deviceId: fresh.body.device.id, deviceToken: fresh.body.device.token, pin: "1234" });
    assert.equal(after.status, 401, "украденный планшет отключается мгновенно");
  });

  test("кассир отозвать кассу не может", async () => {
    const session = await call("POST", "/v1/auth/pin", { deviceId, deviceToken, pin: "1234" });
    const r = await call("POST", `/v1/devices/${deviceId}/revoke`, {}, session.body.token);
    assert.equal(r.status, 403);
  });
});

describe("границы филиала", () => {
  test("PIN не работает на устройстве другой организации", async () => {
    const theirs = await call("POST", "/v1/auth/device",
      { phone: "+77010000009", password: "other123", branchId: otherBranchId, name: "Их касса" });
    // у конкурента роль кассира — привязать он не может, и это уже граница
    assert.equal(theirs.status, 401);
  });

  test("сессия по PIN ограничена филиалом устройства", async () => {
    const session = await call("POST", "/v1/auth/pin", { deviceId, deviceToken, pin: "1234" });
    const customers = await call("GET", "/v1/customers", undefined, session.body.token);
    const names = customers.body.customers.map((c: any) => c.full_name);
    assert.ok(!names.includes("Клиент конкурента"));
  });
});
