import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import { downloadAttachment, getAccessToken } from "./lib/xero";

// The bytes of one attached file, for WareHouse to put in Drive. Read-only.
const ID = /^[0-9a-f-]{36}$/i;

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as { source?: unknown; objectId?: unknown; attachmentId?: unknown } | null;
  const owner = body?.source === "bill" ? "Invoices" : body?.source === "spend" ? "BankTransactions" : null;
  if (!owner || typeof body?.objectId !== "string" || !ID.test(body.objectId) || typeof body?.attachmentId !== "string" || !ID.test(body.attachmentId)) {
    return new Response(JSON.stringify({ ok: false, error: "source, objectId and attachmentId are required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  try {
    const file = await downloadAttachment(owner, body.objectId, body.attachmentId, await getAccessToken());
    return new Response(file.bytes, { status: 200, headers: { "Content-Type": file.contentType, "Cache-Control": "private, no-store" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message.slice(0, 400) }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
};

export const config: Config = {
  path: "/supabase/get-bill-file",
};
