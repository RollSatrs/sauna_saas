import { formatClock, formatTenge } from "./api.ts";
import type { Tile } from "./types.ts";

const STATE_LABEL: Record<Tile["state"], string> = {
  free: "свободна",
  booked: "бронь",
  busy: "занята",
  ending: "заканчивается",
  overtime: "переработка",
};

/**
 * Обратный отсчёт считается от серверного времени: часы кассового компьютера
 * могут врать, а спор с гостем о времени стоит денег.
 */
function minutesLeft(tile: Tile, nowMs: number): number {
  if (!tile.visit) return 0;
  return Math.round((new Date(tile.visit.plannedEnd).getTime() - nowMs) / 60000);
}

export function BoardGrid({ tiles, nowMs, selectedId, onSelect }: {
  tiles: Tile[];
  nowMs: number;
  selectedId: string | null;
  onSelect: (tile: Tile) => void;
}) {
  return (
    <div className="grid">
      {tiles.map((tile) => {
        const left = minutesLeft(tile, nowMs);
        const state: Tile["state"] = tile.visit
          ? left < 0 ? "overtime" : left <= 10 ? "ending" : "busy"
          : tile.state;
        return (
          <button
            key={tile.resourceId}
            className={`tile ${state} ${selectedId === tile.resourceId ? "selected" : ""}`}
            onClick={() => onSelect(tile)}
          >
            <span className="badge">{STATE_LABEL[state]}</span>
            <span className="name">{tile.name}</span>
            <span className="sub">
              {tile.visit
                ? `${tile.visit.customerName ?? "Без имени"} · ${tile.visit.guestsCount} чел.`
                : `до ${tile.capacity} чел.${tile.bufferMinutes ? ` · уборка ${tile.bufferMinutes} мин` : ""}`}
            </span>

            {tile.visit ? (
              <>
                <span className="timer">
                  {left < 0 ? `+${formatClock(-left)}` : formatClock(left)}
                </span>
                <span className="amount">{formatTenge(tile.visit.dueTotal)}</span>
              </>
            ) : (
              <>
                {/* На свободной плитке место таймера занимает подсказка о действии:
                    прочерк не сообщал бы ничего, а место всё равно резервируется,
                    чтобы плитки не прыгали по высоте при смене состояния. */}
                <span className="timer free-hint">Начать визит</span>
                <span className="amount">
                  {tile.upcoming
                    ? `следующая бронь в ${new Date(tile.upcoming.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
                    : "свободна до конца дня"}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
