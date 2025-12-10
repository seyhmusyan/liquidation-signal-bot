export const config = { runtime: "nodejs" };

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler(req, res) {
  try {
    const base = process.env.VERCEL_URL;
    if (!base) {
      return res.status(200).json({ ok: false, reason: "VERCEL_URL missing" });
    }

    // 4 calls per minute ~ every 15s
    for (let i = 0; i < 4; i++) {
      await fetch(base + "/api/signal");
      if (i < 3) await wait(15000);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("tick error", e);
    res.status(500).json({ error: e.toString() });
  }
}
