-- Э1 · Справочники: ресурсы, услуги, правила цен, товары.

CREATE TABLE resource_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);
CREATE INDEX ON resource_types (org_id);

CREATE TABLE services (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                text NOT NULL,
  -- time_based — почасовая аренда, entry — разовый вход,
  -- per_person — за человека, extra — доп. услуга (веник, простыня, массаж)
  kind                text NOT NULL CHECK (kind IN ('time_based','entry','per_person','extra')),
  unit                text NOT NULL CHECK (unit IN ('hour','visit','person','piece')),
  default_duration_min int,
  resource_type_id    uuid REFERENCES resource_types(id),
  vat_rate            numeric(5,2) NOT NULL DEFAULT 0,
  archived_at         timestamptz,   -- справочники не удаляем: сломается история
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON services (org_id);

CREATE TABLE resources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id          uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  type_id            uuid REFERENCES resource_types(id),
  name               text NOT NULL,
  capacity           int NOT NULL DEFAULT 1,
  default_service_id uuid REFERENCES services(id),
  buffer_minutes     int NOT NULL DEFAULT 0,   -- уборка/проветривание, входит в занятость
  sort_order         int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active',
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON resources (org_id, branch_id);

-- Цена — правило, а не число. Считает их один сервис на сервере,
-- чтобы касса, бронирование и отчёты не разошлись в ответах.
CREATE TABLE price_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id  uuid REFERENCES branches(id) ON DELETE CASCADE,   -- NULL = все филиалы
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  priority   int NOT NULL DEFAULT 0,     -- побеждает наибольший среди подходящих
  dow_mask   int NOT NULL DEFAULT 127,   -- бит 0 = понедельник … бит 6 = воскресенье
  time_from  time NOT NULL DEFAULT '00:00',
  time_to    time NOT NULL DEFAULT '24:00',
  date_from  date,
  date_to    date,
  amount     bigint NOT NULL,            -- тиыны за единицу
  unit       text NOT NULL CHECK (unit IN ('hour','visit','person','piece')),
  min_units  numeric(10,2) NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (time_to > time_from)
);
CREATE INDEX ON price_rules (org_id, service_id);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sku         text,
  category    text,
  unit        text NOT NULL DEFAULT 'piece',
  price       bigint NOT NULL,           -- тиыны
  vat_rate    numeric(5,2) NOT NULL DEFAULT 0,
  track_stock boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON products (org_id);

-- Остаток — агрегат движений, а не редактируемое поле.
CREATE TABLE stock_movements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id  uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  delta      numeric(12,3) NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('sale','income','writeoff','correction','refund')),
  order_id   uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_movements (org_id, branch_id, product_id);
