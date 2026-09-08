-- Э2–Э3 · Операционный контур: клиенты, смены, брони, визиты, заказы, деньги.

CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  full_name  text,
  birthday   date,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone)
);

-- Смена — обязательный контекст любой кассовой операции.
-- Нет открытой смены — касса работает только на просмотр.
CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  opened_by     uuid NOT NULL REFERENCES users(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opening_cash  bigint NOT NULL DEFAULT 0,
  closed_by     uuid REFERENCES users(id),
  closed_at     timestamptz,
  counted_cash  bigint,
  expected_cash bigint,
  discrepancy   bigint,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  z_report      jsonb            -- неизменяемый снимок итогов на момент закрытия
);
CREATE INDEX ON shifts (org_id, branch_id, status);

CREATE TABLE cash_movements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_id   uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('cash_in','cash_out','collection')),
  amount     bigint NOT NULL CHECK (amount > 0),
  comment    text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cash_movements (shift_id);

-- Непересечение броней гарантирует СУБД, а не приложение: проверка «свободно?»
-- в коде не закрывает гонку двух кассиров, нажавших одновременно.
CREATE TABLE bookings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id      uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  resource_id    uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  customer_id    uuid REFERENCES customers(id),
  service_id     uuid REFERENCES services(id),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  buffer_minutes int NOT NULL DEFAULT 0,   -- копия с ресурса на момент создания
  -- занимаемый интервал = бронь + буфер уборки; заполняется триггером ниже
  -- (генерируемой колонкой нельзя: сложение timestamptz с интервалом не immutable)
  occupied       tstzrange NOT NULL DEFAULT tstzrange(now(), now(), '[)'),
  guests_count   int NOT NULL DEFAULT 1,
  status         text NOT NULL DEFAULT 'booked'
                 CHECK (status IN ('booked','arrived','cancelled','no_show')),
  source         text NOT NULL DEFAULT 'cashier',
  comment        text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    resource_id WITH =, occupied WITH &&
  ) WHERE (status IN ('booked','arrived'))
);
CREATE INDEX ON bookings (org_id, branch_id, starts_at);

CREATE OR REPLACE FUNCTION bookings_set_occupied() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.occupied := tstzrange(
    NEW.starts_at,
    NEW.ends_at + make_interval(mins => NEW.buffer_minutes),
    '[)');
  RETURN NEW;
END
$$;

CREATE TRIGGER bookings_occupied BEFORE INSERT OR UPDATE OF starts_at, ends_at, buffer_minutes
  ON bookings FOR EACH ROW EXECUTE FUNCTION bookings_set_occupied();

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id      uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  shift_id       uuid NOT NULL REFERENCES shifts(id),
  visit_id       uuid,
  customer_id    uuid REFERENCES customers(id),
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','paid','partially_refunded','refunded','void')),
  subtotal       bigint NOT NULL DEFAULT 0,
  discount_total bigint NOT NULL DEFAULT 0,
  total          bigint NOT NULL DEFAULT 0,
  paid_total     bigint NOT NULL DEFAULT 0,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON orders (org_id, shift_id);

-- Визит: старт, план по времени, продления, финал. Таймер не тикает в базе —
-- остаток вычисляется от серверного now(), поэтому перезагрузка кассы его не теряет.
CREATE TABLE visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  resource_id     uuid NOT NULL REFERENCES resources(id),
  booking_id      uuid REFERENCES bookings(id),
  customer_id     uuid REFERENCES customers(id),
  service_id      uuid NOT NULL REFERENCES services(id),
  shift_id        uuid NOT NULL REFERENCES shifts(id),
  order_id        uuid REFERENCES orders(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  planned_minutes int NOT NULL,
  ended_at        timestamptz,
  guests_count    int NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','finished','cancelled')),
  created_by      uuid NOT NULL REFERENCES users(id)
);
-- Один ресурс — один активный визит. Гарантия на уровне СУБД, а не проверки в коде.
CREATE UNIQUE INDEX visits_one_active_per_resource
  ON visits (resource_id) WHERE status = 'active';
CREATE INDEX ON visits (org_id, branch_id, status);

ALTER TABLE orders ADD CONSTRAINT orders_visit_fk
  FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE SET NULL;

CREATE TABLE visit_extensions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  visit_id   uuid NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  minutes    int NOT NULL CHECK (minutes > 0),
  reason     text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON visit_extensions (visit_id);

-- Каждая позиция хранит снимок цены. Иначе поднятие прайса задним числом
-- перепишет всю прошлую выручку в отчётах.
CREATE TABLE order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('service_time','service_extra','product')),
  ref_id        uuid,
  name_snapshot text NOT NULL,
  qty           numeric(10,2) NOT NULL DEFAULT 1,
  unit          text NOT NULL,
  unit_price    bigint NOT NULL,
  price_rule_id uuid,
  discount      bigint NOT NULL DEFAULT 0,
  total         bigint NOT NULL,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- сегменты тарификации и т.п.
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_items (order_id);

-- Платежи неизменяемы: возврат — отдельная обратная операция со ссылкой на оригинал.
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL REFERENCES orders(id),
  shift_id        uuid NOT NULL REFERENCES shifts(id),
  method          text NOT NULL CHECK (method IN ('cash','card','transfer','subscription')),
  amount          bigint NOT NULL CHECK (amount > 0),
  external_ref    text,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'completed',
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX ON payments (order_id);
CREATE INDEX ON payments (shift_id);

CREATE TABLE refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  original_payment_id uuid NOT NULL REFERENCES payments(id),
  order_id            uuid NOT NULL REFERENCES orders(id),
  shift_id            uuid NOT NULL REFERENCES shifts(id),
  amount              bigint NOT NULL CHECK (amount > 0),
  reason              text NOT NULL,
  idempotency_key     text NOT NULL,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX ON refunds (order_id);

-- Финансовые события append-only: без этого расследование недостачи невозможно,
-- а «поправить задним числом» становится штатной практикой персонала.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% запрещено для %: финансовые записи неизменяемы, оформляйте возврат или сторно',
    TG_OP, TG_TABLE_NAME;
END
$$;

CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Закрытую смену править нельзя: иначе подписанный кассиром Z-отчёт «поплывёт».
CREATE OR REPLACE FUNCTION forbid_closed_shift_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'смена % уже закрыта и не может быть изменена', OLD.id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shifts_no_edit_after_close BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION forbid_closed_shift_change();
