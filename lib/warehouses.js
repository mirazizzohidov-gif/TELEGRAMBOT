// BITO warehouses of Mixpodarok (ids from /warehouse/get-all). Override with env if they change.
export const WAREHOUSES = [
  { key: 'shop', id: process.env.BITO_WH_SHOP || '6a33f0e2e83e793020f386ed', name: "Do'kon", main: true },
  { key: 'sklad', id: process.env.BITO_WH_SKLAD || '6ab93ce30b66e177c1321bbb', name: 'Sklad MIX' },
];
export const whByKey = (k) => WAREHOUSES.find((w) => w.key === k) || null;

// { warehouseId: amount } from a BITO product (empty when BITO gave no per-warehouse data)
export function warehouseAmounts(p) {
  const out = {};
  for (const [id, w] of Object.entries(p?._warehouses || {})) out[id] = Number(w?.amount) || 0;
  return out;
}

// Per-warehouse "ran out" times. A warehouse is marked when its amount drops to 0. On first sight
// (no previous data) only the main warehouse (do'kon) is marked — so "do'konda yo'q, skladda bor"
// shows up at once, while the sklad list fills only from real run-outs (plus fully sold-out items).
export function warehouseOut(prevWh, prevOut, nowWh, now, firstAt) {
  const out = { ...(prevOut || {}) };
  for (const w of WAREHOUSES) {
    if (!(w.id in nowWh)) continue;
    const n = nowWh[w.id];
    const had = prevWh && w.id in prevWh ? prevWh[w.id] : undefined;
    if (n > 0) delete out[w.id];
    else if (out[w.id]) continue;
    else if (had > 0) out[w.id] = now;
    else if (had === undefined && w.main) out[w.id] = firstAt || now;
  }
  return out;
}
