const REDIS_URL = process.env.REDIS_URL;
const REDIS_TOKEN = process.env.REDIS_TOKEN;
const KEY = "active_pairs";

const DEFAULT_PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(`${REDIS_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    cache: "no-store"
  });
  if (!res.ok) return null;
  return (await res.json()).result;
}

async function redisSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/${key}/${encodeURIComponent(value)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
}

export async function getActivePairs() {
  const raw = await redisGet(KEY);
  if (!raw) return DEFAULT_PAIRS;
  try { return JSON.parse(raw); } catch { return DEFAULT_PAIRS; }
}

export async function addPair(symbol) {
  const list = await getActivePairs();
  const up = [...new Set([...list, symbol.toUpperCase()])];
  await redisSet(KEY, JSON.stringify(up));
  return up;
}

export async function removePair(symbol) {
  const list = await getActivePairs();
  const filtered = list.filter(x => x !== symbol.toUpperCase());
  await redisSet(KEY, JSON.stringify(filtered));
  return filtered;
}
