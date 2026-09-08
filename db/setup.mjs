#!/usr/bin/env node
/**
 * Заводит базу по вашему файлу my-sauna.config.mjs.
 * Стирает всё, что было: демо-данные, визиты, смены, чеки.
 * Справочники и сотрудники создаются заново.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.MIGRATION_DATABASE_URL ?? "postgres://localhost:5432/sauna_dev";
const config = (await import(join(here, "my-sauna.config.mjs"))).default;

const ДНИ = { будни: 31, выходные: 96, все: 127 };
const тг = (сумма) => Math.round(сумма * 100);   // тенге -> тиыны

if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ответ = await rl.question(
    `\nБаза будет очищена, а данные заведены заново по db/my-sauna.config.mjs.\n` +
    `Заведение: «${config.организация.название}», филиал «${config.филиал.название}».\n` +
    `Все текущие визиты, смены и чеки будут удалены. Продолжить? (да/нет) `);
  rl.close();
  if (!/^(да|y|yes)$/i.test(ответ.trim())) {
    console.log("Отменено, ничего не изменено.");
    process.exit(0);
  }
}

const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query("BEGIN");

try {
  // Чистим только прикладные данные; структура таблиц остаётся.
  await db.query(`TRUNCATE organizations, users RESTART IDENTITY CASCADE`);

  const org = (await db.query(
    "INSERT INTO organizations (name, bin) VALUES ($1,$2) RETURNING id",
    [config.организация.название, config.организация.бин || null])).rows[0].id;

  const branch = (await db.query(
    `INSERT INTO branches (org_id, name, address, timezone, settings)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [org, config.филиал.название, config.филиал.адрес || null,
     config.филиал.часовойПояс,
     JSON.stringify({
       pricing_step_min: config.филиал.шагТарификации,
       rounding: "up",
       grace_minutes: config.филиал.льготныеМинуты,
       cashier_discount_limit_percent: 10,
     })])).rows[0].id;

  const создатьСотрудника = async (человек, роль, филиал) => {
    const user = (await db.query(
      `INSERT INTO users (phone, full_name, password_hash)
       VALUES ($1,$2,crypt($3, gen_salt('bf'))) RETURNING id`,
      [человек.телефон, человек.имя, человек.пароль])).rows[0].id;
    await db.query(
      `INSERT INTO memberships (user_id, org_id, branch_id, role, pin_hash)
       VALUES ($1,$2,$3,$4,crypt($5, gen_salt('bf')))`,
      [user, org, филиал, роль, человек.pin]);
    return user;
  };

  const владелец = await создатьСотрудника(config.владелец, "owner", null);
  for (const кассир of config.кассиры) await создатьСотрудника(кассир, "cashier", branch);

  // Услуги и тарифы
  const услугиПоИмени = new Map();
  for (const у of config.услуги) {
    const почасовая = у.тип === "почасовая";
    const id = (await db.query(
      `INSERT INTO services (org_id, name, kind, unit, default_duration_min)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [org, у.название, почасовая ? "time_based" : "extra",
       почасовая ? "hour" : "piece", у.длительностьПоУмолчанию ?? null])).rows[0].id;
    услугиПоИмени.set(у.название, id);

    const тарифы = почасовая
      ? у.тарифы
      : [{ дни: "все", с: "00:00", до: "24:00", цена: у.цена, приоритет: 0, минимумЧасов: 1 }];
    for (const т of тарифы) {
      await db.query(
        `INSERT INTO price_rules (org_id, service_id, priority, dow_mask, time_from, time_to,
                                  amount, unit, min_units)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        // 24:00 — законное время в PostgreSQL. Подмена на 23:59:59 оставляла
        // последнюю минуту суток без тарифа.
        [org, id, т.приоритет ?? 0, ДНИ[т.дни] ?? 127, т.с, т.до,
         тг(т.цена), почасовая ? "hour" : "piece", т.минимумЧасов ?? 1]);
    }
  }

  // Помещения
  const типы = new Map();
  for (const п of config.помещения) {
    if (!типы.has(п.услуга)) {
      типы.set(п.услуга, (await db.query(
        "INSERT INTO resource_types (org_id, name) VALUES ($1,$2) RETURNING id",
        [org, п.услуга])).rows[0].id);
    }
    await db.query(
      `INSERT INTO resources (org_id, branch_id, type_id, name, capacity,
                              default_service_id, buffer_minutes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [org, branch, типы.get(п.услуга), п.название, п.вместимость,
       услугиПоИмени.get(п.услуга), п.уборка ?? 0, config.помещения.indexOf(п)]);
  }

  // Товары и начальный остаток
  for (const т of config.товары) {
    const id = (await db.query(
      `INSERT INTO products (org_id, name, category, price) VALUES ($1,$2,$3,$4) RETURNING id`,
      [org, т.название, т.категория ?? null, тг(т.цена)])).rows[0].id;
    if (т.остаток) {
      await db.query(
        `INSERT INTO stock_movements (org_id, branch_id, product_id, delta, reason, created_by)
         VALUES ($1,$2,$3,$4,'income',$5)`, [org, branch, id, т.остаток, владелец]);
    }
  }

  // Абонементы
  for (const а of config.абонементы ?? []) {
    const тип = { посещения: "visits", часы: "hours", безлимит: "unlimited_period" }[а.тип];
    await db.query(
      `INSERT INTO subscription_plans (org_id, name, type, allowance, validity_days, price,
                                       scope_services, max_holders, freeze_days_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [org, а.название, тип, а.количество ?? 0, а.дней, тг(а.цена),
       (а.услуги ?? []).map((н) => услугиПоИмени.get(н)).filter(Boolean),
       а.держателей ?? 1, а.заморозкаДней ?? 14]);
  }

  for (const к of config.клиенты ?? []) {
    await db.query("INSERT INTO customers (org_id, phone, full_name) VALUES ($1,$2,$3)",
      [org, к.телефон, к.имя]);
  }

  await db.query("COMMIT");

  const счёт = async (таблица) =>
    (await db.query(`SELECT count(*)::int AS n FROM ${таблица}`)).rows[0].n;

  console.log(`
Готово. Заведение «${config.организация.название}» создано.

  филиал:      ${config.филиал.название}
  помещений:   ${await счёт("resources")}
  услуг:       ${await счёт("services")}
  тарифов:     ${await счёт("price_rules")}
  товаров:     ${await счёт("products")}
  абонементов: ${await счёт("subscription_plans")}
  сотрудников: ${await счёт("users")}

Вход в кабинет:  ${config.владелец.телефон} / ${config.владелец.пароль}
Вход на кассе:   привязать тем же логином, дальше PIN ${config.кассиры[0]?.pin ?? config.владелец.pin}

Ни одной смены, брони и продажи нет — начинайте с чистого листа.
`);
} catch (error) {
  await db.query("ROLLBACK");
  console.error("\nНичего не изменено. Ошибка:\n  " + error.message + "\n");
  process.exit(1);
} finally {
  await db.end();
}
