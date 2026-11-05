// Read-only: the files attached to bills and "spend money" receipts in Xero, boiled down to what WareHouse needs to file
// them in Drive. Nothing here writes to Xero. The shape is the contract with WareHouse's lib/billFiling.ts.

export interface BillFile {
  // Xero's attachment id: one file, once. WareHouse remembers which it has filed.
  attachmentId: string;
  source: "bill" | "spend";
  objectId: string;
  date: string | null;
  contact: string;
  // The bill's number or the transaction's reference, for the file name.
  reference: string;
  fileName: string;
  mimeType: string;
  size: number;
  updatedAt: string | null;
}

// Xero's dates come back as "/Date(1786025738277+0000)/" (or ISO); a day is all the file name needs.
export function day(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const net = value.match(/^\/Date\((-?\d+)([+-]\d{4})?\)\/$/);
  const d = net ? new Date(Number(net[1])) : new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const updated = (raw: any): string | null => {
  const d = day(raw.UpdatedDateUTC);
  if (!d) return null;
  const net = String(raw.UpdatedDateUTC).match(/^\/Date\((-?\d+)/);
  return net ? new Date(Number(net[1])).toISOString() : String(raw.UpdatedDateUTC);
};

export function toBillFiles(source: "bill" | "spend", raw: any, attachments: any[]): BillFile[] {
  return attachments.map((a) => ({
    attachmentId: String(a.AttachmentID),
    source,
    objectId: String(source === "bill" ? raw.InvoiceID : raw.BankTransactionID),
    date: day(raw.DateString ?? raw.Date),
    contact: String(raw.Contact?.Name ?? ""),
    reference: String((source === "bill" ? raw.InvoiceNumber || raw.Reference : raw.Reference) ?? ""),
    fileName: String(a.FileName ?? "attachment"),
    mimeType: String(a.MimeType ?? "application/octet-stream"),
    size: Number(a.ContentLength ?? 0),
    updatedAt: updated(raw),
  }));
}

export interface BillFileDeps {
  bills: (page: number) => Promise<any[]>;
  spend: (page: number) => Promise<any[]>;
  attachments: (source: "bill" | "spend", objectId: string) => Promise<any[]>;
}

// Everything changed since `since` that has an attachment. Xero says whether an object has attachments in its list
// reply, so only those are asked for their files. A page is 100 rows; `maxPages` stops a mistake becoming a loop.
export async function listBillFiles(deps: BillFileDeps, maxPages = 10): Promise<BillFile[]> {
  const out: BillFile[] = [];
  for (const source of ["bill", "spend"] as const) {
    const fetchPage = source === "bill" ? deps.bills : deps.spend;
    for (let page = 1; ; page++) {
      if (page > maxPages) throw new Error(`More than ${maxPages * 100} ${source === "bill" ? "bills" : "transactions"} changed: stopped rather than keep asking Xero.`);
      const rows = await fetchPage(page);
      for (const raw of rows) {
        if (!raw.HasAttachments) continue;
        const id = source === "bill" ? raw.InvoiceID : raw.BankTransactionID;
        out.push(...toBillFiles(source, raw, await deps.attachments(source, id)));
      }
      if (rows.length < 100) break;
    }
  }
  return out;
}
