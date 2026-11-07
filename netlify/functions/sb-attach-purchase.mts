import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import { attachToSpendMoney, getAccessToken } from "./lib/xero";

// Attaches the receipt to a Spend Money entry just posted. The file is the request's body; the id and name are in the address.
const ID = /^[0-9a-f-]{36}$/i;

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const name = (url.searchParams.get("name") ?? "").replace(/[\\/:*?"<>|#%]+/g, "-").slice(0, 120);
  if (!ID.test(id) || !name) return new Response(JSON.stringify({ ok: false, error: "id and name are required" }), { status: 400, headers: { "Content-Type": "application/json" } });

  try {
    await attachToSpendMoney(id, name, req.headers.get("content-type") ?? "application/octet-stream", await req.arrayBuffer(), await getAccessToken());
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message.slice(0, 400) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
};

export const config: Config = {
  path: "/supabase/attach-purchase",
};
