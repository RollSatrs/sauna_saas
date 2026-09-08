-- Уникальный индекс на bcrypt-хеше PIN был бесполезен: соль делает хеш
-- разным при каждом сохранении, и два сотрудника могли получить один PIN.
-- Тогда вход по PIN нашёл бы двоих и пустил случайного из них.
DROP INDEX IF EXISTS memberships_pin_unique_per_branch;

-- Настоящая защита — в самой функции входа: неоднозначность останавливает вход,
-- а не разрешается молча в чью-то пользу.
CREATE OR REPLACE FUNCTION auth_lookup_pin(p_device uuid, p_token text, p_pin text)
RETURNS TABLE (
  user_id uuid, full_name text, membership_id uuid,
  org_id uuid, org_name text, branch_id uuid, branch_name text, role text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_device devices; v_matches int;
BEGIN
  SELECT * INTO v_device FROM devices d
  WHERE d.id = p_device AND d.revoked_at IS NULL AND d.token_hash = crypt(p_token, d.token_hash);
  IF v_device IS NULL THEN
    RAISE EXCEPTION 'это устройство не привязано к кассе';
  END IF;

  SELECT count(*) INTO v_matches
  FROM memberships m
  WHERE m.org_id = v_device.org_id AND m.status = 'active'
    AND (m.branch_id IS NULL OR m.branch_id = v_device.branch_id)
    AND m.pin_hash IS NOT NULL AND m.pin_hash = crypt(p_pin, m.pin_hash);

  IF v_matches > 1 THEN
    RAISE EXCEPTION 'этот PIN назначен нескольким сотрудникам — обратитесь к владельцу';
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

-- Проверка занятости PIN при его назначении: сравнить можно только перебором,
-- потому что хеш с солью не сравнивается напрямую. Сотрудников в филиале
-- десятки, поэтому это дёшево.
CREATE OR REPLACE FUNCTION pin_taken(p_org uuid, p_branch uuid, p_pin text, p_except uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.org_id = p_org
      AND m.status = 'active'
      AND (m.branch_id IS NULL OR p_branch IS NULL OR m.branch_id = p_branch)
      AND m.pin_hash IS NOT NULL
      AND (p_except IS NULL OR m.id <> p_except)
      AND m.pin_hash = crypt(p_pin, m.pin_hash)
  )
$$;

REVOKE ALL ON FUNCTION pin_taken(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pin_taken(uuid, uuid, text, uuid) TO sauna_app;
