-- Э0 · Каркас: организации, филиалы, сотрудники, права, аудит.
-- Изоляция арендаторов — на уровне СУБД (RLS), а не дисциплины разработчика.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Роль приложения. Она НЕ владелец таблиц, поэтому политики RLS её ограничивают.
-- Миграции и сид идут под владельцем, который RLS обходит — это осознанно.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sauna_app') THEN
    CREATE ROLE sauna_app LOGIN PASSWORD 'sauna_app';
  END IF;
END
$$;

-- Текущая организация берётся ТОЛЬКО из настройки сессии, которую ставит API
-- из подписанного токена. Из тела запроса org_id не принимается никогда.
CREATE OR REPLACE FUNCTION current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$$;

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  bin         text,
  currency    char(3) NOT NULL DEFAULT 'KZT',
  status      text NOT NULL DEFAULT 'active',
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  address               text,
  -- Время хранится в UTC, у филиала свой пояс. Отчёты строятся по операционному
  -- дню филиала: круглосуточная баня иначе получит разорванную ночную выручку.
  timezone              text NOT NULL DEFAULT 'Asia/Almaty',
  operational_day_start time NOT NULL DEFAULT '06:00',
  -- pricing_step_min, rounding, grace_minutes, cashier_discount_limit_percent
  settings              jsonb NOT NULL DEFAULT
                        '{"pricing_step_min":30,"rounding":"up","grace_minutes":5,"cashier_discount_limit_percent":10}'::jsonb,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON branches (org_id);

-- Пользователь глобален: один человек может работать в нескольких организациях.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL UNIQUE,
  email         text,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id   uuid REFERENCES branches(id) ON DELETE CASCADE,  -- NULL = все филиалы
  role        text NOT NULL CHECK (role IN ('owner','manager','cashier','accountant')),
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  pin_hash    text,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id, branch_id)
);
CREATE INDEX ON memberships (org_id);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id   uuid,
  user_id     uuid,
  shift_id    uuid,
  entity_type text NOT NULL,
  entity_id   text,
  action      text NOT NULL,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (org_id, created_at DESC);
