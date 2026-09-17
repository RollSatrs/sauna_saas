-- Лимит попыток PIN. Четыре цифры подбираются перебором за минуты, поэтому
-- после нескольких промахов касса берёт паузу.
--
-- Счётчик живёт в базе, а не в памяти процесса: перезапуск сервера не должен
-- обнулять защиту, а при нескольких копиях API счётчик обязан быть общим.
-- Таблица служебная и не принадлежит организации — вход обращается к ней,
-- когда контекст организации ещё не выставлен, поэтому RLS здесь нет,
-- а доступ идёт только через функции ниже.

CREATE TABLE pin_lockouts (
  device_id    uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  failed       int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON pin_lockouts FROM PUBLIC;

-- Сколько секунд осталось до конца паузы. Ноль — можно пробовать.
CREATE OR REPLACE FUNCTION pin_lock_seconds(p_device uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int
     FROM pin_lockouts WHERE device_id = p_device AND locked_until > now()),
    0)
$$;

/**
 * Промах по PIN. Возвращает длительность паузы в секундах: ноль, если
 * попытки ещё остались. Порог намеренно щадящий — кассир ошибается пальцем
 * чаще, чем злоумышленник подбирает, а минута паузы делает перебор
 * четырёх цифр бессмысленным.
 */
CREATE OR REPLACE FUNCTION pin_note_failure(
  p_device uuid, p_limit int DEFAULT 5, p_lock_seconds int DEFAULT 60
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_failed int; v_locked timestamptz;
BEGIN
  INSERT INTO pin_lockouts (device_id, failed, updated_at)
    VALUES (p_device, 1, now())
  ON CONFLICT (device_id) DO UPDATE
    SET failed = pin_lockouts.failed + 1, updated_at = now()
  RETURNING failed, locked_until INTO v_failed, v_locked;

  -- Пауза уже идёт: счётчик не важен, просто сообщаем остаток.
  IF v_locked IS NOT NULL AND v_locked > now() THEN
    RETURN CEIL(EXTRACT(EPOCH FROM (v_locked - now())))::int;
  END IF;

  IF v_failed >= p_limit THEN
    UPDATE pin_lockouts
      SET failed = 0, locked_until = now() + make_interval(secs => p_lock_seconds), updated_at = now()
      WHERE device_id = p_device;
    RETURN p_lock_seconds;
  END IF;

  RETURN 0;
END
$$;

-- Верный PIN снимает и счётчик, и паузу: смена продолжается как обычно.
CREATE OR REPLACE FUNCTION pin_note_success(p_device uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM pin_lockouts WHERE device_id = p_device
$$;

REVOKE ALL ON FUNCTION pin_lock_seconds(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pin_note_failure(uuid, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION pin_note_success(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pin_lock_seconds(uuid) TO sauna_app;
GRANT EXECUTE ON FUNCTION pin_note_failure(uuid, int, int) TO sauna_app;
GRANT EXECUTE ON FUNCTION pin_note_success(uuid) TO sauna_app;
