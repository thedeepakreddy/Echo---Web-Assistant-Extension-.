// Tier 2 — on-device language work. No network, no quota.
//
// Two engines, tried in order:
//   1. Chrome's built-in AI (Gemini Nano) via the Summarizer / LanguageModel
//      globals. Runs on the user's own hardware. Present on Chrome 138+ with
//      supported hardware; absent everywhere else, so it is feature-detected
//      and never assumed.
//   2. A pure-JS extractive summariser + keyword answerer. Always available,
//      zero dependencies. Guarantees Tier 2 can answer *something* rather than
//      falling through to the paid tier.

// Chrome ships these as bare globals; they are not in lib.dom yet.
declare const Summarizer: any;
declare const LanguageModel: any;

export type LocalEngine = 'chrome-ai' | 'extractive' | 'none';

let summarizerSession: any = null;
let promptSession: any = null;
let chromeAiChecked = false;
let chromeAiUsable = false;

/** Is Chrome's built-in model present and ready (or downloadable)? */
export async function chromeAiAvailable(): Promise<boolean> {
  if (chromeAiChecked) return chromeAiUsable;
  chromeAiChecked = true;
  chromeAiUsable = false;
  try {
    if (typeof Summarizer !== 'undefined' && Summarizer?.availability) {
      const a = await Summarizer.availability();
      if (a === 'available' || a === 'downloadable' || a === 'downloading') chromeAiUsable = true;
    }
    if (!chromeAiUsable && typeof LanguageModel !== 'undefined' && LanguageModel?.availability) {
      const a = await LanguageModel.availability();
      if (a === 'available' || a === 'downloadable' || a === 'downloading') chromeAiUsable = true;
    }
  } catch {
    chromeAiUsable = false;
  }
  return chromeAiUsable;
}

/** Which engine will actually serve a request right now. */
export async function activeEngine(): Promise<LocalEngine> {
  return (await chromeAiAvailable()) ? 'chrome-ai' : 'extractive';
}

async function getSummarizer(): Promise<any | null> {
  if (summarizerSession) return summarizerSession;
  try {
    if (typeof Summarizer === 'undefined' || !Summarizer?.create) return null;
    const a = await Summarizer.availability();
    if (a === 'unavailable') return null;
    summarizerSession = await Summarizer.create({
      type: 'key-points',
      format: 'plain-text',
      length: 'short',
    });
    return summarizerSession;
  } catch {
    summarizerSession = null;
    return null;
  }
}

async function getPromptSession(): Promise<any | null> {
  if (promptSession) return promptSession;
  try {
    if (typeof LanguageModel === 'undefined' || !LanguageModel?.create) return null;
    const a = await LanguageModel.availability();
    if (a === 'unavailable') return null;
    promptSession = await LanguageModel.create({
      initialPrompts: [{
        role: 'system',
        content: 'You are ECHO, a concise browser assistant. Answer in 1-3 short sentences using only the provided page text. If the text does not contain the answer, say so plainly.',
      }],
    });
    return promptSession;
  } catch {
    promptSession = null;
    return null;
  }
}

/** Drop cached sessions (e.g. after an error) so the next call rebuilds them. */
export function resetLocalLlm() {
  try { summarizerSession?.destroy?.(); } catch { /* ignore */ }
  try { promptSession?.destroy?.(); } catch { /* ignore */ }
  summarizerSession = null;
  promptSession = null;
  chromeAiChecked = false;
}

export interface LocalAnswer { text: string; engine: LocalEngine }

const MAX_INPUT = 12_000;

/** Summarise page text on-device. Never rejects — worst case is extractive. */
export async function localSummarize(text: string, title?: string): Promise<LocalAnswer> {
  const body = (text || '').replace(/\s+/g, ' ').trim();
  if (body.length < 200) {
    return { text: body || 'There is not enough readable text on this page to summarise.', engine: 'extractive' };
  }
  const clipped = body.slice(0, MAX_INPUT);

  const s = await getSummarizer();
  if (s) {
    try {
      const out = await s.summarize(clipped, {
        context: title ? `The page is titled "${title}".` : undefined,
      });
      if (out && String(out).trim().length > 30) {
        return { text: String(out).trim(), engine: 'chrome-ai' };
      }
    } catch {
      resetLocalLlm(); // session died; fall through to extractive
    }
  }
  return { text: extractiveSummary(clipped, title), engine: 'extractive' };
}

/** Answer a question strictly from supplied page text, on-device. */
export async function localAsk(question: string, context: string, title?: string): Promise<LocalAnswer | null> {
  const body = (context || '').replace(/\s+/g, ' ').trim();
  if (body.length < 150) return null;
  const clipped = body.slice(0, MAX_INPUT);

  const p = await getPromptSession();
  if (p) {
    try {
      const out = await p.prompt(
        `Page${title ? ` "${title}"` : ''} content:\n"""\n${clipped}\n"""\n\nQuestion: ${question}`
      );
      const t = String(out || '').trim();
      if (t.length > 2) return { text: t, engine: 'chrome-ai' };
    } catch {
      resetLocalLlm();
    }
  }

  // Extractive fallback: return the passages that best match the question.
  const passages = bestPassages(question, clipped, 3);
  if (!passages.length) return null;
  return {
    text: `From the page:\n\n${passages.map(s => `• ${s}`).join('\n')}`,
    engine: 'extractive',
  };
}

// ---------------------------------------------------------------------------
// Pure-JS extractive engine — the always-available floor.
// Classic frequency-based sentence scoring: rank sentences by the weight of
// the words they contain, then emit the best few in original document order so
// the result still reads like prose.
// ---------------------------------------------------------------------------

const STOP = new Set([
  'the', 'and', 'that', 'this', 'with', 'for', 'was', 'were', 'are', 'you', 'your', 'from',
  'have', 'has', 'had', 'been', 'they', 'them', 'their', 'there', 'here', 'can', 'could',
  'would', 'should', 'will', 'did', 'does', 'not', 'but', 'all', 'any', 'some', 'its', 'it',
  'a', 'an', 'of', 'to', 'in', 'on', 'is', 'as', 'at', 'by', 'or', 'be', 'we', 'our', 'if',
  'about', 'into', 'more', 'than', 'then', 'when', 'what', 'which', 'who', 'how', 'also',
  'may', 'many', 'most', 'such', 'other', 'these', 'those', 'his', 'her', 'she', 'he',
]);

// Explicit, visible delimiter — never appears in real page text.
const SENT_DELIM = '<<|ECHO_SENT|>>';

function splitSentences(text: string): string[] {
  // Break after . ! ? only when the next token really starts a new sentence,
  // so "v1.5" and "Inc." don't shatter into fragments.
  return text
    .replace(/([.!?])\s+(?=["'(]?[A-Z0-9])/g, '$1' + SENT_DELIM)
    .split(SENT_DELIM)
    .map(s => s.trim())
    .filter(s => s.length >= 40 && s.length <= 400);
}

function wordFreq(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  const words = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return freq;
}

export function extractiveSummary(text: string, title?: string, maxSentences = 5): string {
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) {
    return sentences.join(' ') || text.slice(0, 500);
  }

  const freq = wordFreq(text);
  let peak = 0;
  freq.forEach(v => { if (v > peak) peak = v; });
  const titleWords = new Set((title || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []);

  const scored = sentences.map((s, i) => {
    const words = s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
    if (!words.length) return { s, i, score: 0 };
    let score = 0;
    for (const w of words) {
      if (STOP.has(w)) continue;
      score += (freq.get(w) || 0) / peak;
      if (titleWords.has(w)) score += 0.4;   // on-topic with the page title
    }
    score /= Math.sqrt(words.length);        // don't just reward long sentences
    if (i < sentences.length * 0.2) score *= 1.15; // openers carry the thesis
    return { s, i, score };
  });

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)               // restore reading order
    .map(x => x.s);

  return top.join(' ');
}

/** The sentences most relevant to a question — extractive Q&A. */
export function bestPassages(question: string, text: string, n = 3): string[] {
  const qWords = (question.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter(w => !STOP.has(w));
  if (!qWords.length) return [];
  const sentences = splitSentences(text);
  const scored = sentences.map(s => {
    const low = s.toLowerCase();
    let score = 0;
    for (const w of qWords) if (low.includes(w)) score += 1;
    return { s, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  // Require at least a third of the question's terms to appear.
  const threshold = Math.max(1, Math.ceil(qWords.length / 3));
  return scored.filter(x => x.score >= threshold).slice(0, n).map(x => x.s);
}

/** Merge several pages into one readable brief — powers Research Mode. */
export async function localSynthesize(
  docs: { title: string; url: string; text: string }[]
): Promise<LocalAnswer> {
  if (!docs.length) return { text: 'No pages to work with.', engine: 'extractive' };

  const parts: string[] = [];
  let engine: LocalEngine = 'extractive';
  for (const d of docs) {
    const sum = await localSummarize(d.text, d.title);
    if (sum.engine === 'chrome-ai') engine = 'chrome-ai';
    parts.push(`**${d.title || d.url}**\n${sum.text}`);
  }
  return { text: parts.join('\n\n'), engine };
}
