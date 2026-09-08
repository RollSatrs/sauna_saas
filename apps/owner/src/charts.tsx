import { Fragment, useState } from "react";
import { formatCompact, formatDay, formatTenge } from "./api.ts";

/**
 * Графики рисуются inline-SVG: формы простые, библиотека тут была бы лишним весом.
 * Цвета берутся из токенов темы, поэтому одинаково читаются в светлой и тёмной.
 */

// Левое поле рассчитано на самую широкую подпись оси («500 тыс ₸»),
// правое — на половину подписи даты: иначе крайние подписи обрезаются.
const PLOT = { width: 860, height: 260, left: 82, right: 34, top: 18, bottom: 34 };

export function RevenueChart({ data }: { data: { day: string; revenue: number; orders: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return <div className="empty">За этот период платежей не было</div>;

  const innerW = PLOT.width - PLOT.left - PLOT.right;
  const innerH = PLOT.height - PLOT.top - PLOT.bottom;
  const max = Math.max(...data.map((d) => d.revenue), 1);
  // Верх шкалы — ближайшее «круглое» число из ряда 1-2-2,5-5-10.
  // Просто степень десятки задирала бы потолок вдвое и прижимала данные ко дну.
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const top = magnitude * ([1, 2, 2.5, 5, 10].find((f) => max <= magnitude * f) ?? 10);
  const x = (i: number) => PLOT.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => PLOT.top + innerH - (v / top) * innerH;

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.revenue).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${PLOT.top + innerH} L${x(0).toFixed(1)},${PLOT.top + innerH} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  // Один день — это не линия: рисуем столбец с подписью значения.
  const single = data.length === 1;

  return (
    <div className="chart"
         onMouseLeave={() => setHover(null)}
         onMouseMove={(event) => {
           const box = event.currentTarget.getBoundingClientRect();
           const ratio = (event.clientX - box.left) / box.width;
           const svgX = ratio * PLOT.width;
           const index = Math.round(((svgX - PLOT.left) / innerW) * (data.length - 1));
           setHover(Math.max(0, Math.min(data.length - 1, index)));
         }}>
      <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} role="img"
           aria-label="Выручка по дням">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PLOT.left} x2={PLOT.width - PLOT.right} y1={y(t)} y2={y(t)}
                  stroke="var(--grid)" strokeWidth="1" />
            <text x={PLOT.left - 10} y={y(t) + 4} textAnchor="end"
                  fill="var(--ink-3)" fontSize="11">{formatCompact(t)}</text>
          </g>
        ))}
        {single ? (
          <g>
            <rect x={x(0) - 26} y={y(data[0].revenue)} width="52"
                  height={Math.max(2, PLOT.top + innerH - y(data[0].revenue))}
                  rx="4" fill="var(--series-1)" />
            <text x={x(0)} y={y(data[0].revenue) - 9} textAnchor="middle"
                  fill="var(--ink-2)" fontSize="12" fontWeight="600">
              {formatCompact(data[0].revenue)}
            </text>
          </g>
        ) : (
          <>
            <path d={area} fill="var(--series-1-fill)" />
            <path d={line} fill="none" stroke="var(--series-1)" strokeWidth="2"
                  strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {data.map((d, i) => (
          // Последняя подпись рисуется всегда, а регулярная рядом с ней —
          // пропускается: иначе две даты печатаются друг на друге.
          (i % labelEvery === 0 && i < data.length - Math.ceil(labelEvery / 2)) || i === data.length - 1 ? (
            <text key={d.day} x={x(i)} y={PLOT.height - 12}
                  // крайние подписи прижимаются внутрь, чтобы не уехать за край
                  textAnchor={i === 0 && !single ? "start" : i === data.length - 1 && !single ? "end" : "middle"}
                  fill="var(--ink-3)" fontSize="11">{formatDay(d.day)}</text>
          ) : null
        ))}
        {hover !== null && !single && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PLOT.top} y2={PLOT.top + innerH}
                  stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(data[hover].revenue)} r="5"
                    fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${(x(hover) / PLOT.width) * 100}%` }}>
          <strong>{formatDay(data[hover].day)}</strong>
          <span>{formatTenge(data[hover].revenue)}</span>
          <span className="muted">{data[hover].orders} чек(ов)</span>
        </div>
      )}
    </div>
  );
}

const DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Загрузка по дням недели и часам: где простой, а где не хватает мощности. */
export function OccupancyHeatmap({ data }: { data: { dow: number; hour: number; busyHours: number }[] }) {
  const [hover, setHover] = useState<{ dow: number; hour: number; value: number } | null>(null);
  if (data.length === 0) return <div className="empty">Визитов за период не было</div>;

  const hours = Array.from(new Set(data.map((d) => d.hour))).sort((a, b) => a - b);
  const from = Math.min(...hours, 10);
  const to = Math.max(...hours, 22);
  const columns = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(...data.map((d) => d.busyHours), 1);
  const at = (dow: number, hour: number) =>
    data.find((d) => d.dow === dow && d.hour === hour)?.busyHours ?? 0;

  // Одна шкала, светлое -> тёмное. Радуги быть не должно: величина не категория.
  const RAMP = ["--seq-0", "--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5"];
  const shade = (value: number) =>
    `var(${RAMP[value === 0 ? 0 : Math.min(RAMP.length - 1, Math.ceil((value / max) * (RAMP.length - 1)))]})`;

  return (
    <div className="heatmap-wrap">
      <div className="heatmap" style={{ gridTemplateColumns: `36px repeat(${columns.length}, 1fr)` }}>
        <span />
        {columns.map((h) => <span key={h} className="heat-axis">{h}</span>)}
        {DOW.map((label, index) => (
          <Fragment key={label}>
            <span className="heat-axis heat-row">{label}</span>
            {columns.map((h) => {
              const value = at(index + 1, h);
              return (
                <button key={`${label}-${h}`} className="heat-cell"
                        style={{ background: shade(value) }}
                        onMouseEnter={() => setHover({ dow: index + 1, hour: h, value })}
                        onMouseLeave={() => setHover(null)}
                        aria-label={`${label} ${h}:00 — ${value} занятых часов`} />
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="heat-legend">
        <span className="muted">меньше</span>
        {RAMP.map((token) => <i key={token} style={{ background: `var(${token})` }} />)}
        <span className="muted">больше</span>
        {hover && (
          <strong>
            {DOW[hover.dow - 1]} {hover.hour}:00 — {hover.value} занятых часов
          </strong>
        )}
      </div>
    </div>
  );
}

/**
 * Горизонтальные полосы с подписью значения рядом.
 * Величина, а не идентичность, поэтому один цвет: разные цвета намекали бы
 * на несуществующие категории.
 */
export function BarList({ items, total }: {
  items: { label: string; value: number; note?: string }[];
  total?: number;
}) {
  if (items.length === 0) return <div className="empty">Нет данных за период</div>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="barlist">
      {items.map((item) => (
        <div className="bar-row" key={item.label}>
          <span className="bar-label" title={item.label}>{item.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} />
          </span>
          <span className="bar-value">
            {formatTenge(item.value)}
            {total ? <em>{Math.round((item.value / total) * 100)}%</em> : null}
            {item.note ? <em>{item.note}</em> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Способы оплаты — здесь цвет несёт идентичность, поэтому подписи обязательны. */
export function MethodSplit({ items }: { items: { method: string; total: number; count: number }[] }) {
  const LABEL: Record<string, string> = { cash: "Наличные", card: "Карта", transfer: "Перевод", subscription: "Абонемент" };
  const total = items.reduce((a, i) => a + i.total, 0);
  if (total === 0) return <div className="empty">Платежей не было</div>;
  return (
    <div className="methods">
      <div className="method-bar">
        {items.map((item, index) => (
          <span key={item.method} className={`method-seg s${index + 1}`}
                style={{ width: `${(item.total / total) * 100}%` }} />
        ))}
      </div>
      <div className="method-legend">
        {items.map((item, index) => (
          <span key={item.method}>
            <i className={`swatch s${index + 1}`} />
            {LABEL[item.method] ?? item.method}
            <strong>{formatTenge(item.total)}</strong>
            <em>{Math.round((item.total / total) * 100)}%</em>
          </span>
        ))}
      </div>
    </div>
  );
}
