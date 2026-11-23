import { test } from "node:test";
import assert from "node:assert/strict";
import { listContactNames } from "../netlify/functions/lib/contact-list";

test("contact names are trimmed, blanks dropped, kept once whatever the case, and sorted", async () => {
  const names = await listContactNames(async () => [{ Name: " AgileBits Inc. " }, { Name: "" }, { Name: "agilebits inc." }, { Name: "Netlify" }, { Name: "adobe" }, {}]);
  assert.deepEqual(names, ["adobe", "AgileBits Inc.", "Netlify"]);
});

test("pages are asked for until one comes back short, and a runaway is stopped", async () => {
  const asked: number[] = [];
  const page = (p: number) => Array.from({ length: 100 }, (_, i) => ({ Name: `Supplier ${p}-${i}` }));
  const all = await listContactNames(async (p) => { asked.push(p); return p < 3 ? page(p) : [{ Name: "Last" }]; });
  assert.equal(all.length, 201);
  assert.deepEqual(asked, [1, 2, 3]);
  await assert.rejects(listContactNames(async (p) => page(p), 2), /More than 200 contacts/);
});
