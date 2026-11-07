// Posts one approved purchase to Xero as Spend Money, unreconciled, so the bank line can be matched with one click. Always in
// GBP: the organisation has no multi-currency, and WareHouse only sends the figure that left the account. Before writing it
// refuses the wrong pairing of database and Xero, and looks for an entry that may already be there (a document uploaded to
// Xero by hand, say); WareHouse can then choose to post anyway.
import { checkPairing } from "./environment";

export interface SpendRequest {
  purchaseId: string;
  contactName: string;
  accountCode: string;
  bankCode: string;
  date: string;
  amountPence: number;
  description: string;
  reference: string;
  force: boolean;
}

export interface SpendDeps {
  env: (name: string) => string | undefined;
  getAccessToken: () => Promise<string>;
  getOrganisationName: (token: string) => Promise<string>;
  findContactByName: (name: string, token: string) => Promise<any>;
  createContact: (payload: Record<string, unknown>, token: string) => Promise<any>;
  listSpendBetween: (from: string, to: string, token: string) => Promise<any[]>;
  listBillsBetween: (from: string, to: string, token: string) => Promise<any[]>;
  createSpendMoney: (payload: Record<string, unknown>, key: string, token: string) => Promise<any>;
}

export type SpendResult =
  | { ok: true; bankTransactionId: string; contactCreated: boolean }
  | { ok: false; duplicate: string }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BANK_CODES = ["600", "601"];

export function parseSpendRequest(body: any): SpendRequest | null {
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const req: SpendRequest = {
    purchaseId: text(body?.purchaseId, 36),
    contactName: text(body?.contactName, 200),
    accountCode: text(body?.accountCode, 10),
    bankCode: text(body?.bankCode, 10),
    date: text(body?.date, 10),
    amountPence: Number(body?.amountPence),
    description: text(body?.description, 400),
    reference: text(body?.reference, 200),
    force: body?.force === true,
  };
  const valid =
    UUID.test(req.purchaseId) && !!req.contactName && /^\d{3}$/.test(req.accountCode) && BANK_CODES.includes(req.bankCode) && /^\d{4}-\d{2}-\d{2}$/.test(req.date) && !isNaN(Date.parse(req.date)) && Number.isInteger(req.amountPence) && req.amountPence > 0 && !!req.description;
  return valid ? req : null;
}

export function spendPayload(req: SpendRequest, contactId: string): Record<string, unknown> {
  return {
    Type: "SPEND",
    Contact: { ContactID: contactId },
    BankAccount: { Code: req.bankCode },
    Date: req.date,
    Reference: req.reference || undefined,
    CurrencyCode: "GBP",
    LineAmountTypes: "NoTax",
    Status: "AUTHORISED",
    LineItems: [{ Description: req.description, Quantity: 1, UnitAmount: req.amountPence / 100, AccountCode: req.accountCode, TaxType: "NONE" }],
  };
}

const pence = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const WINDOW_DAYS = 10;
const shift = (day: string, days: number) => new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);

// The same amount within ten days, or the same bill number. A monthly subscription a month ago is outside the window.
export function findDuplicate(req: SpendRequest, spends: any[], bills: any[]): string | null {
  const money = `£${(req.amountPence / 100).toFixed(2)}`;
  const number = req.reference.toLowerCase();
  const bill = bills.find((b) => (number && String(b.InvoiceNumber ?? "").toLowerCase() === number) || pence(b.Total) === req.amountPence);
  if (bill) return `A bill for ${money} or with this number is already in Xero: ${bill.Contact?.Name ?? "unknown"} ${bill.InvoiceNumber ?? ""}`.trim();
  const spend = spends.find((s) => pence(s.Total) === req.amountPence && s.Status !== "DELETED");
  if (spend) return `A bank payment of ${money} is already in Xero: ${spend.Contact?.Name ?? "unknown"} ${spend.Reference ?? ""}`.trim();
  return null;
}

export async function postSpend(deps: SpendDeps, req: SpendRequest): Promise<SpendResult> {
  try {
    const token = await deps.getAccessToken();
    const refused = checkPairing(deps.env("SUPABASE_URL"), await deps.getOrganisationName(token));
    if (refused) return { ok: false, error: refused };

    if (!req.force) {
      const from = shift(req.date, -WINDOW_DAYS);
      const to = shift(req.date, WINDOW_DAYS);
      const [spends, bills] = await Promise.all([deps.listSpendBetween(from, to, token), deps.listBillsBetween(from, to, token)]);
      const duplicate = findDuplicate(req, spends, bills);
      if (duplicate) return { ok: false, duplicate };
    }

    const existing = await deps.findContactByName(req.contactName, token);
    const contact = existing ?? (await deps.createContact({ Name: req.contactName }, token));
    if (!contact?.ContactID) return { ok: false, error: `Couldn't find or make the contact ${req.contactName}.` };

    const created = await deps.createSpendMoney(spendPayload(req, contact.ContactID), req.purchaseId, token);
    if (!created?.BankTransactionID) return { ok: false, error: "Xero didn't return the new entry." };
    return { ok: true, bankTransactionId: created.BankTransactionID, contactCreated: !existing };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 400) };
  }
}
