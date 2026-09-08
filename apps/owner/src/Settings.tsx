import { useCallback, useEffect, useState } from "react";
import { api, formatTenge } from "./api.ts";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";

type Раздел = "plans" | "services" | "resources" | "products" | "staff" | "branch";

const РАЗДЕЛЫ: { id: Раздел; label: string }[] = [
  { id: "plans", label: "Абонементы" },
  { id: "services", label: "Услуги и цены" },
  { id: "resources", label: "Помещения" },
  { id: "products", label: "Товары" },
  { id: "staff", label: "Сотрудники" },
  { id: "branch", label: "Филиал" },
];

const ДНИ = [
  { id: "все", label: "Все дни" },
  { id: "будни", label: "Будни (пн–пт)" },
  { id: "выходные", label: "Выходные (сб–вс)" },
];

const маскаВДни = (m: number) => (m === 31 ? "будни" : m === 96 ? "выходные" : "все");
const тенге = (тиыны: number) => String(Math.round(Number(тиыны) / 100));

/** Поле формы с подписью: подпись всегда видна, не плейсхолдером. */
function Поле({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="field">
      <Label>{label}</Label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function Окно({ open, title, description, onClose, onSave, busy, error, children, saveLabel }: {
  open: boolean; title: string; description?: string; onClose: () => void;
  onSave: () => void; busy: boolean; error: string | null;
  children: React.ReactNode; saveLabel?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-[520px] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="form">{children}</div>
        {error && <div className="error">{error}</div>}
        <DialogFooter>
          <button className="btn ghost" onClick={onClose}>Отмена</button>
          <button className="btn primary" onClick={onSave} disabled={busy}>
            {busy ? "Сохраняю…" : saveLabel ?? "Сохранить"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Settings({ branches }: { branches: { id: string; name: string }[] }) {
  const [раздел, setРаздел] = useState<Раздел>("plans");
  const [данные, setДанные] = useState<any>({});
  // Услуги нужны не только своему разделу: на них ссылаются помещения
  // и абонементы. Поэтому держим их отдельно и грузим независимо от вкладки.
  const [услуги, setУслуги] = useState<any[]>([]);
  const [форма, setФорма] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [сообщение, setСообщение] = useState<string | null>(null);

  const загрузить = useCallback(async () => {
    const пути: Record<Раздел, string> = {
      plans: "/v1/manage/subscription-plans", services: "/v1/manage/services",
      resources: "/v1/manage/resources", products: "/v1/manage/products",
      staff: "/v1/manage/staff", branch: "/v1/branches",
    };
    try {
      setДанные(await api<any>(пути[раздел]));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [раздел]);

  const загрузитьУслуги = useCallback(async () => {
    try {
      setУслуги((await api<{ services: any[] }>("/v1/manage/services")).services);
    } catch { /* список останется прежним */ }
  }, []);

  useEffect(() => { void загрузить(); }, [загрузить]);
  useEffect(() => { void загрузитьУслуги(); }, [загрузитьУслуги]);

  const сохранить = async (метод: string, путь: string, тело: unknown, успех: string) => {
    setBusy(true); setError(null);
    try {
      await api(путь, { method: метод, body: тело });
      setФорма(null); setСообщение(успех);
      setTimeout(() => setСообщение(null), 3500);
      await загрузить();
      if (путь.includes("/services")) await загрузитьУслуги();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const архив = (путь: string, restore: boolean) =>
    сохранить("POST", путь, { restore }, restore ? "Возвращено в работу" : "Убрано в архив");

  const услугиДляВыбора = услуги.filter((s: any) => !s.archived_at);

  return (
    <div className="settings">
      <Tabs value={раздел} onValueChange={(v) => { setРаздел(v as Раздел); setФорма(null); }}>
        <TabsList className="h-11">
          {РАЗДЕЛЫ.map((r) => (
            <TabsTrigger key={r.id} value={r.id} className="h-9 px-4">{r.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {сообщение && <div className="ok-note">{сообщение}</div>}
      {error && !форма && <div className="error">{error}</div>}

      {/* ── Абонементы ─────────────────────────────────────────────── */}
      {раздел === "plans" && (
        <Карточка
          title="Абонементы"
          sub="Что гость покупает заранее: посещения, часы или безлимит на срок"
          onAdd={() => setФорма({ вид: "plan", type: "visits", allowance: 10, validityDays: 30,
                                  maxHolders: 1, freezeDaysLimit: 7, serviceIds: [] })}
          addLabel="Добавить абонемент">
          <table>
            <thead><tr>
              <th>Название</th><th>Что даёт</th><th>Срок</th>
              <th className="num">Цена</th><th className="num">Продано</th><th></th>
            </tr></thead>
            <tbody>
              {(данные.plans ?? []).map((p: any) => (
                <tr key={p.id} className={p.archived_at ? "archived" : ""}>
                  <td>{p.name}{p.archived_at && <span className="chip">в архиве</span>}</td>
                  <td>{p.type === "visits" ? `${Number(p.allowance)} посещений`
                     : p.type === "hours" ? `${Number(p.allowance)} часов` : "безлимит"}</td>
                  <td>{p.validity_days} дней</td>
                  <td className="num">{formatTenge(p.price)}</td>
                  <td className="num">{p.sold}</td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() => setФорма({
                      вид: "plan", id: p.id, name: p.name, type: p.type,
                      allowance: Number(p.allowance), validityDays: p.validity_days,
                      price: тенге(p.price), maxHolders: p.max_holders,
                      freezeDaysLimit: p.freeze_days_limit, serviceIds: p.scope_services ?? [],
                    })}>Изменить</button>
                    <button className="btn small ghost"
                      onClick={() => архив(`/v1/manage/subscription-plans/${p.id}/archive`, !!p.archived_at)}>
                      {p.archived_at ? "Вернуть" : "В архив"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Карточка>
      )}

      {/* ── Услуги ─────────────────────────────────────────────────── */}
      {раздел === "services" && (
        <Карточка
          title="Услуги и цены"
          sub="Почасовые — аренда помещений. Штучные — веник, массаж, простыня"
          onAdd={() => setФорма({ вид: "service", kind: "time_based", defaultDuration: 120,
            rules: [{ days: "все", from: "00:00", to: "24:00", price: "", priority: 0, minUnits: 1 }] })}
          addLabel="Добавить услугу">
          <table>
            <thead><tr><th>Услуга</th><th>Тип</th><th>Тарифы</th><th></th></tr></thead>
            <tbody>
              {услуги.map((s: any) => (
                <tr key={s.id} className={s.archived_at ? "archived" : ""}>
                  <td>{s.name}{s.archived_at && <span className="chip">в архиве</span>}</td>
                  <td>{s.kind === "time_based" ? "почасовая" : "штучная"}</td>
                  <td>
                    <div className="rules">
                      {(s.rules ?? []).map((r: any, i: number) => (
                        <span key={i}>
                          {маскаВДни(r.dowMask)} {r.from}–{r.to} · {formatTenge(r.price)}
                          {s.kind === "time_based" ? "/ч" : ""}
                          {Number(r.minUnits) > 1 ? ` · мин ${Number(r.minUnits)} ч` : ""}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() => setФорма({
                      вид: "service", id: s.id, name: s.name, kind: s.kind,
                      defaultDuration: s.default_duration_min ?? 60,
                      price: s.kind === "extra" ? тенге(s.rules?.[0]?.price ?? 0) : "",
                      rules: (s.rules ?? []).map((r: any) => ({
                        days: маскаВДни(r.dowMask), from: r.from, to: r.to,
                        price: тенге(r.price), priority: r.priority, minUnits: Number(r.minUnits),
                      })),
                    })}>Изменить</button>
                    <button className="btn small ghost"
                      onClick={() => архив(`/v1/manage/services/${s.id}/archive`, !!s.archived_at)}>
                      {s.archived_at ? "Вернуть" : "В архив"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Карточка>
      )}

      {/* ── Помещения ──────────────────────────────────────────────── */}
      {раздел === "resources" && (
        <Карточка
          title="Помещения"
          sub="Сауны, комнаты, купели — всё, что занимается по времени"
          onAdd={() => setФорма({ вид: "resource", capacity: 6, bufferMinutes: 15,
                                  branchId: branches[0]?.id })}
          addLabel="Добавить помещение">
          <table>
            <thead><tr>
              <th>Название</th><th>Услуга</th><th className="num">Мест</th>
              <th className="num">Уборка</th><th>Филиал</th><th></th>
            </tr></thead>
            <tbody>
              {(данные.resources ?? []).map((r: any) => (
                <tr key={r.id} className={r.archived_at ? "archived" : ""}>
                  <td>{r.name}{r.archived_at && <span className="chip">в архиве</span>}</td>
                  <td>{r.service_name ?? "—"}</td>
                  <td className="num">{r.capacity}</td>
                  <td className="num">{r.buffer_minutes} мин</td>
                  <td>{r.branch_name}</td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() => setФорма({
                      вид: "resource", id: r.id, name: r.name, capacity: r.capacity,
                      serviceId: r.default_service_id, bufferMinutes: r.buffer_minutes,
                      sortOrder: r.sort_order, branchId: r.branch_id,
                    })}>Изменить</button>
                    <button className="btn small ghost"
                      onClick={() => архив(`/v1/manage/resources/${r.id}/archive`, !!r.archived_at)}>
                      {r.archived_at ? "Вернуть" : "В архив"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Карточка>
      )}

      {/* ── Товары ─────────────────────────────────────────────────── */}
      {раздел === "products" && (
        <Карточка
          title="Товары"
          sub="Бар и розница. Остаток меняется приходом и списанием, а не правкой числа"
          onAdd={() => setФорма({ вид: "product" })}
          addLabel="Добавить товар">
          <table>
            <thead><tr>
              <th>Название</th><th>Категория</th><th className="num">Цена</th>
              <th className="num">Остаток</th><th></th>
            </tr></thead>
            <tbody>
              {(данные.products ?? []).map((p: any) => (
                <tr key={p.id} className={p.archived_at ? "archived" : ""}>
                  <td>{p.name}{p.archived_at && <span className="chip">в архиве</span>}</td>
                  <td>{p.category ?? "—"}</td>
                  <td className="num">{formatTenge(p.price)}</td>
                  <td className="num">{Number(p.stock)}</td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() => setФорма({
                      вид: "product", id: p.id, name: p.name,
                      category: p.category ?? "", price: тенге(p.price),
                    })}>Изменить</button>
                    <button className="btn small" onClick={() => setФорма({
                      вид: "stock", id: p.id, name: p.name, delta: "",
                      branchId: branches[0]?.id,
                    })}>Приход / списание</button>
                    <button className="btn small ghost"
                      onClick={() => архив(`/v1/manage/products/${p.id}/archive`, !!p.archived_at)}>
                      {p.archived_at ? "Вернуть" : "В архив"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Карточка>
      )}

      {/* ── Сотрудники ─────────────────────────────────────────────── */}
      {раздел === "staff" && (
        <Карточка
          title="Сотрудники"
          sub="PIN нужен для входа на кассе. В одном филиале два одинаковых PIN невозможны"
          onAdd={() => setФорма({ вид: "staff", role: "cashier", branchId: branches[0]?.id })}
          addLabel="Добавить сотрудника">
          <table>
            <thead><tr>
              <th>Имя</th><th>Телефон</th><th>Роль</th><th>Филиал</th><th>PIN</th><th></th>
            </tr></thead>
            <tbody>
              {(данные.staff ?? []).map((s: any) => (
                <tr key={s.membership_id} className={s.status !== "active" ? "archived" : ""}>
                  <td>{s.full_name}</td>
                  <td className="num">{s.phone}</td>
                  <td>{({ owner: "владелец", manager: "управляющий",
                          cashier: "кассир", accountant: "бухгалтер" } as any)[s.role]}</td>
                  <td>{s.branch_name ?? "все филиалы"}</td>
                  <td>{s.has_pin ? "задан" : "—"}</td>
                  <td className="row-actions">
                    {s.role !== "owner" && (
                      <button className="btn small" onClick={() => setФорма({
                        вид: "staff-edit", id: s.membership_id, fullName: s.full_name,
                        role: s.role, status: s.status,
                      })}>Изменить</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Карточка>
      )}

      {/* ── Филиал ─────────────────────────────────────────────────── */}
      {раздел === "branch" && (
        <div className="card">
          <h2>Настройки филиала</h2>
          <span className="sub">Как округлять время и сколько скидки может дать кассир</span>
          {(данные.branches ?? []).map((b: any) => (
            <div className="branch-row" key={b.id}>
              <div>
                <strong>{b.name}</strong>
                <span className="muted"> · пояс {b.timezone}</span>
              </div>
              <button className="btn small" onClick={() => setФорма({
                вид: "branch", id: b.id, name: b.name, address: b.address ?? "",
                pricingStep: b.settings?.pricing_step_min ?? 30,
                graceMinutes: b.settings?.grace_minutes ?? 5,
                discountLimit: b.settings?.cashier_discount_limit_percent ?? 10,
                rounding: b.settings?.rounding ?? "up",
              })}>Изменить</button>
            </div>
          ))}
        </div>
      )}

      {/* ── Формы ──────────────────────────────────────────────────── */}
      {форма?.вид === "plan" && (
        <Окно open title={форма.id ? "Изменить абонемент" : "Новый абонемент"}
              description="Гость платит один раз, а потом ходит по нему. Деньги за непрожитые
                           посещения — обязательство перед гостем, кабинет покажет его отдельно."
              onClose={() => setФорма(null)} busy={busy} error={error}
              onSave={() => сохранить(форма.id ? "PATCH" : "POST",
                форма.id ? `/v1/manage/subscription-plans/${форма.id}` : "/v1/manage/subscription-plans",
                { name: форма.name, type: форма.type, allowance: форма.allowance,
                  validityDays: форма.validityDays, price: форма.price,
                  serviceIds: форма.serviceIds, maxHolders: форма.maxHolders,
                  freezeDaysLimit: форма.freezeDaysLimit },
                форма.id ? "Абонемент изменён" : "Абонемент создан")}>
          <Поле label="Название">
            <Input value={форма.name ?? ""} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, name: e.target.value })}
                   placeholder="например: 10 посещений" />
          </Поле>
          <Поле label="Что даёт">
            <Select value={форма.type} onValueChange={(v) => setФорма({ ...форма, type: v })}>
              <SelectTrigger className="h-11!"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="visits" className="h-11">Определённое число посещений</SelectItem>
                <SelectItem value="hours" className="h-11">Определённое число часов</SelectItem>
                <SelectItem value="unlimited_period" className="h-11">Безлимит на срок</SelectItem>
              </SelectContent>
            </Select>
          </Поле>
          {форма.type !== "unlimited_period" && (
            <Поле label={форма.type === "hours" ? "Сколько часов" : "Сколько посещений"}>
              <Input type="number" min={1} value={форма.allowance ?? ""} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, allowance: Number(e.target.value) })} />
            </Поле>
          )}
          <div className="pair">
            <Поле label="Срок действия, дней">
              <Input type="number" min={1} value={форма.validityDays ?? ""} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, validityDays: Number(e.target.value) })} />
            </Поле>
            <Поле label="Цена, ₸">
              <Input inputMode="numeric" value={форма.price ?? ""} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, price: e.target.value })} />
            </Поле>
          </div>
          <div className="pair">
            <Поле label="Человек в абонементе" hint="Больше одного — семейный">
              <Input type="number" min={1} value={форма.maxHolders ?? 1} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, maxHolders: Number(e.target.value) })} />
            </Поле>
            <Поле label="Заморозка, дней" hint="0 — заморозка запрещена">
              <Input type="number" min={0} value={форма.freezeDaysLimit ?? 0} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, freezeDaysLimit: Number(e.target.value) })} />
            </Поле>
          </div>
          <Поле label="На какие услуги действует" hint="Ничего не отмечено — действует на все">
            <div className="checks">
              {услугиДляВыбора.map((s: any) => (
                <label key={s.id} className="check">
                  <input type="checkbox" checked={форма.serviceIds?.includes(s.id) ?? false}
                    onChange={(e) => setФорма({ ...форма,
                      serviceIds: e.target.checked
                        ? [...(форма.serviceIds ?? []), s.id]
                        : (форма.serviceIds ?? []).filter((x: string) => x !== s.id) })} />
                  {s.name}
                </label>
              ))}
            </div>
          </Поле>
        </Окно>
      )}

      {форма?.вид === "service" && (
        <Окно open title={форма.id ? "Изменить услугу" : "Новая услуга"}
              description="Тарифы можно задать разные на будни, вечер и выходные — программа
                           сама разложит визит по ним, даже если он пересекает границу."
              onClose={() => setФорма(null)} busy={busy} error={error}
              onSave={() => сохранить(форма.id ? "PATCH" : "POST",
                форма.id ? `/v1/manage/services/${форма.id}` : "/v1/manage/services",
                { name: форма.name, kind: форма.kind, defaultDuration: форма.defaultDuration,
                  price: форма.price, rules: форма.rules },
                форма.id ? "Услуга изменена" : "Услуга создана")}>
          <Поле label="Название">
            <Input value={форма.name ?? ""} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, name: e.target.value })} />
          </Поле>
          <Поле label="Тип">
            <Select value={форма.kind} onValueChange={(v) => setФорма({ ...форма, kind: v })}>
              <SelectTrigger className="h-11!"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="time_based" className="h-11">Почасовая — аренда помещения</SelectItem>
                <SelectItem value="extra" className="h-11">Штучная — веник, массаж, простыня</SelectItem>
              </SelectContent>
            </Select>
          </Поле>

          {форма.kind === "extra" ? (
            <Поле label="Цена, ₸">
              <Input inputMode="numeric" value={форма.price ?? ""} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, price: e.target.value })} />
            </Поле>
          ) : (
            <>
              <Поле label="Длительность по умолчанию, мин"
                    hint="Что подставится кассиру при приёме гостя">
                <Input type="number" min={15} step={15} value={форма.defaultDuration ?? 120}
                       className="h-11!"
                       onChange={(e) => setФорма({ ...форма, defaultDuration: Number(e.target.value) })} />
              </Поле>
              <Поле label="Тарифы"
                    hint="Если правила пересекаются, побеждает то, у которого приоритет выше">
                <div className="rule-editor">
                  {(форма.rules ?? []).map((r: any, i: number) => (
                    <div className="rule-row" key={i}>
                      <Select value={r.days}
                              onValueChange={(v) => setФорма({ ...форма,
                                rules: форма.rules.map((x: any, j: number) =>
                                  j === i ? { ...x, days: v } : x) })}>
                        <SelectTrigger className="h-10!"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ДНИ.map((d) => (
                            <SelectItem key={d.id} value={d.id} className="h-10">{d.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input className="h-10!" value={r.from} aria-label="с"
                             onChange={(e) => setФорма({ ...форма,
                               rules: форма.rules.map((x: any, j: number) =>
                                 j === i ? { ...x, from: e.target.value } : x) })} />
                      <Input className="h-10!" value={r.to} aria-label="до"
                             onChange={(e) => setФорма({ ...форма,
                               rules: форма.rules.map((x: any, j: number) =>
                                 j === i ? { ...x, to: e.target.value } : x) })} />
                      <Input className="h-10!" inputMode="numeric" value={r.price}
                             aria-label="цена за час"
                             onChange={(e) => setФорма({ ...форма,
                               rules: форма.rules.map((x: any, j: number) =>
                                 j === i ? { ...x, price: e.target.value } : x) })} />
                      <Input className="h-10!" type="number" min={0} value={r.priority}
                             aria-label="приоритет"
                             onChange={(e) => setФорма({ ...форма,
                               rules: форма.rules.map((x: any, j: number) =>
                                 j === i ? { ...x, priority: Number(e.target.value) } : x) })} />
                      <button className="btn small ghost" aria-label="Убрать тариф"
                              onClick={() => setФорма({ ...форма,
                                rules: форма.rules.filter((_: any, j: number) => j !== i) })}>×</button>
                    </div>
                  ))}
                  <div className="rule-head">
                    <span>дни</span><span>с</span><span>до</span><span>₸/час</span>
                    <span>приоритет</span><span></span>
                  </div>
                  <button className="btn small" onClick={() => setФорма({ ...форма,
                    rules: [...(форма.rules ?? []),
                            { days: "все", from: "00:00", to: "24:00", price: "", priority: 0, minUnits: 1 }] })}>
                    Добавить тариф
                  </button>
                </div>
              </Поле>
            </>
          )}
        </Окно>
      )}

      {форма?.вид === "resource" && (
        <Окно open title={форма.id ? "Изменить помещение" : "Новое помещение"}
              description="Время уборки прибавляется к брони: следующего гостя нельзя записать
                           впритык."
              onClose={() => setФорма(null)} busy={busy} error={error}
              onSave={() => сохранить(форма.id ? "PATCH" : "POST",
                форма.id ? `/v1/manage/resources/${форма.id}` : "/v1/manage/resources",
                { name: форма.name, capacity: форма.capacity, serviceId: форма.serviceId,
                  bufferMinutes: форма.bufferMinutes, sortOrder: форма.sortOrder,
                  branchId: форма.branchId },
                форма.id ? "Помещение изменено" : "Помещение добавлено")}>
          <Поле label="Название">
            <Input value={форма.name ?? ""} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, name: e.target.value })}
                   placeholder="например: Сауна №1" />
          </Поле>
          <Поле label="Услуга по умолчанию" hint="Что подставится кассиру при приёме гостя">
            <Select value={форма.serviceId ?? ""} onValueChange={(v) => setФорма({ ...форма, serviceId: v })}>
              <SelectTrigger className="h-11!"><SelectValue placeholder="Выберите услугу" /></SelectTrigger>
              <SelectContent>
                {услугиДляВыбора.filter((s: any) => s.kind === "time_based").map((s: any) => (
                  <SelectItem key={s.id} value={s.id} className="h-11">{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Поле>
          <div className="pair">
            <Поле label="Вместимость, человек">
              <Input type="number" min={1} value={форма.capacity ?? 1} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, capacity: Number(e.target.value) })} />
            </Поле>
            <Поле label="Уборка, мин">
              <Input type="number" min={0} value={форма.bufferMinutes ?? 0} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, bufferMinutes: Number(e.target.value) })} />
            </Поле>
          </div>
          {branches.length > 1 && !форма.id && (
            <Поле label="Филиал">
              <Select value={форма.branchId} onValueChange={(v) => setФорма({ ...форма, branchId: v })}>
                <SelectTrigger className="h-11!"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id} className="h-11">{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Поле>
          )}
        </Окно>
      )}

      {форма?.вид === "product" && (
        <Окно open title={форма.id ? "Изменить товар" : "Новый товар"}
              onClose={() => setФорма(null)} busy={busy} error={error}
              onSave={() => сохранить(форма.id ? "PATCH" : "POST",
                форма.id ? `/v1/manage/products/${форма.id}` : "/v1/manage/products",
                { name: форма.name, category: форма.category, price: форма.price },
                форма.id ? "Товар изменён" : "Товар добавлен")}>
          <Поле label="Название">
            <Input value={форма.name ?? ""} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, name: e.target.value })} />
          </Поле>
          <div className="pair">
            <Поле label="Категория" hint="Для группировки в кассе">
              <Input value={форма.category ?? ""} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, category: e.target.value })}
                     placeholder="Напитки" />
            </Поле>
            <Поле label="Цена, ₸">
              <Input inputMode="numeric" value={форма.price ?? ""} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, price: e.target.value })} />
            </Поле>
          </div>
        </Окно>
      )}

      {форма?.вид === "stock" && (
        <Окно open title={`Остаток · ${форма.name}`} saveLabel="Провести"
              description="Положительное число — приход, отрицательное — списание.
                           Остаток всегда складывается из движений, поэтому видно, кто и когда его менял."
              onClose={() => setФорма(null)} busy={busy} error={error}
              onSave={() => сохранить("POST", `/v1/manage/products/${форма.id}/stock`,
                { delta: Number(форма.delta), branchId: форма.branchId,
                  reason: Number(форма.delta) < 0 ? "writeoff" : "income" },
                "Остаток обновлён")}>
          <Поле label="Количество">
            <Input inputMode="numeric" value={форма.delta ?? ""} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, delta: e.target.value })}
                   placeholder="например: 24 или −3" />
          </Поле>
        </Окно>
      )}

      {(форма?.вид === "staff" || форма?.вид === "staff-edit") && (
        <Окно open title={форма.вид === "staff" ? "Новый сотрудник" : "Изменить сотрудника"}
              description="PIN нужен для входа на кассе. Пароль — для кабинета и привязки касс."
              onClose={() => setФорма(null)} busy={busy} error={error}
              onSave={() => форма.вид === "staff"
                ? сохранить("POST", "/v1/manage/staff",
                    { phone: форма.phone, fullName: форма.fullName, role: форма.role,
                      pin: форма.pin, password: форма.password, branchId: форма.branchId },
                    "Сотрудник добавлен")
                : сохранить("PATCH", `/v1/manage/staff/${форма.id}`,
                    { fullName: форма.fullName, role: форма.role, pin: форма.pin || undefined,
                      status: форма.status },
                    "Сотрудник изменён")}>
          <Поле label="Имя">
            <Input value={форма.fullName ?? ""} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, fullName: e.target.value })} />
          </Поле>
          {форма.вид === "staff" && (
            <Поле label="Телефон" hint="По нему сотрудник входит в кабинет">
              <Input value={форма.phone ?? ""} className="h-11!" inputMode="tel"
                     onChange={(e) => setФорма({ ...форма, phone: e.target.value })}
                     placeholder="+7…" />
            </Поле>
          )}
          <Поле label="Роль">
            <Select value={форма.role} onValueChange={(v) => setФорма({ ...форма, role: v })}>
              <SelectTrigger className="h-11!"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cashier" className="h-11">Кассир — смена и приём гостей</SelectItem>
                <SelectItem value="manager" className="h-11">Управляющий — ещё отчёты и возвраты</SelectItem>
                <SelectItem value="accountant" className="h-11">Бухгалтер — только отчёты</SelectItem>
              </SelectContent>
            </Select>
          </Поле>
          <div className="pair">
            <Поле label={форма.вид === "staff" ? "PIN для кассы" : "Новый PIN"}
                  hint={форма.вид === "staff" ? "4–8 цифр" : "оставьте пустым, чтобы не менять"}>
              <Input inputMode="numeric" value={форма.pin ?? ""} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, pin: e.target.value })} />
            </Поле>
            {форма.вид === "staff" && (
              <Поле label="Пароль для кабинета">
                <Input value={форма.password ?? ""} className="h-11!"
                       onChange={(e) => setФорма({ ...форма, password: e.target.value })} />
              </Поле>
            )}
          </div>
        </Окно>
      )}

      {форма?.вид === "branch" && (
        <Окно open title="Настройки филиала"
              description="Шаг тарификации — до чего округляется время. Льготные минуты —
                           переработка, которую не считаем."
              onClose={() => setФорма(null)} busy={busy} error={error}
              onSave={() => сохранить("PATCH", `/v1/manage/branches/${форма.id}`,
                { name: форма.name, address: форма.address, pricingStep: форма.pricingStep,
                  graceMinutes: форма.graceMinutes, discountLimit: форма.discountLimit,
                  rounding: форма.rounding },
                "Настройки сохранены")}>
          <Поле label="Название">
            <Input value={форма.name ?? ""} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, name: e.target.value })} />
          </Поле>
          <Поле label="Адрес">
            <Input value={форма.address ?? ""} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, address: e.target.value })} />
          </Поле>
          <div className="pair">
            <Поле label="Шаг тарификации, мин" hint="Обычно 30 или 60">
              <Input type="number" min={5} value={форма.pricingStep} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, pricingStep: Number(e.target.value) })} />
            </Поле>
            <Поле label="Льготные минуты" hint="Меньше шага">
              <Input type="number" min={0} value={форма.graceMinutes} className="h-11!"
                     onChange={(e) => setФорма({ ...форма, graceMinutes: Number(e.target.value) })} />
            </Поле>
          </div>
          <Поле label="Лимит скидки кассира, %"
                hint="Больше этого — только с подтверждением управляющего">
            <Input type="number" min={0} max={100} value={форма.discountLimit} className="h-11!"
                   onChange={(e) => setФорма({ ...форма, discountLimit: Number(e.target.value) })} />
          </Поле>
        </Окно>
      )}
    </div>
  );
}

function Карточка({ title, sub, onAdd, addLabel, children }: {
  title: string; sub: string; onAdd: () => void; addLabel: string; children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          <span className="sub">{sub}</span>
        </div>
        <button className="btn primary" onClick={onAdd}>{addLabel}</button>
      </div>
      <div className="table-wrap">{children}</div>
    </div>
  );
}
