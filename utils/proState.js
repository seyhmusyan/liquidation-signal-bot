// utils/proState.js
const mem = globalThis.__liqbot_mem || (globalThis.__liqbot_mem = new Map());

export function getState(key) {
  return mem.get(key) || null;
}

export function setState(key, value) {
  mem.set(key, value);
}

export function makeKey(symbol) {
  return `state:${symbol}`;
}
