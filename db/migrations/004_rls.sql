-- Э0 · Изоляция арендаторов на уровне СУБД.
-- Забытый WHERE org_id в коде не должен приводить к утечке чужой выручки.

-- Политика вешается на каждую таблицу, где есть org_id, — списком, а не вручную,
-- чтобы новая таблица не осталась без защиты по недосмотру.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())',
      t);
  END LOOP;
END
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  USING (id = current_org()) WITH CHECK (id = current_org());

-- Вход по телефону происходит до того, как известна организация, поэтому чтение
-- учётной записи вынесено в одну контролируемую функцию, а не в общий доступ
-- к таблице: хеш пароля роли приложения не виден.
REVOKE ALL ON users FROM sauna_app;
GRANT SELECT (id, phone, email, full_name, status, created_at) ON users TO sauna_app;
GRANT INSERT, UPDATE ON users TO sauna_app;

-- Пароль проверяется внутри базы: хеш не покидает СУБД и роли приложения не виден.
CREATE OR REPLACE FUNCTION auth_lookup(p_phone text, p_password text)
RETURNS TABLE (
  user_id       uuid,
  full_name     text,
  membership_id uuid,
  org_id        uuid,
  org_name      text,
  branch_id     uuid,
  branch_name   text,
  role          text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.full_name, m.id, m.org_id, o.name, m.branch_id, b.name, m.role
  FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
  JOIN organizations o ON o.id = m.org_id
  LEFT JOIN branches b ON b.id = m.branch_id
  WHERE u.phone = p_phone
    AND u.status = 'active'
    AND u.password_hash = crypt(p_password, u.password_hash)
$$;

REVOKE ALL ON FUNCTION auth_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup(text, text) TO sauna_app;

GRANT USAGE ON SCHEMA public TO sauna_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sauna_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sauna_app;
GRANT EXECUTE ON FUNCTION current_org() TO sauna_app;
REVOKE ALL ON users FROM sauna_app;
GRANT SELECT (id, phone, email, full_name, status, created_at) ON users TO sauna_app;
GRANT INSERT, UPDATE ON users TO sauna_app;
