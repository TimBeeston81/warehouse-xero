import { test } from "node:test";
import assert from "node:assert/strict";
import { assignExpense, parseAssignRequest, readClearing, summariseClearing, type AssignDeps } from "../netlify/functions/lib/clearing";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const spend = (n: number, amount: number, over: Record<string, unknown> = {}, account = "640") => ({
  BankTransactionID: ID(n), Type: "SPEND", Status: "AUTHORISED", DateString: "2026-07-21T00:00:00", Contact: { Name: "Make.com" },
  LineItems: [{ LineItemID: ID(1000 + n), AccountCode: account, Description: `Make.com / Therapy & Education / ${n}`, LineAmount: amount }],
  ...over,
});
const sale = (n: number, number: string, lines: { id: number; amount: number; account?: string }[], status = "PAID") => ({
  InvoiceID: ID(5000 + n), Type: "ACCREC", InvoiceNumber: number, Status: status, DateString: "2026-07-14T00:00:00",
  Contact: { ContactID: ID(9001), Name: "Therapy and Education Limited" },
  LineItems: lines.map((l) => ({ LineItemID: ID(l.id), AccountCode: l.account ?? "640", Description: "Make.com", LineAmount: l.amount })),
});
const link = (source: number, status: string, target?: number) => ({
  LinkedTransactionID: ID(7000 + source), Type: "BILLABLEEXPENSE", SourceTransactionID: ID(source), SourceLineItemID: ID(1000 + source),
  SourceTransactionTypeCode: "SPEND", ContactID: ID(9001), Status: status, TargetTransactionID: target ? ID(5000 + target) : undefined, TargetLineItemID: target ? ID(6000 + source) : undefined,
});

test("costs on 640 carry their assignment; anything coded elsewhere is ignored", () => {
  const s = summariseClearing({
    bank: [spend(1, 13.79), spend(2, 7.93), spend(3, 99, {}, "463"), spend(4, 5, { Status: "DELETED" })],
    bills: [],
    sales: [sale(1, "INV-0087", [{ id: 6001, amount: 13.79 }, { id: 6100, amount: 500, account: "200" }])],
    linked: [link(1, "BILLED", 1), link(2, "APPROVED")],
  });
  assert.deepEqual(s.costs.map((c) => [c.amountPence, c.link?.status ?? null]), [[1379, "BILLED"], [793, "APPROVED"]]);
  assert.equal(s.costs[0].link?.invoiceId, ID(5001));
  assert.deepEqual(s.sales.map((x) => [x.number, x.amountPence, x.linked]), [["INV-0087", 1379, true]]);
  // 13.79 + 7.93 spent, 13.79 invoiced: 7.93 is left in the account.
  assert.equal(s.balancePence, 793);
  assert.deepEqual(s.contactIds, [ID(9001)]);
});

test("a cost with no assignment is the one to catch; a voided link counts as none", () => {
  const s = summariseClearing({ bank: [spend(1, 22), spend(2, 1.98)], bills: [], sales: [], linked: [link(2, "VOIDED")] });
  assert.deepEqual(s.costs.map((c) => c.link), [null, null]);
});

test("refunds reduce the account; draft invoices and bills don't count towards the balance until approved", () => {
  const s = summariseClearing({
    bank: [spend(1, 30), spend(2, 4, { Type: "RECEIVE" })],
    bills: [{ InvoiceID: ID(3), Type: "ACCPAY", Status: "DRAFT", DateString: "2026-07-22T00:00:00", Contact: { Name: "Google" }, LineItems: [{ LineItemID: ID(1003), AccountCode: "640", LineAmount: 22 }] }],
    sales: [sale(1, "", [{ id: 6001, amount: 30 }], "DRAFT")],
    linked: [],
  });
  assert.deepEqual(s.costs.map((c) => [c.source, c.amountPence, c.posted, c.link]), [["SPEND", 3000, true, null], ["SPEND", -400, true, null], ["ACCPAY", 2200, false, null]]);
  assert.equal(s.balancePence, 2600);
  assert.equal(s.sales[0].status, "DRAFT");
});

test("invoice lines on 640 with no cost behind them are kept, marked unlinked", () => {
  const s = summariseClearing({ bank: [], bills: [], sales: [sale(1, "INV-0001", [{ id: 6001, amount: 2355.77 }])], linked: [] });
  assert.deepEqual(s.sales.map((x) => [x.number, x.linked]), [["INV-0001", false]]);
  assert.equal(s.balancePence, -235577);
});

test("reading asks each list until a page comes back short, and looks up only the names it doesn't already have", async () => {
  const asked: string[] = [];
  const snapshot = await readClearing({
    bankPage: async (p) => { asked.push(`bank${p}`); return p === 1 ? Array.from({ length: 100 }, (_, i) => spend(i + 10, 1, {}, "463")) : [spend(1, 2)]; },
    billsPage: async () => [],
    salesPage: async () => [],
    linkedPage: async () => [{ ...link(1, "APPROVED"), ContactID: ID(9002) }],
    contactNames: async (ids) => { asked.push(`names:${ids.length}`); return { [ID(9002)]: "Trauma Informed Schools & Communities CIC" }; },
  });
  assert.deepEqual(asked, ["bank1", "bank2", "names:1"]);
  assert.equal(snapshot.costs.length, 1);
  assert.equal(snapshot.contacts[ID(9002)], "Trauma Informed Schools & Communities CIC");
});

test("an assignment request needs three Xero ids", () => {
  assert.equal(parseAssignRequest({ sourceTransactionId: ID(1), sourceLineItemId: ID(2) }), null);
  assert.equal(parseAssignRequest({ sourceTransactionId: "x", sourceLineItemId: ID(2), contactId: ID(3) }), null);
  assert.deepEqual(parseAssignRequest({ sourceTransactionId: ID(1), sourceLineItemId: ID(2), contactId: ID(3) }), { sourceTransactionId: ID(1), sourceLineItemId: ID(2), contactId: ID(3) });
});

function assignDeps(over: Partial<AssignDeps> = {}): AssignDeps & { made: unknown[] } {
  const made: unknown[] = [];
  return {
    made,
    env: () => "https://ldfusqzcrcidkqpgqpep.supabase.co",
    getAccessToken: async () => "token",
    getOrganisationName: async () => "Timothy Beeston",
    findSourceLine: async () => ({ accountCode: "640", spend: true }),
    linksForSource: async () => [],
    createLink: async (req) => { made.push(req); return { LinkedTransactionID: ID(77), Status: "APPROVED" }; },
    ...over,
  };
}
const req = { sourceTransactionId: ID(1), sourceLineItemId: ID(1001), contactId: ID(9001) };
const pairOk = () => null;

test("assigning makes one link, for a line still coded 640 and not already assigned", async () => {
  const deps = assignDeps();
  assert.deepEqual(await assignExpense(deps, req, pairOk), { ok: true, linkId: ID(77), status: "APPROVED" });
  assert.deepEqual(deps.made, [req]);
});

test("assigning refuses a recoded line, a refund, a line already assigned, and the wrong pairing, making nothing", async () => {
  for (const [over, pairing, why] of [
    [{ findSourceLine: async () => ({ accountCode: "463", spend: true }) }, pairOk, /coded 463/],
    [{ findSourceLine: async () => ({ accountCode: "640", spend: false }) }, pairOk, /Only money spent/],
    [{ findSourceLine: async () => null }, pairOk, /no such line/],
    [{ linksForSource: async () => [{ SourceLineItemID: ID(1001), Status: "APPROVED" }] }, pairOk, /already assigned/],
    [{}, () => "A non-production database is connected to a real Xero organisation", /non-production/],
  ] as const) {
    const deps = assignDeps(over as Partial<AssignDeps>);
    const result = await assignExpense(deps, req, pairing as () => string | null);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, why);
    assert.equal(deps.made.length, 0);
  }
});

test("a voided link on the same line doesn't block assigning again", async () => {
  const deps = assignDeps({ linksForSource: async () => [{ SourceLineItemID: ID(1001), Status: "VOIDED" }] });
  assert.equal((await assignExpense(deps, req, pairOk)).ok, true);
});
