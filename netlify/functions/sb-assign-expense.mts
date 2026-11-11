import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import * as xero from "./lib/xero";
import { assignExpense, parseAssignRequest } from "./lib/clearing";
import { checkPairing } from "./lib/environment";

// Called by WareHouse when Tim picks a customer for a cost on 640 that hasn't been assigned. Does what "Assign expenses to
// a customer" does in Xero: one linked transaction, nothing else. Refuses a line that isn't coded 640 or is already assigned.
export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  const parsed = parseAssignRequest(await req.json().catch(() => null));
  if (!parsed) return new Response(JSON.stringify({ ok: false, error: "The cost or the customer is missing." }), { status: 400, headers: { "Content-Type": "application/json" } });

  const result = await assignExpense(
    {
      env: (name) => Netlify.env.get(name),
      getAccessToken: xero.getAccessToken,
      getOrganisationName: xero.getOrganisationName,
      findSourceLine: xero.findSourceLine,
      linksForSource: xero.linkedTransactionsForSource,
      createLink: xero.createLinkedTransaction,
    },
    parsed,
    checkPairing,
    Netlify.env.get("XERO_CLEARING_ACCOUNT_CODE") || undefined,
  );
  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
};

export const config: Config = {
  path: "/supabase/assign-expense",
};
