export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const url = process.env.VERCEL_URL;
    if (!url) return res.json({ ok:false, reason:"VERCEL_URL missing" });

    await fetch(url + "/api/signal");
    res.json({ ok:true });
  } catch(e){
    res.status(500).json({ error:e.toString() });
  }
}
