-- Демо-данные: одна баня с двумя саунами, купелью и комнатой отдыха.
-- Второй арендатор нужен, чтобы тестом доказать изоляцию данных.
DO $$
DECLARE
  v_org uuid; v_branch uuid; v_owner uuid; v_cashier uuid;
  t_sauna uuid; t_pool uuid; t_room uuid;
  s_sauna uuid; s_pool uuid; s_room uuid; s_broom uuid; s_towel uuid; s_massage uuid;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid;
  v_org2 uuid; v_user2 uuid; v_branch2 uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM organizations WHERE name = 'Баня на Абая') THEN
    RAISE NOTICE 'сид уже применён, пропускаю';
    RETURN;
  END IF;

  INSERT INTO organizations (name, bin) VALUES ('Баня на Абая', '123456789012') RETURNING id INTO v_org;
  INSERT INTO branches (org_id, name, address) VALUES (v_org, 'Абая 150', 'Алматы, пр. Абая 150')
    RETURNING id INTO v_branch;

  INSERT INTO users (phone, full_name, password_hash)
    VALUES ('+77010000001', 'Ерлан Владелец', crypt('owner123', gen_salt('bf')))
    RETURNING id INTO v_owner;
  INSERT INTO users (phone, full_name, password_hash)
    VALUES ('+77010000002', 'Айгуль Кассир', crypt('cash123', gen_salt('bf')))
    RETURNING id INTO v_cashier;

  -- PIN для входа на кассе: 1111 у владельца, 1234 у кассира
  INSERT INTO memberships (user_id, org_id, branch_id, role, pin_hash)
    VALUES (v_owner, v_org, NULL, 'owner', crypt('1111', gen_salt('bf'))),
           (v_cashier, v_org, v_branch, 'cashier', crypt('1234', gen_salt('bf')));

  INSERT INTO resource_types (org_id, name, sort_order) VALUES (v_org, 'Сауна', 1) RETURNING id INTO t_sauna;
  INSERT INTO resource_types (org_id, name, sort_order) VALUES (v_org, 'Купель', 2) RETURNING id INTO t_pool;
  INSERT INTO resource_types (org_id, name, sort_order) VALUES (v_org, 'Комната отдыха', 3) RETURNING id INTO t_room;

  INSERT INTO services (org_id, name, kind, unit, default_duration_min, resource_type_id)
    VALUES (v_org, 'Аренда сауны', 'time_based', 'hour', 120, t_sauna) RETURNING id INTO s_sauna;
  INSERT INTO services (org_id, name, kind, unit, default_duration_min, resource_type_id)
    VALUES (v_org, 'Купель', 'time_based', 'hour', 60, t_pool) RETURNING id INTO s_pool;
  INSERT INTO services (org_id, name, kind, unit, default_duration_min, resource_type_id)
    VALUES (v_org, 'Комната отдыха', 'time_based', 'hour', 120, t_room) RETURNING id INTO s_room;
  INSERT INTO services (org_id, name, kind, unit) VALUES (v_org, 'Веник дубовый', 'extra', 'piece') RETURNING id INTO s_broom;
  INSERT INTO services (org_id, name, kind, unit) VALUES (v_org, 'Простыня', 'extra', 'piece') RETURNING id INTO s_towel;
  INSERT INTO services (org_id, name, kind, unit) VALUES (v_org, 'Массаж 30 мин', 'extra', 'piece') RETURNING id INTO s_massage;

  INSERT INTO resources (org_id, branch_id, type_id, name, capacity, default_service_id, buffer_minutes, sort_order)
    VALUES (v_org, v_branch, t_sauna, 'Сауна 1 «Финская»', 8, s_sauna, 15, 1) RETURNING id INTO r1;
  INSERT INTO resources (org_id, branch_id, type_id, name, capacity, default_service_id, buffer_minutes, sort_order)
    VALUES (v_org, v_branch, t_sauna, 'Сауна 2 «Русская»', 6, s_sauna, 15, 2) RETURNING id INTO r2;
  INSERT INTO resources (org_id, branch_id, type_id, name, capacity, default_service_id, buffer_minutes, sort_order)
    VALUES (v_org, v_branch, t_pool, 'Купель', 4, s_pool, 10, 3) RETURNING id INTO r3;
  INSERT INTO resources (org_id, branch_id, type_id, name, capacity, default_service_id, buffer_minutes, sort_order)
    VALUES (v_org, v_branch, t_room, 'Комната отдыха', 10, s_room, 20, 4) RETURNING id INTO r4;

  -- Тарифы: будни день 6000 ₸/ч, будни вечер с 18:00 — 9000 ₸/ч, выходные — 12000 ₸/ч.
  -- Приоритет выше у более узкого правила: вечер побеждает дневное, выходной — оба.
  INSERT INTO price_rules (org_id, service_id, priority, dow_mask, time_from, time_to, amount, unit, min_units)
    VALUES
      (v_org, s_sauna, 0,  31, '00:00', '24:00',  600000, 'hour', 1),   -- пн-пт база
      (v_org, s_sauna, 10, 31, '18:00', '24:00',  900000, 'hour', 1),   -- пн-пт вечер
      (v_org, s_sauna, 20, 96, '00:00', '24:00', 1200000, 'hour', 2),   -- сб-вс, минимум 2 часа
      (v_org, s_pool,  0, 127, '00:00', '24:00',  300000, 'hour', 1),
      (v_org, s_room,  0, 127, '00:00', '24:00',  400000, 'hour', 1),
      (v_org, s_broom, 0, 127, '00:00', '24:00',  150000, 'piece', 1),
      (v_org, s_towel, 0, 127, '00:00', '24:00',   50000, 'piece', 1),
      (v_org, s_massage,0,127, '00:00', '24:00',  700000, 'piece', 1);

  INSERT INTO products (org_id, name, category, price, track_stock) VALUES
    (v_org, 'Чай травяной',      'Напитки', 80000,  true),
    (v_org, 'Вода 0,5',          'Напитки', 30000,  true),
    (v_org, 'Лимонад домашний',  'Напитки', 120000, true),
    (v_org, 'Орешки',            'Закуски', 90000,  true),
    (v_org, 'Шапка банная',      'Товары',  250000, true);

  INSERT INTO stock_movements (org_id, branch_id, product_id, delta, reason, created_by)
    SELECT v_org, v_branch, id, 50, 'income', v_owner FROM products WHERE org_id = v_org;

  INSERT INTO customers (org_id, phone, full_name) VALUES
    (v_org, '+77771234567', 'Данияр Ахметов'),
    (v_org, '+77779876543', 'Мария Ким');

  -- Абонементы: три типовых для бани.
  INSERT INTO subscription_plans (org_id, name, type, allowance, validity_days, price,
                                  scope_services, max_holders, freeze_days_limit)
    VALUES
      (v_org, 'Абонемент 10 посещений', 'visits', 10, 90, 5000000, ARRAY[s_sauna], 1, 14),
      (v_org, 'Абонемент 20 часов',      'hours', 20, 60, 9000000, ARRAY[s_sauna], 1, 14),
      (v_org, 'Семейный безлимит, месяц','unlimited_period', 0, 30, 15000000, ARRAY[s_sauna], 4, 7);

  -- Вторая организация: нужна, чтобы проверять изоляцию, а не верить в неё.
  INSERT INTO organizations (name) VALUES ('Сауна Конкурент') RETURNING id INTO v_org2;
  INSERT INTO branches (org_id, name) VALUES (v_org2, 'Розыбакиева 10') RETURNING id INTO v_branch2;
  INSERT INTO users (phone, full_name, password_hash)
    VALUES ('+77010000009', 'Чужой Кассир', crypt('other123', gen_salt('bf'))) RETURNING id INTO v_user2;
  INSERT INTO memberships (user_id, org_id, branch_id, role) VALUES (v_user2, v_org2, v_branch2, 'cashier');
  INSERT INTO customers (org_id, phone, full_name) VALUES (v_org2, '+77000000000', 'Клиент конкурента');

  RAISE NOTICE 'сид готов: организация %, филиал %', v_org, v_branch;
END
$$;
