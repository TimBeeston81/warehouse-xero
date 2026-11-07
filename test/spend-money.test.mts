import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicate, parseSpendRequest, postSpend, spendPayload, type SpendDeps, type SpendRequest } from "../netlify/functions/lib/spend-money";
import { PRODUCTION_URL, STAGING_URL } from "./fakes.mts";

const body = { purchaseId: "11111111-1111-4111-8111-111111111111", contactName: "Notion Labs, Inc.", accountCode: "463", bankCode: "601", date: "2026-10-29", amountPence: 2234, description: "Notion Labs: Business plan ($28.80)", reference: "in_1UVu" };
const req = parseSpendRequest(body)!;

function deps(over: Partial<SpendDeps> & { org?: string; url?: string } = {}) {
  const calls: { payload?: Record<string, unknown>; key?: string; created?: string } = {};
  const d: SpendDeps = {
    env: () => over.url ?? PRODUCTION_URL,
    getAccessToken: async () => "tok",
    getOrganisationName: async () => over.org ?? "Timothy Beeston",
    findContactByName: async () => ({ ContactID: "c1" }),
    createContact: async (p) => { calls.created = String(p.Name); return { ContactID: "new" }; },
    listSpendBetween: async () => [],
    listBillsBetween: async () => [],
    createSpendMoney: async (payload, key) => { calls.payload = payload; calls.key = key; return { BankTransactionID: "bt1" }; },
    ...over,
  };
  return { d, calls };
}

test("a request needs everything Xero needs, a real bank account, and a whole number of pence", () => {
  assert.ok(req);
  assert.equal(parseSpendRequest({ ...body, bankCode: "999" }), null);
  assert.equal(parseSpendRequest({ ...body, amountPence: 22.34 }), null);
  assert.equal(parseSpendRequest({ ...body, amountPence: 0 }), null);
  assert.equal(parseSpendRequest({ ...body, date: "29 Oct" }), null);
  assert.equal(parseSpendRequest({ ...body, contactName: " " }), null);
  assert.equal(parseSpendRequest(null), null);
});

test("Spend Money goes in as GBP, unreconciled, with no tax", () => {
  const p = spendPayload(req, "c1") as any;
  assert.deepEqual([p.Type, p.Contact.ContactID, p.BankAccount.Code, p.CurrencyCode, p.LineAmountTypes, p.Status], ["SPEND", "c1", "601", "GBP", "NoTax", "AUTHORISED"]);
  assert.deepEqual([p.LineItems[0].UnitAmount, p.LineItems[0].AccountCode, p.LineItems[0].TaxType], [22.34, "463", "NONE"]);
  assert.equal("IsReconciled" in p, false);
});

test("an entry already in Xero is found by amount or bill number; a different amount isn't", () => {
  assert.match(findDuplicate(req, [], [{ Total: 22.34, InvoiceNumber: "x", Contact: { Name: "Notion" } }])!, /bill for £22.34/);
  assert.match(findDuplicate(req, [], [{ Total: 28.8, InvoiceNumber: "IN_1UVU", Contact: { Name: "Notion" } }])!, /already in Xero/);
  assert.match(findDuplicate(req, [{ Total: 22.34, Contact: { Name: "Notion" }, Status: "AUTHORISED" }], [])!, /bank payment of £22.34/);
  assert.equal(findDuplicate(req, [{ Total: 22.35, Status: "AUTHORISED" }, { Total: 22.34, Status: "DELETED" }], [{ Total: 28.8, InvoiceNumber: "z" }]), null);
});

test("a posted entry carries the purchase id as its idempotency key, and the contact is reused", async () => {
  const { d, calls } = deps();
  assert.deepEqual(await postSpend(d, req), { ok: true, bankTransactionId: "bt1", contactCreated: false });
  assert.equal(calls.key, req.purchaseId);
  assert.equal(calls.created, undefined);
});

test("a supplier new to Xero is created", async () => {
  const { d, calls } = deps({ findContactByName: async () => undefined });
  assert.deepEqual(await postSpend(d, req), { ok: true, bankTransactionId: "bt1", contactCreated: true });
  assert.equal(calls.created, "Notion Labs, Inc.");
});

test("a likely duplicate stops the post, and force goes through", async () => {
  const spend = [{ Total: 22.34, Status: "AUTHORISED", Contact: { Name: "Notion" } }];
  const { d, calls } = deps({ listSpendBetween: async () => spend });
  const first = await postSpend(d, req);
  assert.ok(!first.ok && "duplicate" in first);
  assert.equal(calls.payload, undefined, "nothing was written");
  assert.ok((await postSpend(d, { ...req, force: true } as SpendRequest)).ok);
});

test("staging can never reach the real books, nor production a demo company", async () => {
  const toReal = deps({ url: STAGING_URL });
  const a = await postSpend(toReal.d, req);
  assert.ok(!a.ok && "error" in a && /Refusing/.test(a.error));
  assert.equal(toReal.calls.payload, undefined);
  const toDemo = deps({ org: "Demo Company (UK)" });
  const b = await postSpend(toDemo.d, req);
  assert.ok(!b.ok && "error" in b && /Refusing/.test(b.error));
  assert.equal(toDemo.calls.payload, undefined);
});

test("a failure from Xero is a sentence", async () => {
  const { d } = deps({ createSpendMoney: async () => { throw new Error("Xero API error (400): bad"); } });
  const r = await postSpend(d, req);
  assert.ok(!r.ok && "error" in r && /400/.test(r.error));
});
