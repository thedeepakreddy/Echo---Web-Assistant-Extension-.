// Tier 0 — pattern extractors. Pure regex over the rendered page, no AI.

export type PatternKind = 'emails' | 'phones' | 'prices' | 'links' | 'dates' | 'handles' | 'images' | 'headings';

const PATTERNS: Record<string, RegExp> = {
  emails: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phones: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g,
  prices: /(?:[$£€¥₹]\s?\d[\d,]*(?:\.\d{1,2})?)|(?:\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|INR|JPY))/gi,
  dates: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi,
  handles: /(?:^|\s)@[A-Za-z0-9_]{2,30}\b/g,
};

function pageText(): string {
  return document.body?.innerText || '';
}

function uniq(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const k = item.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
}

/** Reject digit runs that are clearly not phone numbers. */
function plausiblePhone(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (/^0+$/.test(digits)) return false;
  // Long undelimited runs are usually IDs, not numbers people dial.
  if (!/[\s.\-()+]/.test(s.trim()) && digits.length > 11) return false;
  return true;
}

export function extractPattern(kind: PatternKind): { kind: string; count: number; items: string[] } {
  let items: string[] = [];

  if (kind === 'links') {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    items = uniq(anchors
      .map(a => a.href)
      .filter(h => /^https?:/i.test(h)));
  } else if (kind === 'images') {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img[src]'));
    items = uniq(imgs.map(i => i.src).filter(s => /^https?:/i.test(s)));
  } else if (kind === 'headings') {
    const hs = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3'));
    items = uniq(hs
      .map(h => `${h.tagName}: ${h.innerText.replace(/\s+/g, ' ').trim()}`)
      .filter(t => t.length > 5));
  } else {
    const re = PATTERNS[kind];
    if (!re) return { kind, count: 0, items: [] };
    const matches = pageText().match(re) || [];
    items = uniq(matches.map(m => m.trim()));
    if (kind === 'phones') items = items.filter(plausiblePhone);
    if (kind === 'handles') items = items.map(h => h.trim());
  }

  // Cap so a huge page can't blow up the tool result.
  const capped = items.slice(0, 200);
  return { kind, count: items.length, items: capped };
}

/** Everything at once — used by the "extract everything" phrasing. */
export function extractAll(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of ['emails', 'phones', 'prices', 'dates'] as PatternKind[]) {
    const r = extractPattern(k);
    if (r.items.length) out[k] = r.items.slice(0, 50);
  }
  return out;
}

export function toCSV(kind: string, items: string[]): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `${esc(kind)}\n${items.map(esc).join('\n')}\n`;
}
