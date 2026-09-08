export type Tile = {
  resourceId: string;
  name: string;
  typeName: string | null;
  capacity: number;
  bufferMinutes: number;
  defaultServiceId: string | null;
  state: "free" | "booked" | "busy" | "ending" | "overtime";
  visit: {
    id: string; startedAt: string; plannedEnd: string; plannedMinutes: number;
    extensionMinutes: number; guestsCount: number; serviceName: string;
    orderId: string; customerName: string | null; customerPhone: string | null;
    minutesLeft: number; timeTotal: number; extrasTotal: number; dueTotal: number;
  } | null;
  upcoming: {
    id: string; starts_at: string; ends_at: string; guests_count: number;
    customer_id: string | null; service_id: string | null; customer_name: string | null;
  } | null;
};

export type Board = {
  serverTime: string;
  shift: { id: string; opened_at: string; opening_cash: number; opened_by_name: string } | null;
  resources: Tile[];
  bookings: unknown[];
  unpaidOrders: {
    id: string; total: number; paid_total: number;
    resource_name: string | null; customer_name: string | null;
  }[];
};

export type OrderDetails = {
  order: { id: string; total: number; paid_total: number; status: string };
  items: { id: string; kind: string; name_snapshot: string; qty: number; total: number }[];
  payments: { id: string; method: string; amount: number }[];
};

export type Catalog = {
  services: { id: string; name: string; kind: string; unit: string; default_duration_min: number | null }[];
  products: { id: string; name: string; category: string | null; price: number; stock: number }[];
  resources: { id: string; name: string; default_service_id: string | null }[];
  branch: { id: string; name: string; timezone: string };
};

export type VisitDetails = {
  visit: { id: string; started_at: string; planned_minutes: number; guests_count: number;
           resource_name: string; service_name: string; customer_name: string | null; order_id: string };
  order: { id: string; total: number; paid_total: number; status: string };
  items: { id: string; kind: string; name_snapshot: string; qty: number; total: number }[];
  timeQuote: {
    actualMinutes: number; billedMinutes: number; total: number; minimumApplied: boolean;
    segments: { from: string; to: string; minutes: number; ratePerHour: number; amount: number }[];
  };
  dueTotal: number;
  serverTime: string;
  subscriptions: {
    id: string; planName: string; type: "visits" | "hours" | "unlimited_period";
    balance: number; validTo: string; coverableMinutes: number | null;
  }[];
};
