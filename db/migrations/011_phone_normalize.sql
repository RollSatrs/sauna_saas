-- Телефон вводят по-разному: +7 701 000 00 01, 87010000001, 7010000001.
-- Раньше любое отличие от записанного считалось «нет прав», хотя причина
-- была в формате. Приводим номер к одному виду при записи и при поиске.
CREATE OR REPLACE FUNCTION normalize_phone(p_phone text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN цифры = '' THEN NULL
    -- 8 701… и 7 701… — это один и тот же казахстанский номер
    WHEN length(цифры) = 11 AND left(цифры, 1) IN ('7', '8') THEN '+7' || right(цифры, 10)
    WHEN length(цифры) = 10 THEN '+7' || цифры
    ELSE '+' || цифры
  END
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') AS цифры) t
$$;

-- Приводим уже записанные номера и следим за новыми.
UPDATE users SET phone = normalize_phone(phone) WHERE phone <> normalize_phone(phone);
UPDATE customers SET phone = normalize_phone(phone) WHERE phone <> normalize_phone(phone);

CREATE OR REPLACE FUNCTION users_normalize_phone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.phone := normalize_phone(NEW.phone);
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS users_phone_normalized ON users;
CREATE TRIGGER users_phone_normalized BEFORE INSERT OR UPDATE OF phone ON users
  FOR EACH ROW EXECUTE FUNCTION users_normalize_phone();

CREATE OR REPLACE FUNCTION customers_normalize_phone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.phone := normalize_phone(NEW.phone);
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS customers_phone_normalized ON customers;
CREATE TRIGGER customers_phone_normalized BEFORE INSERT OR UPDATE OF phone ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_normalize_phone();

-- Вход: ищем по приведённому номеру.
CREATE OR REPLACE FUNCTION auth_lookup(p_phone text, p_password text)
RETURNS TABLE (
  user_id uuid, full_name text, membership_id uuid,
  org_id uuid, org_name text, branch_id uuid, branch_name text, role text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.full_name, m.id, m.org_id, o.name, m.branch_id, b.name, m.role
  FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
  JOIN organizations o ON o.id = m.org_id
  LEFT JOIN branches b ON b.id = m.branch_id
  WHERE u.phone = normalize_phone(p_phone)
    AND u.status = 'active'
    AND u.password_hash = crypt(p_password, u.password_hash)
$$;

-- Привязка кассы: три разные причины отказа — три разных сообщения.
-- «Нет прав» на неверный пароль сбивало с толку и заставляло искать
-- проблему не там.
CREATE OR REPLACE FUNCTION auth_bind_device(
  p_phone text, p_password text, p_branch uuid, p_name text, p_token text
)
RETURNS TABLE (device_id uuid, org_id uuid, org_name text, branch_id uuid, branch_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_org uuid; v_device uuid; v_role text;
BEGIN
  SELECT u.id INTO v_user FROM users u
  WHERE u.phone = normalize_phone(p_phone)
    AND u.status = 'active'
    AND u.password_hash = crypt(p_password, u.password_hash);

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'неверный телефон или пароль';
  END IF;

  SELECT m.org_id, m.role INTO v_org, v_role
  FROM memberships m
  JOIN branches b ON b.id = p_branch AND b.org_id = m.org_id
  WHERE m.user_id = v_user
    AND m.status = 'active'
    AND (m.branch_id IS NULL OR m.branch_id = p_branch)
  ORDER BY CASE m.role WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END
  LIMIT 1;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'этот сотрудник не работает в выбранном филиале';
  END IF;

  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'привязать кассу может только владелец или управляющий: у этого сотрудника роль «%»',
      CASE v_role WHEN 'cashier' THEN 'кассир' WHEN 'accountant' THEN 'бухгалтер' ELSE v_role END;
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

REVOKE ALL ON FUNCTION auth_bind_device(text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_bind_device(text, text, uuid, text, text) TO sauna_app;
GRANT EXECUTE ON FUNCTION auth_lookup(text, text) TO sauna_app;
GRANT EXECUTE ON FUNCTION normalize_phone(text) TO sauna_app;
