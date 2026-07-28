// Tier 0 — automatic form filler.
//
// Scores every visible field against your saved memory keys using the field's
// name, id, placeholder, aria-label, autocomplete hint and its rendered
// <label>. No AI: the page tells us what it wants if we read it carefully.

interface FieldMatcher {
  /** Memory keys, in preference order, that can satisfy this field. */
  keys: string[];
  /** Words that identify the field. */
  words: string[];
  /** autocomplete tokens that identify it outright. */
  auto?: string[];
  type?: string;
}

const MATCHERS: FieldMatcher[] = [
  { keys: ['email', 'user_email', 'default_email', 'work_email'], words: ['email', 'e-mail'], auto: ['email'], type: 'email' },
  { keys: ['first_name', 'firstname', 'given_name'], words: ['first name', 'firstname', 'given name', 'fname'], auto: ['given-name'] },
  { keys: ['last_name', 'lastname', 'surname', 'family_name'], words: ['last name', 'lastname', 'surname', 'family name', 'lname'], auto: ['family-name'] },
  { keys: ['user_name', 'name', 'full_name', 'fullname'], words: ['full name', 'your name', 'name'], auto: ['name'] },
  { keys: ['phone', 'mobile', 'phone_number', 'telephone'], words: ['phone', 'mobile', 'tel', 'contact number'], auto: ['tel'], type: 'tel' },
  { keys: ['company', 'organization', 'employer'], words: ['company', 'organization', 'organisation', 'employer', 'business'], auto: ['organization'] },
  { keys: ['job_title', 'title', 'role', 'position'], words: ['job title', 'position', 'role', 'occupation'], auto: ['organization-title'] },
  { keys: ['address', 'address_line1', 'street'], words: ['address', 'street', 'address line 1'], auto: ['street-address', 'address-line1'] },
  { keys: ['address_line2', 'apartment'], words: ['address line 2', 'apartment', 'suite', 'unit'], auto: ['address-line2'] },
  { keys: ['city', 'town'], words: ['city', 'town', 'locality'], auto: ['address-level2'] },
  { keys: ['state', 'province', 'region'], words: ['state', 'province', 'region'], auto: ['address-level1'] },
  { keys: ['zip', 'zipcode', 'postal_code', 'postcode'], words: ['zip', 'postal', 'postcode', 'pin code'], auto: ['postal-code'] },
  { keys: ['country'], words: ['country'], auto: ['country', 'country-name'] },
  { keys: ['website', 'url', 'portfolio'], words: ['website', 'url', 'homepage', 'portfolio'], auto: ['url'], type: 'url' },
  { keys: ['github', 'github_url'], words: ['github'] },
  { keys: ['linkedin', 'linkedin_url'], words: ['linkedin'] },
  { keys: ['twitter', 'x_handle'], words: ['twitter', 'x handle'] },
  { keys: ['birthday', 'dob', 'date_of_birth'], words: ['birth', 'dob', 'birthday'], auto: ['bday'] },
  { keys: ['bio', 'about', 'summary'], words: ['bio', 'about you', 'summary', 'description', 'tell us'] },
];

/** Fields we must never touch, whatever they look like. */
const FORBIDDEN = /pass(word|wd)|cvv|cvc|card|credit|ssn|social.?security|pin\b|secret|token|otp|security.?code|routing|account.?number/i;

function isVisible(el: HTMLElement): boolean {
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Every textual hint the page gives us about a field. */
function describeField(el: HTMLElement): string {
  const parts: string[] = [];
  const push = (v: string | null) => { if (v) parts.push(v); };
  push(el.getAttribute('name'));
  push(el.getAttribute('id'));
  push(el.getAttribute('placeholder'));
  push(el.getAttribute('aria-label'));
  push(el.getAttribute('title'));
  push(el.getAttribute('autocomplete'));

  const id = el.getAttribute('id');
  if (id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null;
    push(lbl?.innerText || null);
  }
  const wrapping = el.closest('label') as HTMLElement | null;
  if (wrapping) push(wrapping.innerText);

  // Some designs put the label in a sibling above the input.
  const prev = el.previousElementSibling as HTMLElement | null;
  if (prev && /label|span|div|p/i.test(prev.tagName) && prev.innerText.length < 60) push(prev.innerText);

  return parts.join(' ').toLowerCase().replace(/\s+/g, ' ');
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export interface FillReport {
  filled: { field: string; key: string }[];
  skipped: string[];
  total: number;
}

/**
 * Fill every field we can confidently match from `memory`.
 * Returns a report so ECHO can tell the user exactly what it did.
 */
export function fillForm(memory: Record<string, string>): FillReport {
  const report: FillReport = { filled: [], skipped: [], total: 0 };
  if (!memory || !Object.keys(memory).length) return report;

  // Case-insensitive memory lookup.
  const mem = new Map<string, string>();
  for (const [k, v] of Object.entries(memory)) {
    if (typeof v === 'string' && v.trim()) mem.set(k.toLowerCase().replace(/[\s-]/g, '_'), v);
  }

  const fields = Array.from(document.querySelectorAll<HTMLElement>(
    'input, textarea, select'
  )).filter(el => {
    if (!isVisible(el)) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'file', 'image', 'range', 'color'].includes(type)) return false;
    if (el.hasAttribute('readonly') || el.hasAttribute('disabled')) return false;
    return true;
  });

  report.total = fields.length;

  for (const el of fields) {
    const desc = describeField(el);
    if (!desc) continue;

    // Hard stop on anything sensitive, and on password inputs by type.
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || FORBIDDEN.test(desc)) {
      report.skipped.push(desc.slice(0, 40));
      continue;
    }

    // Don't clobber what the user already typed.
    const current = (el as HTMLInputElement).value;
    if (current && current.trim()) continue;

    const match = bestMatch(desc, type, mem);
    if (!match) continue;

    try {
      if (el.tagName === 'SELECT') {
        const sel = el as HTMLSelectElement;
        const want = match.value.toLowerCase();
        const opt = Array.from(sel.options).find(o =>
          o.value.toLowerCase() === want || o.text.toLowerCase().trim() === want
        ) || Array.from(sel.options).find(o => o.text.toLowerCase().includes(want));
        if (!opt) continue;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        setNativeValue(el as HTMLInputElement, match.value);
      }
      report.filled.push({ field: shortLabel(desc), key: match.key });
    } catch { /* skip fields that fight back */ }
  }

  return report;
}

function bestMatch(desc: string, type: string, mem: Map<string, string>): { key: string; value: string } | null {
  let best: { key: string; value: string; score: number } | null = null;

  for (const m of MATCHERS) {
    let score = 0;
    if (m.auto?.some(a => desc.includes(a))) score += 5;
    if (m.type && type === m.type) score += 3;
    for (const w of m.words) {
      if (desc.includes(w)) score += w.includes(' ') ? 4 : 2; // multi-word hints are stronger
    }
    if (score === 0) continue;

    for (const key of m.keys) {
      const val = mem.get(key);
      if (val) {
        if (!best || score > best.score) best = { key, value: val, score };
        break; // first key in preference order wins
      }
    }
  }

  // Direct hit: the field name literally matches a memory key.
  if (!best) {
    for (const [key, value] of mem) {
      const plain = key.replace(/_/g, ' ');
      if (plain.length > 3 && desc.includes(plain)) { best = { key, value, score: 3 }; break; }
    }
  }

  return best && best.score >= 2 ? { key: best.key, value: best.value } : null;
}

function shortLabel(desc: string): string {
  return desc.split(' ').slice(0, 4).join(' ').slice(0, 40);
}

/** Count fillable fields — lets the passive observer offer help. */
export function countFillableFields(): number {
  return Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select')).filter(el => {
    if (!isVisible(el)) return false;
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'file', 'image'].includes(t)) return false;
    if (t === 'password') return false;
    return !(el as HTMLInputElement).value;
  }).length;
}
