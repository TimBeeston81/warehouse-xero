import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import * as xero from "./lib/xero";
import { parseSpendRequest, postSpend } from "./lib/spend-money";

// Called by WareHouse when Tim presses Post on a purchase. Writes one Spend Money entry to Xero.
export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  const parsed = parseSpendRequest(await req.json().catch(() => null));
  if (!parsed) return new Response(JSON.stringify({ ok: false, error: "The purchase is missing something Xero needs." }), { status: 400, headers: { "Content-Type": "application/json" } });

  const result = await postSpend(
    {
      env: (name) => Netlify.env.get(name),
      getAccessToken: xero.getAccessToken,
      getOrganisationName: xero.getOrganisationName,
      findContactByName: xero.findContactByName,
      createContact: xero.createContact,
      listSpendBetween: xero.listSpendBetween,
      listBillsBetween: xero.listBillsBetween,
      createSpendMoney: xero.createSpendMoney,
    },
    parsed,
  );
  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
};

export const config: Config = {
  path: "/supabase/post-purchase",
};
