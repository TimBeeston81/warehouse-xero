import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import { getAccessToken, listAttachments, listBillsPage, listSpendPage } from "./lib/xero";
import { listBillFiles } from "./lib/bill-files";

// Called by WareHouse's daily filing of bills and receipts. Read-only: it lists the files attached to paid bills and to
// reconciled "spend money" transactions changed since the time given, so WareHouse can put them in Drive. It writes nothing.
// The scope names inside the access token (not secret: they are what the Xero app was allowed).
function grantedScopes(token: string): string {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const scope = claims.scope;
    return (Array.isArray(scope) ? scope : String(scope ?? "").split(" ")).filter(Boolean).join(" ") || "none listed";
  } catch {
    return "unreadable";
  }
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as { since?: unknown } | null;
  const since = typeof body?.since === "string" && !isNaN(Date.parse(body.since)) ? new Date(body.since).toUTCString() : null;
  if (!since) return new Response(JSON.stringify({ ok: false, error: "since (a date) is required" }), { status: 400, headers: { "Content-Type": "application/json" } });

  try {
    const token = await getAccessToken();
    // Say which call failed: a 401 on one of them usually means a missing permission (scope) on the Xero app.
    const step = <T,>(what: string, run: () => Promise<T>) => run().catch((err) => { throw new Error(`${what}: ${(err as Error).message}`); });
    let files;
    try {
      files = await listBillFiles({
        bills: (page) => step("Listing paid bills", () => listBillsPage(since, page, token)),
        spend: (page) => step("Listing spend-money transactions", () => listSpendPage(since, page, token)),
        attachments: (source, id) => step(`Listing the attachments of a ${source === "bill" ? "bill" : "spend-money transaction"}`, () => listAttachments(source === "bill" ? "Invoices" : "BankTransactions", id, token)),
      });
    } catch (err) {
      throw new Error(`${(err as Error).message} [permissions the connection has: ${grantedScopes(token)}]`);
    }
    return new Response(JSON.stringify({ ok: true, files }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message.slice(0, 400) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
};

export const config: Config = {
  path: "/supabase/list-bill-files",
};
