// The router. Every user request enters here and leaves at the cheapest tier
// that can genuinely answer it.
//
//   Tier 0  local-brain     storage / DOM / site knowledge   free, instant
//   Tier 1  response-cache  a previous answer, still valid   free, instant
//   Tier 2  local-llm       on-device summarise / ask        free, ~0.5 s
//   Tier 3  brain.ts        the cloud model                  costs quota
//
// Each tier may decline (return null) and the request falls through.

import { say, setState, echoUser, resolveActiveTab } from './bus';
import { handleLocally, bumpTier, needsCloud, routerStats } from './local-brain';
import { cacheLookup, cacheStore } from './response-cache';
import { localSummarize, localAsk, localSynthesize, activeEngine } from './local-llm';
import { indexPage } from './knowledge-base';
import { processUserInput as cloudBrain, lastCloudReply } from './brain';
import { executeTool } from './tools';

export interface RouterSettings {
  localFirst: boolean;      // use tiers 0-2 at all
  useCache: boolean;
  useLocalLlm: boolean;
  autoIndex: boolean;       // build the knowledge base while browsing
  passiveSuggest: boolean;
}

const DEFAULTS: RouterSettings = {
  localFirst: true,
  useCache: true,
  useLocalLlm: true,
  autoIndex: true,
  passiveSuggest: true,
};

export async function getSettings(): Promise<RouterSettings> {
  const r = await chrome.storage.local.get(['echo_local_settings']);
  return { ...DEFAULTS, ...((r.echo_local_settings || {}) as Partial<RouterSettings>) };
}

export async function setSettings(patch: Partial<RouterSettings>): Promise<RouterSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ echo_local_settings: next });
  return next;
}

// --- request shape detection ----------------------------------------------

const SUMMARIZE_RE = /\b(summar(y|ise|ize)|tldr|tl;dr|key points?|main points?|gist|what.{0,15}(this page|this article|it).{0,10}about|brief me)\b/i;
const PAGE_QA_RE = /\b(this page|this article|this site|on this page|here|the page|above|below)\b/i;
const RESEARCH_RE = /\b(research|compare|all (my |these )?tabs|across (my )?tabs|every tab|these pages)\b/i;

function isSummarize(q: string): boolean { return SUMMARIZE_RE.test(q); }
function isPageQuestion(q: string): boolean {
  return PAGE_QA_RE.test(q) && /\?|\b(what|who|when|where|why|how|does|is|are|can|which)\b/i.test(q);
}
function isResearch(q: string): boolean { return RESEARCH_RE.test(q); }

/** Pull readable text out of a tab, preferring the live DOM. */
async function pageText(tabId?: number): Promise<{ text: string; title: string; url: string } | null> {
  if (tabId == null) return null;
  try {
    const res: any = await executeTool('get_page_text', {}, tabId);
    const raw = typeof res === 'string' ? res : (res?.result || res?.text || '');
    if (!raw || raw.length < 150) return null;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const title = (raw.match(/^TITLE:\s*(.+)$/m)?.[1] || tab?.title || '').trim();
    return { text: raw.replace(/^TITLE:.*$/m, '').trim(), title, url: tab?.url || '' };
  } catch {
    return null;
  }
}

// --- the router ------------------------------------------------------------

export async function routeUserInput(rawInput: string, senderTabId?: number): Promise<void> {
  const input = (rawInput || '').trim();
  if (!input) return;

  const tabId = await resolveActiveTab(senderTabId);
  echoUser(input);

  const settings = await getSettings();
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const url = tab?.url || '';

  // If the user disabled the local stack, go straight to the cloud.
  if (!settings.localFirst) {
    await runCloud(input, tabId, url);
    return;
  }

  try {
    // ---- Tier 0: instant local ------------------------------------------
    const local = await handleLocally(input, tabId);
    if (local) return;

    // Requests that plainly need real generation skip the cheap tiers.
    const forceCloud = needsCloud(input);

    // ---- Tier 1: response cache -----------------------------------------
    if (settings.useCache && !forceCloud) {
      const hit = await cacheLookup(input, url);
      if (hit) {
        const age = Math.round(hit.ageMs / 60000);
        const note = hit.exact ? '' : ' (from a very similar earlier question)';
        say(tabId, hit.answer + `\n\n_Answered from memory${note}${age > 0 ? `, saved ${age} min ago` : ''}._`, 1);
        setState(tabId, 'Idle');
        await bumpTier(1);
        return;
      }
    }

    // ---- Tier 2: on-device model ----------------------------------------
    if (settings.useLocalLlm && !forceCloud && tabId != null) {
      const handled = await tryLocalLlm(input, tabId, url);
      if (handled) return;
    }

    // ---- Tier 3: cloud --------------------------------------------------
    await runCloud(input, tabId, url);
  } catch (e: any) {
    // The router itself must never be the thing that breaks a request.
    console.error('[ECHO] router error:', e);
    await runCloud(input, tabId, url);
  }
}

async function tryLocalLlm(input: string, tabId: number, url: string): Promise<boolean> {
  // Research across tabs — many pages, one (or zero) model calls.
  if (isResearch(input)) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const targets = tabs.filter(t => t.id != null && /^https?:/.test(t.url || '')).slice(0, 8);
    if (targets.length >= 2) {
      setState(tabId, `Reading ${targets.length} tabs on-device…`);
      const docs: { title: string; url: string; text: string }[] = [];
      for (const t of targets) {
        const p = await pageText(t.id!);
        if (p) docs.push({ title: p.title || t.title || '', url: t.url || '', text: p.text });
      }
      if (docs.length >= 2) {
        const out = await localSynthesize(docs);
        say(tabId, `Here's what's across your ${docs.length} tabs:\n\n${out.text}`, 2);
        setState(tabId, 'Idle');
        await bumpTier(2);
        await cacheStore(input, url, out.text);
        return true;
      }
    }
    return false;
  }

  // Summarise the current page.
  if (isSummarize(input)) {
    setState(tabId, 'Reading the page on-device…');
    const p = await pageText(tabId);
    if (!p) return false;
    const out = await localSummarize(p.text, p.title);
    if (!out.text || out.text.length < 60) return false;
    const badge = out.engine === 'chrome-ai' ? 'on-device AI' : 'on-device reader';
    say(tabId, `${out.text}\n\n_Summarised by ${badge} — no API used._`, 2);
    setState(tabId, 'Idle');
    await bumpTier(2);
    await cacheStore(input, url, out.text);
    if (p.url) indexPage(p.url, p.title, p.text).catch(() => {});
    return true;
  }

  // Answer a question about the current page.
  if (isPageQuestion(input)) {
    setState(tabId, 'Checking the page on-device…');
    const p = await pageText(tabId);
    if (!p) return false;
    const out = await localAsk(input, p.text, p.title);
    // Only accept a confident local answer; otherwise let the cloud try.
    if (!out || out.text.length < 40 || /don'?t (know|contain)|not (in|contain|mention)/i.test(out.text)) {
      return false;
    }
    const badge = out.engine === 'chrome-ai' ? 'on-device AI' : 'the page text';
    say(tabId, `${out.text}\n\n_Answered from ${badge} — no API used._`, 2);
    setState(tabId, 'Idle');
    await bumpTier(2);
    await cacheStore(input, url, out.text);
    return true;
  }

  return false;
}

async function runCloud(input: string, tabId: number | undefined, url: string): Promise<void> {
  await bumpTier(3);
  await cloudBrain(input, tabId, { skipEcho: true });
  // Store the cloud's reply so an identical question is free next time.
  const reply = lastCloudReply();
  if (reply) await cacheStore(input, url, reply);
}

// --- knowledge-base ingestion ---------------------------------------------

/** Called when a content script reports the page it just rendered. */
export async function ingestPage(url: string, title: string, text: string): Promise<void> {
  const s = await getSettings();
  if (!s.autoIndex) return;
  await indexPage(url, title, text);
}

export async function routerReport(): Promise<string> {
  const s = await routerStats();
  const engine = await activeEngine();
  const total = s.t0 + s.t1 + s.t2 + s.t3;
  if (!total) return 'No requests handled yet.';
  const local = s.t0 + s.t1 + s.t2;
  return [
    `${total} requests · ${Math.round((local / total) * 100)}% handled locally`,
    `instant ${s.t0} · cached ${s.t1} · on-device ${s.t2} · cloud ${s.t3}`,
    `on-device engine: ${engine === 'chrome-ai' ? "Chrome built-in AI" : 'extractive reader'}`,
  ].join('\n');
}
