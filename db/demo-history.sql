-- Месяц демо-истории: без неё кабинет владельца показывает одну точку,
-- и ни график, ни тепловая карта загрузки ничего не говорят.
-- Ставки повторяют прайс из seed.sql, поэтому отчёты выглядят достоверно.
DO $$
DECLARE
  v_org uuid; v_branch uuid; v_cashier uuid; v_tz text;
  v_service uuid; v_shift uuid; v_order uuid; v_visit uuid;
  v_resource record; v_customer uuid;
  d date; slot_hour int; guests int; minutes int; rate bigint; amount bigint;
  local_dow int; visits_today int; i int;
  cash_total bigint; method text;
BEGIN
  SELECT id INTO v_org FROM organizations WHERE name = 'Баня на Абая';
  IF v_org IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM shifts WHERE org_id = v_org AND status = 'closed') THEN
    RAISE NOTICE 'история уже сгенерирована';
    RETURN;
  END IF;

  SELECT id, timezone INTO v_branch, v_tz FROM branches WHERE org_id = v_org LIMIT 1;
  SELECT id INTO v_cashier FROM users WHERE phone = '+77010000002';
  SELECT id INTO v_service FROM services WHERE org_id = v_org AND name = 'Аренда сауны';

  FOR d IN SELECT generate_series(CURRENT_DATE - 29, CURRENT_DATE - 1, '1 day')::date LOOP
    local_dow := EXTRACT(ISODOW FROM d);
    -- в выходные людей заметно больше: тепловая карта должна это показывать
    visits_today := CASE WHEN local_dow >= 6 THEN 8 + floor(random() * 5)::int
                                             ELSE 3 + floor(random() * 4)::int END;
    cash_total := 0;

    INSERT INTO shifts (org_id, branch_id, opened_by, opened_at, opening_cash, status)
      VALUES (v_org, v_branch, v_cashier, (d + time '09:00') AT TIME ZONE v_tz, 5000000, 'open')
      RETURNING id INTO v_shift;

    FOR i IN 1..visits_today LOOP
      SELECT * INTO v_resource FROM resources
        WHERE branch_id = v_branch AND archived_at IS NULL
        ORDER BY random() LIMIT 1;
      SELECT id INTO v_customer FROM customers
        WHERE org_id = v_org ORDER BY random() LIMIT 1;

      slot_hour := 11 + floor(random() * 11)::int;      -- с 11 до 21
      minutes := (ARRAY[60, 120, 120, 180])[1 + floor(random() * 4)::int];
      guests := 2 + floor(random() * 5)::int;

      rate := CASE
        WHEN local_dow >= 6 THEN 1200000
        WHEN slot_hour >= 18 THEN 900000
        ELSE 600000 END;
      amount := (rate * minutes) / 60;

      INSERT INTO orders (org_id, branch_id, shift_id, customer_id, status, created_by, created_at)
        VALUES (v_org, v_branch, v_shift, v_customer, 'paid', v_cashier,
                (d + make_interval(hours => slot_hour)) AT TIME ZONE v_tz)
        RETURNING id INTO v_order;

      INSERT INTO visits (org_id, branch_id, resource_id, customer_id, service_id, shift_id,
                          order_id, started_at, planned_minutes, ended_at, guests_count,
                          status, created_by)
        VALUES (v_org, v_branch, v_resource.id, v_customer, v_service, v_shift, v_order,
                (d + make_interval(hours => slot_hour)) AT TIME ZONE v_tz, minutes,
                (d + make_interval(hours => slot_hour, mins => minutes)) AT TIME ZONE v_tz,
                guests, 'finished', v_cashier)
        RETURNING id INTO v_visit;

      INSERT INTO order_items (org_id, order_id, kind, ref_id, name_snapshot, qty, unit,
                               unit_price, total, created_by, created_at)
        VALUES (v_org, v_order, 'service_time', v_service,
                'Аренда сауны · ' || round(minutes / 60.0, 1) || ' ч',
                round(minutes / 60.0, 2), 'hour', rate, amount, v_cashier,
                (d + make_interval(hours => slot_hour, mins => minutes)) AT TIME ZONE v_tz);

      -- примерно у половины визитов есть товары
      IF random() < 0.55 THEN
        INSERT INTO order_items (org_id, order_id, kind, ref_id, name_snapshot, qty, unit,
                                 unit_price, total, created_by, created_at)
          SELECT v_org, v_order, 'product', p.id, p.name, 2, p.unit, p.price, p.price * 2, v_cashier,
                 (d + make_interval(hours => slot_hour, mins => minutes)) AT TIME ZONE v_tz
          FROM products p WHERE p.org_id = v_org ORDER BY random() LIMIT 1;
        amount := amount + (SELECT COALESCE(SUM(total), 0) FROM order_items
                            WHERE order_id = v_order AND kind = 'product');
      END IF;

      method := CASE WHEN random() < 0.45 THEN 'cash' ELSE 'card' END;
      IF method = 'cash' THEN cash_total := cash_total + amount; END IF;

      INSERT INTO payments (org_id, order_id, shift_id, method, amount, idempotency_key,
                            created_by, created_at)
        VALUES (v_org, v_order, v_shift, method, amount,
                'demo-' || v_order::text, v_cashier,
                (d + make_interval(hours => slot_hour, mins => minutes)) AT TIME ZONE v_tz);

      UPDATE orders SET subtotal = amount, total = amount, paid_total = amount WHERE id = v_order;
    END LOOP;

    -- смена закрывается сошедшейся: расхождения — редкое событие, не норма
    UPDATE shifts SET
      status = 'closed', closed_by = v_cashier,
      closed_at = (d + time '23:30') AT TIME ZONE v_tz,
      expected_cash = 5000000 + cash_total,
      counted_cash = 5000000 + cash_total,
      discrepancy = 0,
      z_report = jsonb_build_object('demo', true, 'visits', visits_today)
    WHERE id = v_shift;
  END LOOP;

  RAISE NOTICE 'демо-история за 29 дней создана';
END
$$;
