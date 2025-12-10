export const config = { runtime: "nodejs" };

export default async function handler() {
  const base =
    process.env.VERCEL_URL?.startsWith("http")
      ? process.env.VERCEL_URL
      : `https://${process.env.VERCEL_URL}`;

  const url = `${base}/api/signal`;

  for (let i = 0; i < 6; i++) {
    fetch(url).catch(() => {});
    await new Promise(r => setTimeout(r, 10000));
  }

  return new Response("tick ok");
}
