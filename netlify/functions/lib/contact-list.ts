// Read-only: the names of every active Xero contact, so WareHouse's Purchases page can offer the suppliers Xero already
// has instead of making a second one under a slightly different name. Nothing here writes to Xero.

// Xero returns 100 contacts a page and nothing says how many pages there are, so ask until one comes back short.
// `maxPages` stops a mistake becoming an endless loop. Names are trimmed, blanks dropped, duplicates kept once, sorted.
export async function listContactNames(fetchPage: (page: number) => Promise<any[]>, maxPages = 50): Promise<string[]> {
  const names = new Map<string, string>();
  for (let page = 1; page <= maxPages; page++) {
    const rows = await fetchPage(page);
    for (const r of rows) {
      const name = String(r?.Name ?? "").trim();
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
    if (rows.length < 100) return [...names.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  }
  throw new Error(`More than ${maxPages * 100} contacts: stopped rather than keep asking Xero.`);
}
