// The invoice sync, void and webhook logic for the Supabase version. It is the same
// behaviour as the Airtable functions (sync-invoice-to-xero.mts and friends), written
// against the InvoiceStore interface and an injected Xero client so it can be tested
// without either. Every deliberate behaviour of the originals is kept: the invoice's
// Xero id is saved before a card payment is attempted, a payment failure never costs
// the invoice, and an authorised invoice is never edited.

import { checkPairing } from "./environment";
import type { InvoiceStore, StoredLine, StoredOrganisation, XeroInvoiceFacts } from "./invoice-store";

export interface XeroApi {
  getAccessToken(): Promise<string>;
  getOrganisationName(token: string): Promise<string>;
  getInvoice(id: string, token: string): Promise<any>;
  upsertInvoice(payload: Record<string, unknown>, token: string): Promise<any>;
  createPayment(p: { invoiceId: string; accountCode: string; amount: number; date: string; reference?: string }, token: string): Promise<any>;
  getOnlineInvoiceUrl(id: string, token: string): Promise<string | undefined>;
  findContactByName(name: string, token: string): Promise<any>;
  createContact(payload: Record<string, unknown>, token: string): Promise<any>;
  parseXeroDate(value: string | undefined | null): string | undefined;
  getLinkedTransaction(linkId: string, token: string): Promise<any | null>;
  linkExpenseToInvoice(p: { linkId: string; sourceTransactionId: string; sourceLineItemId: string; contactId: string; invoiceId: string; lineItemId: string }, token: string): Promise<void>;
}

export interface Deps {
  store: InvoiceStore;
  xero: XeroApi;
  env: (name: string) => string | undefined;
  now?: () => Date;
}

// `warnings`: the invoice is in Xero, but something after it (linking a recharge to its cost) didn't work.
export type Result = { ok: true; xeroInvoiceId?: string; status?: string; warnings?: string[] } | { ok: false; error: string };

const SYNC = "sync-invoice-to-xero";
const VOID = "void-invoice-in-xero";
const WEBHOOK = "xero-webhook";

const pence = (pounds: number | undefined | null) => Math.round((pounds ?? 0) * 100);
const pounds = (p: number) => p / 100;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Xero's statuses the database accepts.
const KNOWN_STATUSES = new Set(["DRAFT", "AUTHORISED", "PAID", "VOIDED"]);

function factsFrom(xero: XeroApi, invoice: any, url: string | undefined, now: Date): XeroInvoiceFacts {
  if (!KNOWN_STATUSES.has(invoice.Status)) throw new Error(`Xero returned an unexpected invoice status: ${invoice.Status}`);
  return {
    number: invoice.InvoiceNumber || undefined,
    xeroInvoiceId: invoice.InvoiceID,
    xeroStatus: invoice.Status,
    paidPence: pence(invoice.AmountPaid),
    balancePence: pence(invoice.AmountDue ?? Math.max((invoice.Total ?? 0) - (invoice.AmountPaid ?? 0), 0)),
    url,
    syncedAt: xero.parseXeroDate(invoice.UpdatedDateUTC) || now.toISOString(),
  };
}

// Throws unless the database and the Xero connection are an allowed pair.
async function assertPairing(deps: Deps, token: string): Promise<void> {
  const reason = checkPairing(deps.env("SUPABASE_URL"), await deps.xero.getOrganisationName(token));
  if (reason) throw new Error(reason);
}

async function resolveContactId(deps: Deps, org: StoredOrganisation, token: string): Promise<string> {
  if (org.xero_contact_id) return org.xero_contact_id;
  if (!org.name) throw new Error("Organisation has no name to match or create a Xero contact with.");

  const matched = await deps.xero.findContactByName(org.name, token);
  let contactId: string;
  if (matched) {
    contactId = matched.ContactID;
  } else {
    const hasAddress = org.address_line1 || org.city || org.postcode;
    const created = await deps.xero.createContact(
      {
        Name: org.name,
        EmailAddress: org.email || undefined,
        Phones: org.phone ? [{ PhoneType: "DEFAULT", PhoneNumber: org.phone }] : undefined,
        Addresses: hasAddress
          ? [
              {
                AddressType: "STREET",
                AddressLine1: org.address_line1 || undefined,
                AddressLine2: org.address_line2 || undefined,
                City: org.city || undefined,
                Region: org.region || undefined,
                PostalCode: org.postcode || undefined,
                Country: org.country || undefined,
              },
            ]
          : undefined,
      },
      token,
    );
    contactId = created.ContactID;
  }
  // Saved straight away, so a failure later in this run can't lead to a second contact.
  await deps.store.setContactId(org.id, contactId);
  return contactId;
}

export async function syncInvoice(deps: Deps, invoiceId: string): Promise<Result> {
  const { store, xero } = deps;
  const now = (deps.now ?? (() => new Date()))();

  if (!(await store.claim(invoiceId))) {
    return { ok: false, error: "This invoice is already being synced, or doesn't exist. Try again in a minute." };
  }

  try {
    const accountCode = deps.env("XERO_LINE_ITEM_ACCOUNT_CODE");
    if (!accountCode) throw new Error("XERO_LINE_ITEM_ACCOUNT_CODE environment variable is not set.");

    const token = await xero.getAccessToken();
    await assertPairing(deps, token);

    const invoice = await store.getInvoice(invoiceId);
    if (!invoice) throw new Error("Invoice not found.");
    if (invoice.xero_status === "VOIDED") throw new Error("This invoice has been voided in Xero and can't be synced again.");
    if (invoice.lines.length === 0) throw new Error("Invoice has no Line Items.");

    const org = await store.getOrganisation(invoice.organisation_id);
    if (!org) throw new Error("Invoice has no linked Organisation.");
    const contactId = await resolveContactId(deps, org, token);

    const lines = [...invoice.lines].sort((a, b) => a.position - b.position);
    const xeroLineItems = lines.map((l) => ({
      Description: l.description || "",
      Quantity: Number(l.quantity),
      UnitAmount: pounds(l.unit_pence),
      // A recharge line is coded to the clearing account; every other line to the usual sales account.
      AccountCode: l.account_code || accountCode,
    }));

    const payment = invoice.xero_payment_id ? null : (invoice.stripe_amount_paid_pence ?? 0) > 0
      ? { amountPence: invoice.stripe_amount_paid_pence as number, reference: invoice.stripe_payment_intent || undefined }
      : null;

    const existing = invoice.xero_invoice_id;
    if (existing) {
      const current = await xero.getInvoice(existing, token);
      if (!current) throw new Error(`Xero Invoice ID ${existing} was not found in Xero.`);
      if (current.Status === "AUTHORISED" || current.Status === "PAID") {
        // An authorised invoice is never edited. But an earlier run may have created it and
        // failed before recording the card payment, and that is worth finishing.
        if (!payment) throw new Error("Invoice already authorised in Xero. Void manually in Xero before editing here.");
        await store.saveClean(invoiceId);
        await tryRecordPayment(deps, invoiceId, existing, payment, token, now);
        return { ok: true, xeroInvoiceId: existing };
      }
    }

    const xeroInvoice = await xero.upsertInvoice(
      {
        Type: "ACCREC",
        Contact: { ContactID: contactId },
        LineItems: xeroLineItems,
        LineAmountType: "Exclusive",
        Status: "AUTHORISED",
        Reference: invoice.reference || undefined,
        Date: invoice.issue_on || undefined,
        DueDate: invoice.due_on || undefined,
        ...(existing ? { InvoiceID: existing } : {}),
      },
      token,
    );

    // The online link is a nicety: its failure must not fail the sync.
    let url: string | undefined;
    try {
      url = await xero.getOnlineInvoiceUrl(xeroInvoice.InvoiceID, token);
    } catch (err) {
      console.error("Failed to fetch online invoice URL:", err);
    }

    // Saved before any payment is attempted, so a payment failure (or a crash) can never
    // lose the fact that the invoice exists in Xero, which would lead to a duplicate.
    const facts = factsFrom(xero, xeroInvoice, url, now);
    const xeroLines: any[] = Array.isArray(xeroInvoice.LineItems) ? xeroInvoice.LineItems : [];
    await store.saveSynced(invoiceId, facts, lines.map((_, i) => xeroLines[i]?.LineItemID));
    await store.log(invoiceId, "success", `Invoice synced to Xero (${facts.number || facts.xeroInvoiceId})`, SYNC);

    const warnings = await linkRecharges(deps, invoiceId, lines, xeroLines, xeroInvoice.InvoiceID, contactId, token);

    if (payment) await tryRecordPayment(deps, invoiceId, xeroInvoice.InvoiceID, payment, token, now);
    return { ok: true, xeroInvoiceId: xeroInvoice.InvoiceID, status: xeroInvoice.Status, ...(warnings.length ? { warnings } : {}) };
  } catch (err) {
    return fail(deps, invoiceId, message(err), SYNC);
  }
}

// Recharges: each line that bills a cost on the clearing account has its billable-expense link pointed at the new invoice
// line, which is what makes Xero mark the cost Billed. Never throws and never undoes the sync: a failure is logged on the
// invoice and returned as a warning, and the cost stays "to invoice" until it is sorted out in Xero.
async function linkRecharges(deps: Deps, invoiceId: string, lines: StoredLine[], xeroLines: any[], xeroInvoiceId: string, contactId: string, token: string): Promise<string[]> {
  const warnings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.recharge_link_id || !l.recharge_source_transaction_id || !l.recharge_source_line_id) continue;
    const what = (l.description || "A recharge").split("\n")[0];
    try {
      const target = xeroLines[i]?.LineItemID;
      if (!target) throw new Error("Xero didn’t give back the invoice line.");
      const current = await deps.xero.getLinkedTransaction(l.recharge_link_id, token);
      if (!current) throw new Error("Xero no longer has the cost’s assignment to this client.");
      if (current.SourceLineItemID !== l.recharge_source_line_id) throw new Error("The assignment in Xero is for a different cost.");
      if (current.Status === "BILLED" && current.TargetTransactionID && current.TargetTransactionID !== xeroInvoiceId) throw new Error("Xero already shows it as billed on another invoice.");
      await deps.xero.linkExpenseToInvoice({ linkId: l.recharge_link_id, sourceTransactionId: l.recharge_source_transaction_id, sourceLineItemId: l.recharge_source_line_id, contactId, invoiceId: xeroInvoiceId, lineItemId: target }, token);
    } catch (err) {
      const text = `${what}: not marked as billed in Xero. ${message(err)}`;
      warnings.push(text);
      try {
        await deps.store.log(invoiceId, "failure", `Recharge ${text}`, SYNC);
      } catch (writeErr) {
        console.error("Failed to log the recharge link problem:", writeErr);
      }
    }
  }
  return warnings;
}

// Never throws: a payment problem is reported on the invoice but must not undo the sync.
async function tryRecordPayment(
  deps: Deps,
  invoiceId: string,
  xeroInvoiceId: string,
  payment: { amountPence: number; reference?: string },
  token: string,
  now: Date,
): Promise<void> {
  try {
    const accountCode = deps.env("XERO_STRIPE_ACCOUNT_CODE");
    if (!accountCode) throw new Error("XERO_STRIPE_ACCOUNT_CODE environment variable is not set.");
    const created = await deps.xero.createPayment(
      { invoiceId: xeroInvoiceId, accountCode, amount: pounds(payment.amountPence), date: now.toISOString().slice(0, 10), reference: payment.reference },
      token,
    );
    const invoice = await deps.xero.getInvoice(xeroInvoiceId, token);
    await deps.store.savePayment(invoiceId, created?.PaymentID, factsFrom(deps.xero, invoice, undefined, now), payment.amountPence);
    await deps.store.log(invoiceId, "success", `Card payment of ${pounds(payment.amountPence).toFixed(2)} recorded against ${invoice.InvoiceNumber || xeroInvoiceId}`, SYNC);
  } catch (err) {
    console.error("Failed to record card payment in Xero:", err);
    const text = message(err);
    try {
      await deps.store.savePaymentError(invoiceId, `Invoice synced but card payment not recorded: ${text}`);
      await deps.store.log(invoiceId, "failure", `Card payment of ${pounds(payment.amountPence).toFixed(2)} could not be recorded: ${text}`, SYNC);
    } catch (writeErr) {
      console.error("Failed to write the payment error:", writeErr);
    }
  }
}

async function fail(deps: Deps, invoiceId: string, text: string, automation: string): Promise<Result> {
  console.error(`${automation} error:`, text);
  try {
    await deps.store.saveError(invoiceId, text);
    await deps.store.log(invoiceId, "failure", text, automation);
  } catch (writeErr) {
    console.error("Failed to write error state:", writeErr);
  }
  return { ok: false, error: text };
}

export async function voidInvoice(deps: Deps, invoiceId: string): Promise<Result> {
  const { store, xero } = deps;
  const now = (deps.now ?? (() => new Date()))();
  if (!(await store.claim(invoiceId))) {
    return { ok: false, error: "This invoice is already being synced, or doesn't exist. Try again in a minute." };
  }
  try {
    const invoice = await store.getInvoice(invoiceId);
    if (!invoice) throw new Error("Invoice not found.");
    if (!invoice.xero_invoice_id) throw new Error("Invoice has no Xero Invoice ID to void.");
    const token = await xero.getAccessToken();
    await assertPairing(deps, token);
    const voided = await xero.upsertInvoice({ InvoiceID: invoice.xero_invoice_id, Status: "VOIDED" }, token);
    const facts = factsFrom(xero, voided, undefined, now);
    await store.saveVoided(invoiceId, facts);
    await store.log(invoiceId, "success", `Invoice voided in Xero (${voided.InvoiceNumber || voided.InvoiceID})`, VOID);
    return { ok: true, xeroInvoiceId: voided.InvoiceID, status: voided.Status };
  } catch (err) {
    return fail(deps, invoiceId, message(err), VOID);
  }
}

// One event from Xero's webhook. Update-only, as the original: an invoice that WareHouse
// has never synced (raised directly in Xero) is ignored.
export async function applyWebhookEvent(deps: Deps, event: { eventCategory: string; resourceId: string }, token: string): Promise<void> {
  const { store, xero } = deps;
  if (event.eventCategory !== "INVOICE") return;
  const xeroInvoice = await xero.getInvoice(event.resourceId, token);
  if (!xeroInvoice) return;
  // Draft edits are noise. Payments and reconciliations both arrive as INVOICE / UPDATE.
  if (xeroInvoice.Status !== "AUTHORISED" && xeroInvoice.Status !== "PAID") return;
  const found = await store.findByXeroId(event.resourceId);
  if (!found) return;
  const updated = xero.parseXeroDate(xeroInvoice.UpdatedDateUTC);
  if (found.syncedAt && updated && new Date(updated).getTime() <= new Date(found.syncedAt).getTime()) return;
  try {
    const facts = factsFrom(xero, xeroInvoice, undefined, (deps.now ?? (() => new Date()))());
    await store.saveWebhookUpdate(found.id, facts);
    await store.log(found.id, "success", `Invoice status synced from Xero: ${xeroInvoice.Status}`, WEBHOOK);
  } catch (err) {
    await store.log(found.id, "failure", message(err), WEBHOOK).catch(() => undefined);
    throw err;
  }
}

export async function checkWebhookPairing(deps: Deps, token: string): Promise<void> {
  await assertPairing(deps, token);
}
