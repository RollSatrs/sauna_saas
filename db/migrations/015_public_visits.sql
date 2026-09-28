-- Общественная баня продаёт вход, а не аренду конкретного помещения.
ALTER TABLE visits ALTER COLUMN resource_id DROP NOT NULL;

-- Снимок готового тарифа посещения хранится отдельным видом позиции заказа.
ALTER TABLE order_items DROP CONSTRAINT order_items_kind_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_kind_check
  CHECK (kind IN ('service_time','service_entry','service_extra','product','subscription'));
