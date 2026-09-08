// Оболочка кассы для Windows и macOS. Вся логика — в веб-части,
// программа лишь даёт ей окно, автозапуск и доступ к оборудованию.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sauna_pos_lib::run()
}
