// Tier 0 — workflow recorder & player.
//
// "Watch me" captures the clicks and keystrokes you perform, stores them as
// resolvable selectors, and replays them on demand. A recorded login, checkout
// or daily routine then costs zero tokens forever.

export interface WorkflowStep {
  type: 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'wait';
  /** Ordered selector candidates, most stable first. */
  selectors?: string[];
  /** Visible label at record time — last-resort way to re-find the element. */
  label?: string;
  value?: string;
  url?: string;
  ms?: number;
}

export interface Workflow {
  name: string;
  steps: WorkflowStep[];
  startUrl: string;
  created: number;
  runs: number;
}

interface RecordingState { tabId: number; startUrl: string; startedAt: number }

let recording: RecordingState | null = null;

export function isRecording(): boolean { return recording !== null; }
export function recordingTab(): number | null { return recording?.tabId ?? null; }

export async function startRecording(tabId: number, startUrl: string): Promise<void> {
  recording = { tabId, startUrl, startedAt: Date.now() };
  await chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: 'record_start', args: {} })
    .catch(() => { /* content script not ready — stopRecording will report empty */ });
}

/** Pull the captured steps out of the page and persist them under `name`. */
export async function stopRecording(name: string): Promise<{ ok: boolean; count: number; message: string }> {
  if (!recording) return { ok: false, count: 0, message: 'Not currently recording.' };
  const { tabId, startUrl } = recording;
  recording = null;

  let steps: WorkflowStep[] = [];
  try {
    const res: any = await chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: 'record_stop', args: {} });
    if (res?.success && Array.isArray(res.result?.steps)) steps = res.result.steps;
  } catch {
    return { ok: false, count: 0, message: 'Lost contact with the page — nothing was saved.' };
  }

  if (!steps.length) {
    return { ok: false, count: 0, message: "I didn't capture any actions, so there's nothing to save." };
  }

  const wf: Workflow = { name: name.trim(), steps, startUrl, created: Date.now(), runs: 0 };
  const all = await listWorkflows();
  all[wf.name] = wf;
  await chrome.storage.local.set({ echo_workflows: all });
  return { ok: true, count: steps.length, message: `Saved "${wf.name}" — ${steps.length} steps.` };
}

export async function cancelRecording(): Promise<void> {
  if (!recording) return;
  const { tabId } = recording;
  recording = null;
  await chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: 'record_stop', args: {} }).catch(() => {});
}

export async function listWorkflows(): Promise<Record<string, Workflow>> {
  const r = await chrome.storage.local.get(['echo_workflows']);
  return (r.echo_workflows || {}) as Record<string, Workflow>;
}

export async function deleteWorkflow(name: string): Promise<boolean> {
  const all = await listWorkflows();
  const key = findWorkflowKey(all, name);
  if (!key) return false;
  delete all[key];
  await chrome.storage.local.set({ echo_workflows: all });
  return true;
}

/** Tolerant name lookup so "run my standup" finds "daily standup". */
export function findWorkflowKey(all: Record<string, Workflow>, name: string): string | null {
  const n = name.toLowerCase().trim();
  if (!n) return null;
  const keys = Object.keys(all);
  const exact = keys.find(k => k.toLowerCase() === n);
  if (exact) return exact;
  const contains = keys.find(k => k.toLowerCase().includes(n) || n.includes(k.toLowerCase()));
  return contains || null;
}

export interface PlayResult { ok: boolean; message: string; done: number; total: number }

/**
 * Replay a workflow in `tabId`. Navigation steps wait for load; everything
 * else is handed to the content script, which resolves the selector list.
 */
export async function playWorkflow(name: string, tabId: number): Promise<PlayResult> {
  const all = await listWorkflows();
  const key = findWorkflowKey(all, name);
  if (!key) {
    const names = Object.keys(all);
    return {
      ok: false, done: 0, total: 0,
      message: names.length
        ? `I don't have a workflow called "${name}". I have: ${names.join(', ')}.`
        : `I don't have any workflows saved yet. Say "record a workflow" to make one.`,
    };
  }

  const wf = all[key];
  let done = 0;

  // Start from the page the recording began on, so selectors line up.
  if (wf.startUrl) {
    try {
      await chrome.tabs.update(tabId, { url: wf.startUrl });
      await waitForLoad(tabId);
    } catch { /* keep going on the current page */ }
  }

  for (const step of wf.steps) {
    try {
      if (step.type === 'navigate' && step.url) {
        await chrome.tabs.update(tabId, { url: step.url });
        await waitForLoad(tabId);
        done++;
        continue;
      }
      if (step.type === 'wait') {
        await sleep(Math.min(step.ms || 500, 5000));
        done++;
        continue;
      }
      const res: any = await chrome.tabs.sendMessage(tabId, {
        type: 'DOM_ACTION', action: 'play_step', args: step,
      });
      if (!res?.success) {
        return {
          ok: false, done, total: wf.steps.length,
          message: `Stopped at step ${done + 1} of ${wf.steps.length} — couldn't find "${step.label || step.type}". The page may have changed since I recorded it.`,
        };
      }
      done++;
      // Let the page react between actions.
      await sleep(step.type === 'click' ? 600 : 250);
    } catch {
      return {
        ok: false, done, total: wf.steps.length,
        message: `Stopped at step ${done + 1} — the page navigated away mid-run.`,
      };
    }
  }

  wf.runs = (wf.runs || 0) + 1;
  all[key] = wf;
  await chrome.storage.local.set({ echo_workflows: all });

  return { ok: true, done, total: wf.steps.length, message: `Ran "${key}" — all ${done} steps completed.` };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function waitForLoad(tabId: number, timeout = 9000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.status === 'complete') return resolve();
        if (Date.now() - start > timeout) return resolve();
        setTimeout(poll, 300);
      });
    };
    setTimeout(poll, 700);
  });
}
