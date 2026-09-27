-- Режим каталога управляет только видимостью сценариев в кабинете владельца.
-- Отсутствующее значение у старых филиалов означает private, но сохраняем его явно,
-- чтобы API и новые клиенты видели одинаковую настройку.
UPDATE branches
SET settings = jsonb_set(settings, '{catalog_mode}', '"private"'::jsonb, true)
WHERE NOT settings ? 'catalog_mode';

ALTER TABLE branches ALTER COLUMN settings SET DEFAULT
  '{"pricing_step_min":30,"rounding":"up","grace_minutes":5,"cashier_discount_limit_percent":10,"catalog_mode":"private"}'::jsonb;
