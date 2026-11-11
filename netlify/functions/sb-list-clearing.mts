import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import * as xero from "./lib/xero";
import { readClearing } from "./lib/clearing";

// Called by WareHouse's Recharges page and its weekly check. Read-only: every cost on the clearing account (640), whether
// it has been assigned to a customer and invoiced, and every sales-invoice line coded 640. It writes nothing.
export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  try {
    const token = await xero.getAccessToken();
    const snapshot = await readClearing({
      bankPage: (page) => xero.listBankTransactionsPage(page, token),
      billsPage: (page) => xero.listAllBillsPage(page, token),
      salesPage: (page) => xero.listSalesInvoicesPage(page, token),
      linkedPage: (page) => xero.listLinkedTransactionsPage(page, token),
      contactNames: (ids) => xero.contactNames(ids, token),
    }, Netlify.env.get("XERO_CLEARING_ACCOUNT_CODE") || undefined);
    return new Response(JSON.stringify({ ok: true, snapshot }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message.slice(0, 400) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
};

export const config: Config = {
  path: "/supabase/list-clearing",
};
