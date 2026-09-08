-- Вход по PIN. Один PIN сам по себе — слабая защита, поэтому он работает
-- только на устройстве, заранее привязанном к филиалу паролем.
-- Пароль вводится один раз при установке, дальше кассир жмёт четыре цифры.

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX ON devices (org_id, branch_id);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON devices;
CREATE POLICY tenant_isolation ON devices
  USING (org_id = current_org()) WITH CHECK (org_id = current_org());

-- PIN уникален внутри филиала: иначе система не поймёт, кто именно вошёл.
CREATE UNIQUE INDEX memberships_pin_unique_per_branch
  ON memberships (org_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), pin_hash)
  WHERE pin_hash IS NOT NULL AND status = 'active';

-- Привязка устройства: проверяем пароль сотрудника и его право на филиал.
CREATE OR REPLACE FUNCTION auth_bind_device(
  p_phone text, p_password text, p_branch uuid, p_name text, p_token text
)
RETURNS TABLE (device_id uuid, org_id uuid, org_name text, branch_id uuid, branch_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_org uuid; v_device uuid;
BEGIN
  SELECT u.id, m.org_id INTO v_user, v_org
  FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
  JOIN branches b ON b.id = p_branch AND b.org_id = m.org_id
  WHERE u.phone = p_phone
    AND u.status = 'active'
    AND u.password_hash = crypt(p_password, u.password_hash)
    AND (m.branch_id IS NULL OR m.branch_id = p_branch)
    AND m.role IN ('owner', 'manager')
  LIMIT 1;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'привязать кассу может только владелец или управляющий этого филиала';
  END IF;

  INSERT INTO devices (org_id, branch_id, name, token_hash, created_by)
    VALUES (v_org, p_branch, p_name, crypt(p_token, gen_salt('bf')), v_user)
    RETURNING id INTO v_device;

  RETURN QUERY
    SELECT v_device, v_org, o.name, b.id, b.name
    FROM organizations o, branches b
    WHERE o.id = v_org AND b.id = p_branch;
END
$$;

-- Вход по PIN: устройство задаёт филиал, PIN определяет сотрудника.
CREATE OR REPLACE FUNCTION auth_lookup_pin(p_device uuid, p_token text, p_pin text)
RETURNS TABLE (
  user_id uuid, full_name text, membership_id uuid,
  org_id uuid, org_name text, branch_id uuid, branch_name text, role text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_device devices;
BEGIN
  SELECT * INTO v_device FROM devices d
  WHERE d.id = p_device AND d.revoked_at IS NULL AND d.token_hash = crypt(p_token, d.token_hash);
  IF v_device IS NULL THEN
    RAISE EXCEPTION 'это устройство не привязано к кассе';
  END IF;

  UPDATE devices SET last_seen_at = now() WHERE id = v_device.id;

  RETURN QUERY
    SELECT u.id, u.full_name, m.id, m.org_id, o.name, v_device.branch_id, b.name, m.role
    FROM memberships m
    JOIN users u ON u.id = m.user_id AND u.status = 'active'
    JOIN organizations o ON o.id = m.org_id
    JOIN branches b ON b.id = v_device.branch_id
    WHERE m.org_id = v_device.org_id
      AND m.status = 'active'
      AND (m.branch_id IS NULL OR m.branch_id = v_device.branch_id)
      AND m.pin_hash IS NOT NULL
      AND m.pin_hash = crypt(p_pin, m.pin_hash);
END
$$;

REVOKE ALL ON FUNCTION auth_bind_device(text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_pin(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_bind_device(text, text, uuid, text, text) TO sauna_app;
GRANT EXECUTE ON FUNCTION auth_lookup_pin(uuid, text, text) TO sauna_app;
GRANT SELECT, INSERT, UPDATE ON devices TO sauna_app;

-- Публичный список филиалов организации по коду привязки не нужен:
-- филиал выбирается уже после проверки пароля, поэтому отдельного доступа нет.
