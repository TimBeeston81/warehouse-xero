// A real run of "Assign expenses to a customer" against your Xero DEMO COMPANY, from this machine: makes one Spend Money
// entry, assigns its line to a customer through the same code as the assign-expense function, and reads it back through
// the list-clearing code. Refuses anything that isn't a Demo Company. The demo company keeps the entry; harmless there.
//   npx tsx scripts/demo-assign.mts
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
(globalThis as any).Netlify = { env: { get: (name: string) => process.env[name] } };
if (!existsSync(new URL("../.env.demo", import.meta.url))) { console.error("Missing .env.demo."); process.exit(2); }
process.loadEnvFile(new URL("../.env.demo", import.meta.url).pathname);
const xero = await import("../netlify/functions/lib/xero");
const { assignExpense, readClearing } = await import("../netlify/functions/lib/clearing");
const { checkPairing } = await import("../netlify/functions/lib/environment");

const token = await xero.getAccessToken();
const name = await xero.getOrganisationName(token);
if (!/^demo company\b/i.test(name)) { console.error(`Refusing: the connection is to "${name}", not a demo company.`); process.exit(2); }
console.log("organisation:", name);

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`https://api.xero.com/api.xro/2.0${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
};
const accounts = (await api("GET", "/Accounts")).Accounts as any[];
const bank = accounts.find((a) => a.Type === "BANK" && a.Status === "ACTIVE");
const expense = accounts.find((a) => a.Code === "640") ?? accounts.find((a) => a.Class === "EXPENSE" && a.Status === "ACTIVE" && a.Code);
const customer = ((await api("GET", `/Contacts?where=${encodeURIComponent("IsCustomer==true")}&page=1`)).Contacts as any[])[0];
console.log("bank:", bank?.Name, "| cost account:", expense?.Code, expense?.Name, "| customer:", customer?.Name);

const made = (await api("PUT", "/BankTransactions", { BankTransactions: [{ Type: "SPEND", Contact: { Name: "ZZ-WRITE-TEST Supplier" }, BankAccount: { AccountID: bank.AccountID }, Date: new Date().toISOString().slice(0, 10), LineAmountTypes: "NoTax", Reference: `recharge test ${randomUUID().slice(0, 8)}`, LineItems: [{ Description: "ZZ-WRITE-TEST recharge", Quantity: 1, UnitAmount: 12.34, AccountCode: expense.Code, TaxType: "NONE" }] }] })).BankTransactions[0];
const line = made.LineItems[0];
console.log("spend money:", made.BankTransactionID, "line", line.LineItemID);

const deps = { env: () => "https://notproduction.supabase.co", getAccessToken: async () => token, getOrganisationName: xero.getOrganisationName, findSourceLine: xero.findSourceLine, linksForSource: xero.linkedTransactionsForSource, createLink: xero.createLinkedTransaction };
const req = { sourceTransactionId: made.BankTransactionID, sourceLineItemId: line.LineItemID, contactId: customer.ContactID };
console.log("assign:", JSON.stringify(await assignExpense(deps, req, checkPairing, expense.Code)));
console.log("assign again:", JSON.stringify(await assignExpense(deps, req, checkPairing, expense.Code)));

const snap = await readClearing({
  bankPage: (p) => xero.listBankTransactionsPage(p, token), billsPage: (p) => xero.listAllBillsPage(p, token), salesPage: (p) => xero.listSalesInvoicesPage(p, token),
  linkedPage: (p) => xero.listLinkedTransactionsPage(p, token), contactNames: (ids) => xero.contactNames(ids, token),
}, expense.Code);
const back = snap.costs.find((c) => c.lineItemId === line.LineItemID);
console.log("read back:", JSON.stringify({ amountPence: back?.amountPence, link: back?.link && { status: back.link.status, customer: snap.contacts[back.link.contactId] } }));
