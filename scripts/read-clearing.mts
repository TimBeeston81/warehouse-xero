// Read-only: runs the same 640 read as the list-clearing function, from this machine, and prints a summary.
//   XERO_CLIENT_ID=… XERO_CLIENT_SECRET=… npx tsx scripts/read-clearing.mts [out.json]
// Only GET requests. Prints no credentials.
import { writeFileSync } from "node:fs";
(globalThis as any).Netlify = { env: { get: (name: string) => process.env[name] } };
const xero = await import("../netlify/functions/lib/xero");
const { readClearing } = await import("../netlify/functions/lib/clearing");
const started = Date.now();
const token = await xero.getAccessToken();
const s = await readClearing({
  bankPage: (p) => xero.listBankTransactionsPage(p, token),
  billsPage: (p) => xero.listAllBillsPage(p, token),
  salesPage: (p) => xero.listSalesInvoicesPage(p, token),
  linkedPage: (p) => xero.listLinkedTransactionsPage(p, token),
  contactNames: (ids) => xero.contactNames(ids, token),
});
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(s, null, 2));
const by = (f: (c: (typeof s.costs)[number]) => boolean) => s.costs.filter(f);
console.log(JSON.stringify({
  seconds: (Date.now() - started) / 1000,
  costs: s.costs.length, unassigned: by((c) => !c.link).length,
  byStatus: Object.fromEntries([...new Set(s.costs.map((c) => c.link?.status ?? "none"))].map((k) => [k, by((c) => (c.link?.status ?? "none") === k).length])),
  saleLines: s.sales.length, unlinkedSaleLines: s.sales.filter((x) => !x.linked).length,
  balancePence: s.balancePence, contacts: Object.values(s.contacts),
}, null, 2));
