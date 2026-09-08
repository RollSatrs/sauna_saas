-- Офлайн-очередь повторяет операции при возврате связи. Повтор безопасен только
-- если сервер узнаёт уже выполненный запрос и возвращает прежний ответ,
-- а не выполняет его второй раз. Для платежей такой ключ уже был — теперь
-- он нужен и для добавления позиций, продлений и открытия визита.
CREATE TABLE idempotency_keys (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key        text NOT NULL,
  endpoint   text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);
CREATE INDEX ON idempotency_keys (created_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON idempotency_keys;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (org_id = current_org()) WITH CHECK (org_id = current_org());

GRANT SELECT, INSERT, DELETE ON idempotency_keys TO sauna_app;

-- Ключи живут неделю: очередь кассы столько не копится, а таблица не растёт вечно.
CREATE OR REPLACE FUNCTION purge_idempotency_keys() RETURNS void
LANGUAGE sql AS $$
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'
$$;
