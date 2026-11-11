// Billable expenses: costs Tim pays for a client, coded to the clearing account (640, "Billable Expenses Clearing") until
// they are invoiced on. In Xero each one is assigned to a customer with "Assign expenses to a customer", which Xero's API
// calls a linked transaction. This boils what Xero holds down to what WareHouse shows: every cost on 640 and whether it is
// assigned and invoiced, and every sales-invoice line coded 640. Pure: it is given the raw lists. The shape is the
// contract with WareHouse's lib/recharges.ts.

export const CLEARING_ACCOUNT = "640";

export interface ClearingLink {
  id: string;
  // APPROVED: assigned, not invoiced yet. ONDRAFT: on a draft invoice. BILLED: on an approved invoice. DRAFT: the cost
  // itself is still a draft. VOIDED: no longer counts.
  status: string;
  contactId: string;
  invoiceId: string | null;
  invoiceLineId: string | null;
}

export interface ClearingCost {
  source: "SPEND" | "ACCPAY";
  transactionId: string;
  lineItemId: string;
  date: string | null;
  supplier: string;
  description: string;
  // A refund (money received back, coded 640) is negative.
  amountPence: number;
  // In the ledger: every Spend Money entry, and a bill once approved. A draft bill isn't, so it isn't in the balance.
  posted: boolean;
  link: ClearingLink | null;
}

export interface ClearingSale {
  invoiceId: string;
  number: string;
  date: string | null;
  status: string;
  contactId: string;
  customer: string;
  lineItemId: string;
  description: string;
  amountPence: number;
  // Whether a cost is linked to this line (Xero's own "add billable expenses" does that).
  linked: boolean;
}

export interface ClearingSnapshot {
  account: string;
  costs: ClearingCost[];
  sales: ClearingSale[];
  // Customer names for every contact a link points at, so WareHouse can show who even without a matching organisation.
  contacts: Record<string, string>;
  // What the account holds: posted costs less posted invoice lines. Drafts aren't in the ledger, so they don't count.
  balancePence: number;
}

const pence = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const text = (v: unknown) => String(v ?? "").trim();

function day(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const net = value.match(/^\/Date\((-?\d+)([+-]\d{4})?\)\/$/);
  const d = net ? new Date(Number(net[1])) : new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const POSTED_DOC = new Set(["AUTHORISED", "PAID"]);

export function summariseClearing(raw: { bank: any[]; bills: any[]; sales: any[]; linked: any[] }, account = CLEARING_ACCOUNT): Omit<ClearingSnapshot, "contacts"> & { contactIds: string[] } {
  const links = new Map<string, ClearingLink>();
  const targeted = new Set<string>();
  for (const l of raw.linked) {
    if (text(l.Type) && text(l.Type) !== "BILLABLEEXPENSE") continue;
    const status = text(l.Status);
    const link: ClearingLink = {
      id: text(l.LinkedTransactionID),
      status,
      contactId: text(l.ContactID),
      invoiceId: text(l.TargetTransactionID) || null,
      invoiceLineId: text(l.TargetLineItemID) || null,
    };
    if (status === "VOIDED") continue;
    links.set(text(l.SourceLineItemID), link);
    if (link.invoiceLineId) targeted.add(link.invoiceLineId);
  }

  const costs: ClearingCost[] = [];
  let balance = 0;
  for (const b of raw.bank) {
    const type = text(b.Type);
    if (text(b.Status) === "DELETED" || !(type === "SPEND" || type === "RECEIVE")) continue;
    for (const line of b.LineItems ?? []) {
      if (text(line.AccountCode) !== account) continue;
      const amount = pence(line.LineAmount) * (type === "RECEIVE" ? -1 : 1);
      balance += amount;
      costs.push({
        source: "SPEND",
        transactionId: text(b.BankTransactionID),
        lineItemId: text(line.LineItemID),
        date: day(b.DateString ?? b.Date),
        supplier: text(b.Contact?.Name),
        description: text(line.Description),
        amountPence: amount,
        posted: true,
        // Only money spent can be assigned to a customer; a refund just reduces what's there.
        link: type === "SPEND" ? links.get(text(line.LineItemID)) ?? null : null,
      });
    }
  }
  for (const b of raw.bills) {
    const status = text(b.Status);
    if (text(b.Type) !== "ACCPAY" || !(POSTED_DOC.has(status) || status === "DRAFT" || status === "SUBMITTED")) continue;
    for (const line of b.LineItems ?? []) {
      if (text(line.AccountCode) !== account) continue;
      const amount = pence(line.LineAmount);
      if (POSTED_DOC.has(status)) balance += amount;
      costs.push({
        source: "ACCPAY",
        transactionId: text(b.InvoiceID),
        lineItemId: text(line.LineItemID),
        date: day(b.DateString ?? b.Date),
        supplier: text(b.Contact?.Name),
        description: text(line.Description),
        amountPence: amount,
        posted: POSTED_DOC.has(status),
        link: links.get(text(line.LineItemID)) ?? null,
      });
    }
  }

  const sales: ClearingSale[] = [];
  for (const s of raw.sales) {
    const status = text(s.Status);
    if (text(s.Type) && text(s.Type) !== "ACCREC") continue;
    if (!(POSTED_DOC.has(status) || status === "DRAFT" || status === "SUBMITTED")) continue;
    for (const line of s.LineItems ?? []) {
      if (text(line.AccountCode) !== account) continue;
      const amount = pence(line.LineAmount);
      if (POSTED_DOC.has(status)) balance -= amount;
      sales.push({
        invoiceId: text(s.InvoiceID),
        number: text(s.InvoiceNumber),
        date: day(s.DateString ?? s.Date),
        status,
        contactId: text(s.Contact?.ContactID),
        customer: text(s.Contact?.Name),
        lineItemId: text(line.LineItemID),
        description: text(line.Description),
        amountPence: amount,
        linked: targeted.has(text(line.LineItemID)),
      });
    }
  }

  costs.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.supplier.localeCompare(b.supplier));
  sales.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.number.localeCompare(b.number));
  const contactIds = [...new Set(costs.map((c) => c.link?.contactId).filter((id): id is string => !!id))];
  return { account, costs, sales, balancePence: balance, contactIds };
}

// Xero gives 100 a page and doesn't say how many pages there are, so ask until one comes back short.
export async function allPages(fetchPage: (page: number) => Promise<any[]>, what: string, maxPages = 40): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await fetchPage(page);
    out.push(...rows);
    if (rows.length < 100) return out;
  }
  throw new Error(`More than ${maxPages * 100} ${what}: stopped rather than keep asking Xero.`);
}

export interface ClearingDeps {
  bankPage(page: number): Promise<any[]>;
  billsPage(page: number): Promise<any[]>;
  salesPage(page: number): Promise<any[]>;
  linkedPage(page: number): Promise<any[]>;
  contactNames(ids: string[]): Promise<Record<string, string>>;
}

export async function readClearing(deps: ClearingDeps, account = CLEARING_ACCOUNT): Promise<ClearingSnapshot> {
  // Four separate lists, asked for side by side (each one page at a time) to stay well inside the function's time limit.
  const [bank, bills, sales, linked] = await Promise.all([
    allPages(deps.bankPage, "bank transactions"),
    allPages(deps.billsPage, "bills"),
    allPages(deps.salesPage, "sales invoices"),
    allPages(deps.linkedPage, "billable expenses"),
  ]);
  const { contactIds, ...snapshot } = summariseClearing({ bank, bills, sales, linked }, account);
  const known: Record<string, string> = {};
  for (const s of snapshot.sales) if (s.contactId && s.customer) known[s.contactId] = s.customer;
  const missing = contactIds.filter((id) => !known[id]);
  const looked = missing.length ? await deps.contactNames(missing) : {};
  return { ...snapshot, contacts: { ...known, ...looked } };
}

// --- Assigning a cost to a customer, as "Assign expenses to a customer" does in Xero. ---

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AssignRequest {
  sourceTransactionId: string;
  sourceLineItemId: string;
  contactId: string;
}

export function parseAssignRequest(body: any): AssignRequest | null {
  const req = { sourceTransactionId: text(body?.sourceTransactionId), sourceLineItemId: text(body?.sourceLineItemId), contactId: text(body?.contactId) };
  return UUID.test(req.sourceTransactionId) && UUID.test(req.sourceLineItemId) && UUID.test(req.contactId) ? req : null;
}

export interface AssignDeps {
  env(name: string): string | undefined;
  getAccessToken(): Promise<string>;
  getOrganisationName(token: string): Promise<string>;
  // The line as Xero holds it now (null if there is no such line), so only a line coded 640 is ever assigned.
  findSourceLine(transactionId: string, lineItemId: string, token: string): Promise<{ accountCode: string; spend: boolean } | null>;
  linksForSource(transactionId: string, token: string): Promise<any[]>;
  createLink(req: AssignRequest, token: string): Promise<any>;
}

export type AssignResult = { ok: true; linkId: string; status: string } | { ok: false; error: string };

export async function assignExpense(deps: AssignDeps, req: AssignRequest, checkPairing: (supabaseUrl: string | undefined, orgName: string) => string | null, account = CLEARING_ACCOUNT): Promise<AssignResult> {
  try {
    const token = await deps.getAccessToken();
    const pairing = checkPairing(deps.env("SUPABASE_URL"), await deps.getOrganisationName(token));
    if (pairing) return { ok: false, error: pairing };
    const line = await deps.findSourceLine(req.sourceTransactionId, req.sourceLineItemId, token);
    if (!line) return { ok: false, error: "Xero has no such line any more. Refresh the page." };
    if (line.accountCode !== account) return { ok: false, error: `That line is coded ${line.accountCode || "to nothing"} in Xero now, not ${account}. Refresh the page.` };
    if (!line.spend) return { ok: false, error: "Only money spent can be assigned to a customer." };
    const existing = (await deps.linksForSource(req.sourceTransactionId, token)).find((l) => text(l.SourceLineItemID) === req.sourceLineItemId && text(l.Status) !== "VOIDED");
    if (existing) return { ok: false, error: "It’s already assigned to a customer in Xero. Refresh the page." };
    const made = await deps.createLink(req, token);
    return { ok: true, linkId: text(made?.LinkedTransactionID), status: text(made?.Status) || "APPROVED" };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 400) };
  }
}
