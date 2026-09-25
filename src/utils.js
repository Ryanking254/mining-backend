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
