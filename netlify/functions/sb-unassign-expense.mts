import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import * as xero from "./lib/xero";
import { parseUnassignRequest, unassignExpense } from "./lib/clearing";
import { checkPairing } from "./lib/environment";

// Called by WareHouse's Undo after assigning a cost on 640 to a customer. Removes that one link, and only while the cost
// is still waiting to be invoiced.
export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  const parsed = parseUnassignRequest(await req.json().catch(() => null));
  if (!parsed) return new Response(JSON.stringify({ ok: false, error: "The cost or its assignment is missing." }), { status: 400, headers: { "Content-Type": "application/json" } });

  const result = await unassignExpense(
    {
      env: (name) => Netlify.env.get(name),
      getAccessToken: xero.getAccessToken,
      getOrganisationName: xero.getOrganisationName,
      linksForSource: xero.linkedTransactionsForSource,
      deleteLink: xero.deleteLinkedTransaction,
    },
    parsed,
    checkPairing,
  );
  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
};

export const config: Config = {
  path: "/supabase/unassign-expense",
};
