export const config = { runtime: "nodejs18.x" };

export default async function handler(req, res) {
  try {
    const base = process.env.VERCEL_URL
      ? (process.env.VERCEL_URL.startsWith("http")
          ? process.env.VERCEL_URL
          : `https://${process.env.VERCEL_URL}`)
      : "";

    if (!base) {
      console.log("VERCEL_URL missing, skipping tick");
      res.status(200).json({ ok: false, reason: "VERCEL_URL missing" });
      return;
    }

    await fetch(`${base}/api/signal`);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("tick error", e);
    res.status(500).json({ error: e.toString() });
  }
}
