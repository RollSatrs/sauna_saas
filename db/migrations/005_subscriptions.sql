-- Э4 · Абонементы. Баланс — не поле «осталось 5», а свёртка леджера:
-- иначе двойное списание при гонке и невозможность объяснить гостю, куда делись посещения.

CREATE TABLE subscription_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text NOT NULL,
  -- visits — по числу посещений, hours — по часам, unlimited_period — безлимит на срок
  type               text NOT NULL CHECK (type IN ('visits','hours','unlimited_period')),
  allowance          numeric(10,2) NOT NULL DEFAULT 0,   -- посещений или часов
  validity_days      int NOT NULL DEFAULT 30,
  price              bigint NOT NULL,
  -- область действия: пусто = без ограничения
  scope_services     uuid[] NOT NULL DEFAULT '{}',
  scope_branches     uuid[] NOT NULL DEFAULT '{}',
  dow_mask           int NOT NULL DEFAULT 127,
  time_from          time NOT NULL DEFAULT '00:00',
  time_to            time NOT NULL DEFAULT '24:00',
  max_holders        int NOT NULL DEFAULT 1,             -- >1 — семейный
  freeze_days_limit  int NOT NULL DEFAULT 0,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (time_to > time_from),
  CHECK (max_holders >= 1)
);
CREATE INDEX ON subscription_plans (org_id);

CREATE TABLE subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id        uuid NOT NULL REFERENCES subscription_plans(id),
  customer_id    uuid NOT NULL REFERENCES customers(id),
  purchased_at   timestamptz NOT NULL DEFAULT now(),
  valid_from     date NOT NULL DEFAULT CURRENT_DATE,
  -- базовый срок; фактический сдвигается на дни заморозки, вычисляемо
  valid_to_base  date NOT NULL,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','frozen','expired','used_up','cancelled')),
  balance_cache  numeric(10,2) NOT NULL DEFAULT 0,   -- кэш свёртки леджера
  price_paid     bigint NOT NULL DEFAULT 0,
  order_id       uuid REFERENCES orders(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON subscriptions (org_id, customer_id);

-- Семейный абонемент: несколько держателей на один баланс.
CREATE TABLE subscription_holders (
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES customers(id),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (subscription_id, customer_id)
);

-- Append-only. Ошибку кассира исправляем обратной записью, а не правкой.
CREATE TABLE subscription_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('charge','refund','adjust')),
  -- списание отрицательное, возврат и корректировка положительные
  amount          numeric(10,2) NOT NULL,
  covered_money   bigint NOT NULL DEFAULT 0,   -- сколько денег закрыл абонемент
  visit_id        uuid REFERENCES visits(id),
  order_item_id   uuid REFERENCES order_items(id) ON DELETE SET NULL,
  comment         text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON subscription_entries (subscription_id, created_at);

CREATE TRIGGER subscription_entries_append_only
  BEFORE UPDATE OR DELETE ON subscription_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE subscription_freezes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  starts_on       date NOT NULL,
  ends_on         date,
  reason          text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX ON subscription_freezes (subscription_id);

-- Позиция заказа помнит, чем именно закрыта: деньгами или абонементом.
ALTER TABLE order_items
  ADD COLUMN subscription_id uuid REFERENCES subscriptions(id),
  ADD COLUMN covered_amount bigint NOT NULL DEFAULT 0;

ALTER TABLE order_items DROP CONSTRAINT order_items_kind_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_kind_check
  CHECK (kind IN ('service_time','service_extra','product','subscription'));

-- Фактический срок с учётом всех заморозок.
CREATE OR REPLACE FUNCTION subscription_valid_to(p_subscription uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT s.valid_to_base + COALESCE((
    SELECT SUM(COALESCE(f.ends_on, CURRENT_DATE) - f.starts_on)
    FROM subscription_freezes f WHERE f.subscription_id = s.id
  ), 0)::int
  FROM subscriptions s WHERE s.id = p_subscription
$$;

-- Баланс всегда пересчитывается из леджера, кэш только для скорости.
CREATE OR REPLACE FUNCTION subscription_balance(p_subscription uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT p.allowance + COALESCE((
    SELECT SUM(e.amount) FROM subscription_entries e WHERE e.subscription_id = s.id
  ), 0)
  FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
  WHERE s.id = p_subscription
$$;

-- Политики RLS для новых таблиц (тот же принцип, что в 004).
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sauna_app;
GRANT EXECUTE ON FUNCTION subscription_valid_to(uuid) TO sauna_app;
GRANT EXECUTE ON FUNCTION subscription_balance(uuid) TO sauna_app;
REVOKE ALL ON users FROM sauna_app;
GRANT SELECT (id, phone, email, full_name, status, created_at) ON users TO sauna_app;
GRANT INSERT, UPDATE ON users TO sauna_app;
