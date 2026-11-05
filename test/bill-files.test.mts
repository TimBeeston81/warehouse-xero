import { test } from "node:test";
import assert from "node:assert/strict";
import { day, listBillFiles, toBillFiles } from "../netlify/functions/lib/bill-files";

const bill = (n: number, over: Record<string, unknown> = {}) => ({
  InvoiceID: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, InvoiceNumber: `EX-${n}`, Contact: { Name: "Bread Meats Sauce" }, DateString: "2026-07-23T00:00:00",
  HasAttachments: true, UpdatedDateUTC: "/Date(1786025738277+0000)/", ...over,
});
const spend = (n: number, over: Record<string, unknown> = {}) => ({
  BankTransactionID: `11111111-0000-0000-0000-${String(n).padStart(12, "0")}`, Reference: "EJAAWRTL-0017", Contact: { Name: "Make.com" }, DateString: "2026-06-23T00:00:00", HasAttachments: true, ...over,
});
const att = (id: string, name = "Receipt.pdf") => ({ AttachmentID: id, FileName: name, MimeType: "application/pdf", ContentLength: 91409 });

test("a bill's file and a spend-money file are described the same way", () => {
  const [b] = toBillFiles("bill", bill(1), [att("aa")]);
  assert.deepEqual([b.source, b.reference, b.contact, b.date, b.fileName, b.size, b.objectId], ["bill", "EX-1", "Bread Meats Sauce", "2026-07-23", "Receipt.pdf", 91409, bill(1).InvoiceID]);
  const [s] = toBillFiles("spend", spend(1), [att("bb", "Invoice-EJAAWRTL-0017.pdf")]);
  assert.deepEqual([s.source, s.reference, s.contact, s.date, s.objectId], ["spend", "EJAAWRTL-0017", "Make.com", "2026-06-23", spend(1).BankTransactionID]);
});

test("the .NET date format and ISO dates both give a plain day", () => {
  assert.equal(day("/Date(1742860800000+0000)/"), "2025-03-25");
  assert.equal(day("2026-07-23T00:00:00"), "2026-07-23");
  assert.equal(day(undefined), null);
});

test("only objects with attachments are asked for their files, bills and spend both, across pages", async () => {
  const asked: string[] = [];
  const billPages = [Array.from({ length: 100 }, (_, i) => bill(i, { HasAttachments: i === 3 })), [bill(200)]];
  const files = await listBillFiles({
    bills: async (p) => billPages[p - 1] ?? [],
    spend: async (p) => (p === 1 ? [spend(1), spend(2, { HasAttachments: false })] : []),
    attachments: async (source, id) => { asked.push(`${source}:${id}`); return [att(`att-${asked.length}`)]; },
  });
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((f) => f.source), ["bill", "bill", "spend"]);
  assert.equal(asked.length, 3, "no request for an object without attachments");
});

test("a runaway is stopped, not followed", async () => {
  await assert.rejects(listBillFiles({ bills: async () => Array.from({ length: 100 }, (_, i) => bill(i, { HasAttachments: false })), spend: async () => [], attachments: async () => [] }, 3), /More than 300 bills/);
});
