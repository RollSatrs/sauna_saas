import { useEffect, useState } from "react";
import { api, auth, formatTenge, newKey } from "./api.ts";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/ui/dialog";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";

type Receipt = {
  id: string; total: number; paid_total: number; status: string; created_at: string;
  resource_name: string | null; customer_name: string | null;
  payments: { id: string; method: string; amount: number; refunded: number }[];
};

/** Чеки смены и возвраты. Возврат — обратная операция, платёж остаётся нетронутым. */
export function Receipts({ onChanged }: { onChanged: () => void }) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<{ orderId: string; paymentId: string; max: number } | null>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  // Возврат оформляет управляющий или владелец — так решено с заказчиком.
  // Сервер кассиру откажет в любом случае, но кнопку не прячем молча:
  // кассир должен понимать, что дело не в поломке, а позвать управляющего.
  const можноВозврат = ["owner", "manager"].includes(auth.context()?.role ?? "");

  const load = async () => {
    try { setReceipts((await api<{ receipts: Receipt[] }>("/v1/shifts/current/receipts")).receipts); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  const refund = async () => {
    if (!refunding) return;
    setBusy(true); setError(null);
    try {
      await api(`/v1/orders/${refunding.orderId}/refunds`, {
        method: "POST",
        idempotencyKey: newKey("refund"),
        body: {
          paymentId: refunding.paymentId,
          amount: Math.round(Number(amount) * 100),
          reason,
        },
      });
      setRefunding(null); setReason(""); setAmount("");
      await load(); onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="board">
      <h2 style={{ marginTop: 0 }}>Чеки смены</h2>
      {error && <div className="error">{error}</div>}
      {receipts.length === 0 && <div className="empty">В этой смене ещё нет чеков</div>}

      <div className="items" style={{ maxWidth: 760 }}>
        {receipts.map((r) => (
          <div className="receipt" key={r.id}>
            <div className="receipt-head">
              <strong>{r.resource_name ?? "Продажа"}</strong>
              <span className="hint">
                {new Date(r.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                {r.customer_name ? ` · ${r.customer_name}` : ""}
              </span>
              <span className="price">{formatTenge(r.total)}</span>
            </div>
            <div className="receipt-payments">
              {r.payments.map((p) => (
                <div className="item" key={p.id}>
                  <span>
                    {p.method === "cash" ? "Наличные" : p.method === "card" ? "Карта" : p.method}
                    {p.refunded > 0 && <span className="warn"> · возвращено {formatTenge(p.refunded)}</span>}
                  </span>
                  <span className="price">{formatTenge(p.amount)}</span>
                  {можноВозврат ? (
                    <button className="btn small ghost" style={{ flex: "none" }}
                            disabled={p.refunded >= p.amount}
                            onClick={() => {
                              setRefunding({ orderId: r.id, paymentId: p.id, max: p.amount - p.refunded });
                              setAmount(String((p.amount - p.refunded) / 100));
                            }}>
                      Возврат
                    </button>
                  ) : (
                    p.refunded < p.amount && (
                      <span className="hint" style={{ flex: "none" }} title="Возврат оформляет управляющий или владелец">
                        возврат — через управляющего
                      </span>
                    )
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={refunding !== null} onOpenChange={(open) => { if (!open) setRefunding(null); }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Возврат</DialogTitle>
            <DialogDescription>
              Платёж останется в истории: возврат оформляется обратной операцией.
              Максимум к возврату — {formatTenge(refunding?.max ?? 0)}.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="refund-amount">Сумма, ₸</Label>
              <Input id="refund-amount" inputMode="numeric" value={amount} className="h-12!"
                     onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="refund-reason">Причина (обязательно)</Label>
              <Input id="refund-reason" value={reason} className="h-12!"
                     onChange={(e) => setReason(e.target.value)}
                     placeholder="например: гость отказался от массажа" />
            </div>
            {error && <div className="error">{error}</div>}
          </div>

          <DialogFooter>
            <button className="btn ghost" onClick={() => setRefunding(null)}>Отмена</button>
            <button className="btn primary" onClick={refund}
                    disabled={busy || !reason.trim() || Number(amount) <= 0}>
              {busy ? "Оформляю…" : "Вернуть"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
