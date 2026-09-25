/** Wrap async route handlers so errors hit the central error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export function notFound(message = 'Not found') {
  const err = new Error(message);
  err.status = 404;
  return err;
}

export const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ---- Mandatory authenticator (TOTP) grace period ---- */
// Accounts must enable the authenticator app within TWOFA_GRACE_DAYS of
// creation. Keep in sync with the frontend grace helper (VITE_TWOFA_GRACE_DAYS).
export function getTwofaGraceDays() {
  const n = Number(process.env.TWOFA_GRACE_DAYS ?? 7);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

/** Parse DB timestamps defensively (mysql dateStrings can be 'YYYY-MM-DD HH:mm:ss'). */
export function parseDbDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  let d = new Date(s);
  if (Number.isNaN(d.getTime()) && s.includes(' ')) {
    d = new Date(s.replace(' ', 'T'));
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Totp grace state for a user row ({ created_at, twofa_enabled }).
 * Returns { enabled, required, graceDays, deadline (ISO|null), daysLeft, overdue }.
 */
export function twofaGraceState(row, now = new Date()) {
  const enabled = !!row?.twofa_enabled;
  const graceDays = getTwofaGraceDays();
  if (enabled) {
    return { enabled: true, required: false, graceDays, deadline: null, daysLeft: 0, overdue: false };
  }
  const created = parseDbDate(row?.created_at);
  const deadline = created ? new Date(created.getTime() + graceDays * 86400000) : null;
  const daysLeft = deadline ? Math.ceil((deadline.getTime() - now.getTime()) / 86400000) : graceDays;
  return {
    enabled: false,
    required: true,
    graceDays,
    deadline: deadline ? deadline.toISOString() : null,
    daysLeft: Math.max(daysLeft, 0),
    overdue: deadline ? now.getTime() > deadline.getTime() : false,
  };
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ---- Row -> API (snake_case DB -> camelCase JSON the React app expects) ---- */

export const mapBatch = (r) => ({
  id: r.id,
  batchNumber: r.batch_number,
  itemName: r.item_name,
  gramsBought: Number(r.grams_bought),
  gramsRemaining: Number(r.grams_remaining),
  pricePerGram: Number(r.price_per_gram),
  totalCost: Number(r.total_cost ?? Number(r.grams_bought) * Number(r.price_per_gram)),
  purchaseDate: r.purchase_date,
  status: r.status,
  createdAt: r.created_at,
});

export const mapSale = (r) => ({
  id: r.id,
  batchId: r.batch_id,
  batchNumber: r.batch_number ?? null,
  gramsSold: Number(r.grams_sold),
  sellingPricePerGram: Number(r.selling_price_per_gram),
  totalSellingPrice: Number(r.total_selling_price),
  profitLoss: Number(r.profit_loss),
  saleDate: r.sale_date,
  createdAt: r.created_at,
});

export const mapLoan = (r) => ({
  id: r.id,
  borrowerName: r.borrower_name,
  amountGiven: Number(r.amount_given),
  amountRepaid: Number(r.amount_repaid),
  dateGiven: r.date_given,
  notes: r.notes,
  status: r.status,
  createdAt: r.created_at,
});

export const mapExpenditure = (r) => ({
  id: r.id,
  amount: Number(r.amount),
  category: r.category,
  description: r.description,
  expenseDate: r.expense_date,
  createdAt: r.created_at,
});

export const mapWithdrawal = (r) => ({
  id: r.id,
  amount: Number(r.amount),
  reason: r.reason,
  withdrawalDate: r.withdrawal_date,
  createdAt: r.created_at,
});
