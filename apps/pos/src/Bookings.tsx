import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Catalog } from "./types.ts";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/ui/select";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";

type Booking = {
  id: string; resource_id: string; starts_at: string; ends_at: string;
  buffer_minutes: number; guests_count: number; status: string;
  customer_name: string | null; customer_phone: string | null; resource_name: string;
};

const OPEN_HOUR = 8;
const CLOSE_HOUR = 24;
const HOURS = Array.from({ length: CLOSE_HOUR - OPEN_HOUR }, (_, i) => OPEN_HOUR + i);

const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Позиция блока в сетке часов: доли часа дают точность до минут. */
function span(booking: Booking) {
  const start = new Date(booking.starts_at);
  const end = new Date(booking.ends_at);
  const from = start.getHours() + start.getMinutes() / 60;
  const to = end.getHours() + end.getMinutes() / 60;
  return {
    left: `${((Math.max(from, OPEN_HOUR) - OPEN_HOUR) / HOURS.length) * 100}%`,
    width: `${((Math.min(to, CLOSE_HOUR) - Math.max(from, OPEN_HOUR)) / HOURS.length) * 100}%`,
  };
}

export function Bookings({ catalog }: { catalog: Catalog | null }) {
  const [date, setDate] = useState(localDay(new Date()));
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [draft, setDraft] = useState<{ resourceId: string; hour: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try { setBookings((await api<{ bookings: Booking[] }>(`/v1/bookings?date=${date}`)).bookings); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [date]);

  const shift = (days: number) => {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + days);
    setDate(localDay(d));
  };

  return (
    <div className="board">
      <div className="row" style={{ marginBottom: 16, alignItems: "center" }}>
        <button className="btn small" style={{ flex: "none" }} onClick={() => shift(-1)}>←</button>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)}
               className="h-11! w-[190px] flex-none" aria-label="Дата" />
        <button className="btn small" style={{ flex: "none" }} onClick={() => shift(1)}>→</button>
        <span className="hint" style={{ flex: 1 }}>
          Пересечения не даст записать сама база — с учётом времени на уборку.
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="timeline">
        <div className="timeline-head">
          <div className="timeline-label" />
          <div className="timeline-hours">
            {HOURS.map((h) => <span key={h}>{h}:00</span>)}
          </div>
        </div>
        {(catalog?.resources ?? []).map((resource) => (
          <div className="timeline-row" key={resource.id}>
            <div className="timeline-label">{resource.name}</div>
            <div className="timeline-track">
              {HOURS.map((h) => (
                <button key={h} className="timeline-slot"
                        onClick={() => setDraft({ resourceId: resource.id, hour: h })}
                        title={`Забронировать с ${h}:00`} />
              ))}
              {bookings.filter((b) => b.resource_id === resource.id && b.status !== "cancelled")
                .map((b) => (
                  <div key={b.id} className={`timeline-booking ${b.status}`} style={span(b)}>
                    <strong>{b.customer_name ?? "Без имени"}</strong>
                    <span>
                      {new Date(b.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                      –{new Date(b.ends_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                      {" · "}{b.guests_count} чел.
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <BookingDraft draft={draft} date={date} catalog={catalog}
                      onClose={() => setDraft(null)}
                      onSaved={() => { setDraft(null); void load(); }} />
      )}
    </div>
  );
}

function BookingDraft({ draft, date, catalog, onClose, onSaved }: {
  draft: { resourceId: string; hour: number }; date: string; catalog: Catalog | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [hours, setHours] = useState(2);
  const [guests, setGuests] = useState(2);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resource = catalog?.resources.find((r) => r.id === draft.resourceId);

  const save = async () => {
    // Про бронь честнее сказать сразу, а не после попытки: без связи программа
    // не может проверить, не занято ли это время на другой кассе.
    if (!navigator.onLine) {
      setError("Нет связи — бронь оформить нельзя: программа не сможет проверить, "
        + "не записан ли на это время гость с другой кассы. Запишите на бумаге "
        + "и внесите, когда интернет вернётся.");
      return;
    }
    setBusy(true); setError(null);
    try {
      let customerId: string | null = null;
      if (phone.trim()) {
        const r = await api<{ customer: { id: string } }>("/v1/customers",
          { method: "POST", body: { phone: phone.trim() } });
        customerId = r.customer.id;
      }
      const startsAt = new Date(`${date}T${String(draft.hour).padStart(2, "0")}:00:00`);
      const endsAt = new Date(startsAt.getTime() + hours * 3600000);
      await api("/v1/bookings", {
        method: "POST",
        body: {
          resourceId: draft.resourceId, customerId, guestsCount: guests,
          startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
        },
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    // Dialog из shadcn: перехват фокуса, закрытие по Esc и блокировка прокрутки
    // фона — то, что в самодельной модалке пришлось бы писать руками.
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Бронь · {resource?.name}</DialogTitle>
          <DialogDescription>
            {new Date(`${date}T12:00:00`).toLocaleDateString("ru-RU",
              { day: "numeric", month: "long", weekday: "long" })}
            , начало в {draft.hour}:00. Пересечение не даст записать сама база —
            с учётом времени на уборку.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="booking-hours">Сколько часов</Label>
            <Select value={String(hours)} onValueChange={(v) => setHours(Number(v))}>
              <SelectTrigger id="booking-hours" className="h-12! text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 5, 6].map((h) => (
                  <SelectItem key={h} value={String(h)} className="h-11 text-base">
                    {h} ч · до {String((draft.hour + h) % 24).padStart(2, "0")}:00
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="booking-guests">Гостей</Label>
            <Select value={String(guests)} onValueChange={(v) => setGuests(Number(v))}>
              <SelectTrigger id="booking-guests" className="h-12! text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                  <SelectItem key={n} value={String(n)} className="h-11 text-base">
                    {n} чел.
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="booking-phone">Телефон гостя</Label>
            <Input id="booking-phone" value={phone} inputMode="tel" className="h-12!"
                   onChange={(e) => setPhone(e.target.value)} placeholder="+7…" />
          </div>

          {error && <div className="error">{error}</div>}
        </div>

        <DialogFooter>
          <button className="btn ghost" onClick={onClose}>Отмена</button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Сохраняю…" : "Забронировать"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
