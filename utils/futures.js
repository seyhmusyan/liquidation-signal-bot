const FAPI_BASE = "https://fapi.binance.com";

export async function getFunding(symbol) {
  try {
    const r = await fetch(
      `${FAPI_BASE}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`
    );
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const last = arr[arr.length - 1];
    const fr = Number(last.fundingRate);
    return Number.isFinite(fr) ? fr : null;
  } catch (e) {
    console.error("funding error", symbol, e);
    return null;
  }
}

export async function getOI(symbol) {
  try {
    const r = await fetch(
      `${FAPI_BASE}/fapi/v1/openInterest?symbol=${symbol}`
    );
    if (!r.ok) return null;
    const j = await r.json();
    const oi = Number(j.openInterest);
    return Number.isFinite(oi) ? oi : null;
  } catch (e) {
    console.error("OI error", symbol, e);
    return null;
  }
}

// basic Binance taker long/short, used as first layer if available
export async function getLongShort(symbol) {
  try {
    const r = await fetch(
      `${FAPI_BASE}/futures/data/takerlongshortRatio?symbol=${symbol}&interval=5m&limit=1`
    );
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const row = arr[arr.length - 1];
    const buy = Number(row.buyVol);
    const sell = Number(row.sellVol);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || !sell) return null;
    const ratio = buy / sell;
    return ratio;
  } catch (e) {
    console.error("longShort error", symbol, e);
    return null;
  }
}
