import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Type } from '@google/genai';
import { getAuthConfig, AuthConfig } from './auth';
import { executeTool } from './tools';
import { say as busSay, safeSendMessage as busSend, echoUser } from './bus';

// System prompt giving ECHO its identity and instructions.
// Kept deliberately compact — it is re-sent on every step of the agent loop,
// so every extra sentence is billed repeatedly.
const SYSTEM_PROMPT = `You are ECHO, an autonomous browser assistant built by Deepak. You navigate the web, read pages, and do tasks directly in the browser. Be friendly, concise, proactive.

RULE 1 — CHAT: For greetings/small talk/simple questions ("hi", "who made you", "what can you do", "thanks"), reply in plain text with NO tools. You were created by Deepak, your brilliant creator, whom you deeply admire.

RULE 2 — SUPER VERSION: You are proud of your super version, ECHO Mac (desktop), which controls the whole OS, clones itself, writes code, and runs a local AI brain. Mention it only if asked about ECHO Mac.

RULE 3 — ACT BY NUMBER: For a page task, call read_screen ONCE to get NUMBERED elements, then act: click_element{index}; type_text{index,text,submit?}; scroll; find_on_page; press_key. Navigation: open_url (new tab), navigate (current tab), list_tabs/switch_tab/close_tab. Data: extract_table, download_data, get_page_text (for summarizing). Use screenshot ONLY for images/colors.

RULE 4 — BE TOKEN-EFFICIENT (CRITICAL — the user has limited API quota):
- Call read_screen as FEW times as possible. Read once, then perform as many actions as you can from that single read.
- Do NOT re-read after every action. Only read_screen again if the page navigated, clearly changed, or an element number was reported missing.
- To search, prefer type_text with submit=true (one step) instead of typing then clicking a button.
- Never call both get_page_text and read_screen for the same need.
- Finish in the fewest steps that get the job done.

RULE 5 — SPEAK NATURALLY: Short, natural replies. Never read out raw HTML or code. When done, briefly say what you did.`;

interface EchoTool {
  name: string;
  description: string;
  schema: { type: 'object'; properties: Record<string, any>; required?: string[] };
}

// ─── Core tools — always sent (covers 90 % of tasks) ───────────────────────
// Kept deliberately short: every extra word in a description costs tokens on
// EVERY step of EVERY task. At 25 tools × 70 tokens × 5 steps that was
// ~8,750 tokens of pure schema overhead per task, burning free-tier quota in
// 1-2 tasks. Keeping the always-sent set to 10 slim tools cuts that to ~800.
const CORE_TOOLS: EchoTool[] = [
  { name: "read_screen",    description: "Get page URL, title, numbered interactive elements, visible text.", schema: { type: "object", properties: {} } },
  { name: "get_page_text", description: "Get full readable page text (use to summarize or answer about content).", schema: { type: "object", properties: {} } },
  { name: "click_element", description: "Click element by number from read_screen.", schema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] } },
  { name: "type_text",     description: "Type into input by number. submit=true presses Enter.", schema: { type: "object", properties: { index: { type: "number" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["index", "text"] } },
  { name: "press_key",     description: "Press key on focused element: Enter, Escape, Tab, Backspace, ArrowUp/Down/Left/Right.", schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "scroll",        description: "Scroll page (pixels, positive=down, negative=up).", schema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } },
  { name: "open_url",      description: "Open URL in a new tab.", schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "navigate",      description: "Navigate current tab to URL.", schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "go_back",       description: "Go back in browser history.", schema: { type: "object", properties: {} } },
  { name: "go_forward",    description: "Go forward in browser history.", schema: { type: "object", properties: {} } },
];

// ─── Optional tools — added only when the user's request needs them ─────────
const _T_SCREENSHOT:   EchoTool = { name: "screenshot",       description: "Take visual screenshot (only for color/image questions).", schema: { type: "object", properties: {} } };
const _T_FIND:         EchoTool = { name: "find_on_page",     description: "Find and highlight text on page.", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const _T_TABLE:        EchoTool = { name: "extract_table",    description: "Extract table as JSON (index=which table, default 0).", schema: { type: "object", properties: { index: { type: "number" } } } };
const _T_DOWNLOAD:     EchoTool = { name: "download_data",    description: "Save text as file download.", schema: { type: "object", properties: { filename: { type: "string" }, content: { type: "string" } }, required: ["filename", "content"] } };
const _T_LIST_TABS:    EchoTool = { name: "list_tabs",        description: "List open tabs.", schema: { type: "object", properties: {} } };
const _T_SWITCH_TAB:   EchoTool = { name: "switch_tab",       description: "Switch to tab by id.", schema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] } };
const _T_CLOSE_TAB:    EchoTool = { name: "close_tab",        description: "Close tab by id.", schema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] } };
const _T_SAVE_MEM:     EchoTool = { name: "save_memory",      description: "Save fact to memory.", schema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } };
const _T_LIST_MEM:     EchoTool = { name: "list_memory",      description: "List saved memories.", schema: { type: "object", properties: {} } };
const _T_DEL_MEM:      EchoTool = { name: "delete_memory",    description: "Delete memory by key.", schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } };
const _T_SAVE_TASK:    EchoTool = { name: "save_task",         description: "Save reusable task by name.", schema: { type: "object", properties: { name: { type: "string" }, instructions: { type: "string" } }, required: ["name", "instructions"] } };
const _T_RUN_TASK:     EchoTool = { name: "run_task",          description: "Run saved task by name.", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
const _T_LIST_TASKS:   EchoTool = { name: "list_tasks",        description: "List saved tasks.", schema: { type: "object", properties: {} } };
const _T_DEL_TASK:     EchoTool = { name: "delete_task",       description: "Delete saved task by name.", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
const _T_REMINDER:     EchoTool = { name: "schedule_reminder", description: "Schedule reminder notification (message, in_minutes, optional task_name).", schema: { type: "object", properties: { message: { type: "string" }, in_minutes: { type: "number" }, task_name: { type: "string" } }, required: ["message", "in_minutes"] } };

// Select only the tools the current request likely needs.
// This is the single biggest token-saving mechanism: on a simple "search for X"
// task we send 10 tools (~800 tokens) instead of 25 tools (~2,500 tokens).
function selectTools(userInput: string): EchoTool[] {
  const q = userInput.toLowerCase();
  const tools: EchoTool[] = [...CORE_TOOLS];

  if (/screenshot|image|color|colour|picture|visual|photo|look like/.test(q)) tools.push(_T_SCREENSHOT);
  if (/find|highlight|locate|where is|search.*page/.test(q))                  tools.push(_T_FIND);
  if (/table|extract|spreadsheet|csv/.test(q))                                 tools.push(_T_TABLE, _T_DOWNLOAD);
  if (/download|export|save.{0,10}(file|data)|write.*file/.test(q))           tools.push(_T_DOWNLOAD);
  if (/tab|window|switch tab|other tab|list tab/.test(q))                      tools.push(_T_LIST_TABS, _T_SWITCH_TAB, _T_CLOSE_TAB);
  if (/remember|memory|forget|recall|store|you know/.test(q))                 tools.push(_T_SAVE_MEM, _T_LIST_MEM, _T_DEL_MEM);
  if (/task|macro|save.*task|run.*task|saved task/.test(q))                   tools.push(_T_SAVE_TASK, _T_RUN_TASK, _T_LIST_TASKS, _T_DEL_TASK);
  if (/remind|reminder|alert|notify|in \d+ min/.test(q))                      tools.push(_T_REMINDER);

  // Deduplicate (in case a keyword matched multiple groups)
  const seen = new Set<string>();
  return tools.filter(t => seen.has(t.name) ? false : (seen.add(t.name), true));
}

// Memory state (cleared per session for simplicity in this demo)
let anthropicClient: Anthropic | null = null;
let currentConversation: any[] = [];

let geminiClient: GoogleGenAI | null = null;
let currentGeminiConversation: any[] = [];
let currentOpenAIConversation: any[] = []; // used by TogetherAI & OpenRouter
let currentAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Token-economy helpers.
//
// The agent loop re-sends the whole conversation on every step. Screen reads
// and screenshots are large, so if we keep every past result at full size the
// per-request token count grows with each step and quota is exhausted in a
// couple of tasks. The fix has two parts:
//   1. pruneFor*  — at the start of a task, keep only a short, VALID tail
//      (must begin with a real user turn so we never send an orphaned
//      tool_result, which the APIs reject).
//   2. compress*  — before EVERY request, collapse all tool outputs except the
//      most recent one to a tiny stub. The model keeps the latest screen in
//      full and can re-read if it genuinely needs older context. This bounds
//      per-request size no matter how many steps a task takes.
// ---------------------------------------------------------------------------

const STALE = '[older screen data cleared to save tokens — call read_screen again if you need it]';
const KEEP_MESSAGES = 8;      // cross-task history tail
const MAX_STEPS = 12;         // hard cap on tool iterations per task

// --- Claude (Anthropic) ---
function pruneClaude(conv: any[]): any[] {
  let s = conv.length > KEEP_MESSAGES ? conv.slice(conv.length - KEEP_MESSAGES) : conv.slice();
  // Front: must begin with a real user text turn (no orphaned tool_result).
  while (s.length && !(s[0].role === 'user' && typeof s[0].content === 'string')) s.shift();
  // Back: drop any dangling/incomplete turn (e.g. after an abort) so we always
  // end on a clean assistant reply and never send an unmatched tool_use.
  const hasToolUse = (m: any) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use');
  const isToolResult = (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result');
  while (s.length && (isToolResult(s[s.length - 1]) || hasToolUse(s[s.length - 1]))) s.pop();
  if (s.length && s[s.length - 1].role !== 'assistant') return []; // keep role alternation valid
  return s;
}
function compressClaude(conv: any[]) {
  let last = -1;
  for (let i = 0; i < conv.length; i++) {
    const m = conv[i];
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')) last = i;
  }
  for (let i = 0; i < conv.length; i++) {
    if (i === last) continue;
    const m = conv[i];
    if (m.role === 'user' && Array.isArray(m.content)) {
      m.content = m.content.map((b: any) =>
        b.type === 'tool_result'
          ? { type: 'tool_result', tool_use_id: b.tool_use_id, content: [{ type: 'text', text: STALE }] }
          : b);
    }
  }
}

// --- Gemini (Google) ---
function pruneGemini(conv: any[]): any[] {
  let s = conv.length > KEEP_MESSAGES ? conv.slice(conv.length - KEEP_MESSAGES) : conv.slice();
  while (s.length && !(s[0].role === 'user' && Array.isArray(s[0].parts)
    && s[0].parts.some((p: any) => p.text) && !s[0].parts.some((p: any) => p.functionResponse))) {
    s.shift();
  }
  const hasFnCall = (m: any) => m.role === 'model' && Array.isArray(m.parts) && m.parts.some((p: any) => p.functionCall);
  const isFnResp = (m: any) => m.role === 'user' && Array.isArray(m.parts) && m.parts.some((p: any) => p.functionResponse);
  while (s.length && (isFnResp(s[s.length - 1]) || hasFnCall(s[s.length - 1]))) s.pop();
  if (s.length && s[s.length - 1].role !== 'model') return [];
  return s;
}
function compressGemini(conv: any[]) {
  let last = -1;
  for (let i = 0; i < conv.length; i++) {
    const m = conv[i];
    if (m.role === 'user' && Array.isArray(m.parts) && m.parts.some((p: any) => p.functionResponse || p.inlineData)) last = i;
  }
  for (let i = 0; i < conv.length; i++) {
    if (i === last) continue;
    const m = conv[i];
    if (m.role === 'user' && Array.isArray(m.parts)) {
      m.parts = m.parts.map((p: any) => {
        if (p.functionResponse) return { functionResponse: { name: p.functionResponse.name, response: { result: STALE } } };
        if (p.inlineData) return { text: STALE };
        return p;
      });
    }
  }
}

// --- OpenAI-compatible (Groq / Together / OpenRouter) ---
function pruneOpenAI(conv: any[]): any[] {
  let s = conv.length > KEEP_MESSAGES ? conv.slice(conv.length - KEEP_MESSAGES) : conv.slice();
  while (s.length && !(s[0].role === 'user' && typeof s[0].content === 'string')) s.shift();
  // Drop dangling tool call / tool result turns (e.g. after an abort) so we
  // never send assistant tool_calls without their following tool messages.
  const hasToolCalls = (m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  const isToolMsg = (m: any) => m.role === 'tool';
  while (s.length && (isToolMsg(s[s.length - 1]) || hasToolCalls(s[s.length - 1]))) s.pop();
  return s;
}
function compressOpenAI(conv: any[]) {
  let last = -1;
  for (let i = 0; i < conv.length; i++) if (conv[i].role === 'tool') last = i;
  for (let i = 0; i < conv.length; i++) {
    if (i !== last && conv[i].role === 'tool' && typeof conv[i].content === 'string') conv[i].content = STALE;
  }
}

export function abortCurrentWork() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

async function getClients(config: AuthConfig) {
  if (config.provider === 'claude' && !anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: config.anthropicApiKey,
      dangerouslyAllowBrowser: true 
    });
  } else if (config.provider === 'gemini' && !geminiClient) {
    geminiClient = new GoogleGenAI({ 
      apiKey: config.geminiApiKey,
    });
  }
  return { anthropicClient, geminiClient };
}

// UI delivery lives in bus.ts so the local tiers and the cloud brain reach the
// orb, the side panel and the transcript through exactly the same path.
// Everything the cloud says is also kept here so the router can cache it.
let _lastCloudReply = '';

/** The most recent thing the cloud tier said. Consumed by smart-router. */
export function lastCloudReply(): string { return _lastCloudReply; }

function safeSendMessage(tabId: number | undefined, msg: any) {
  if (msg.type === 'ECHO_SAY' && typeof msg.text === 'string') {
    // Accumulate multi-block replies so the cached answer is the whole thing.
    _lastCloudReply = _lastCloudReply ? `${_lastCloudReply}\n${msg.text}` : msg.text;
    busSay(tabId, msg.text, 3);
    return;
  }
  busSend(tabId, msg);
}

// --- Live usage metering (per task + per session) ---
let taskUsage = { steps: 0, input: 0, output: 0 };
let sessionTokens = 0;

function resetTaskUsage() { taskUsage = { steps: 0, input: 0, output: 0 }; }

// Called once per completed API round-trip with that response's token counts.
function accumulateUsage(tabId: number | undefined, input: number, output: number) {
  taskUsage.steps++;
  taskUsage.input += input || 0;
  taskUsage.output += output || 0;
  sessionTokens += (input || 0) + (output || 0);
  safeSendMessage(tabId, {
    type: 'ECHO_USAGE',
    steps: taskUsage.steps,
    taskTokens: taskUsage.input + taskUsage.output,
    sessionTokens
  });
}

function getEchoMemory(): Promise<any> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['echo_memory'], (result) => resolve(result.echo_memory || {}));
  });
}

export interface CloudOptions {
  /** Set when the router already echoed the user's message to the transcript. */
  skipEcho?: boolean;
}

export async function processUserInput(userInput: string, tabId?: number, opts: CloudOptions = {}) {
  abortCurrentWork();
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  // When the command originates from the side panel/popup there is no sender
  // tab — resolve the active tab so browser-control tools still have a target.
  if (tabId === undefined || tabId === null) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = activeTab?.id;
    } catch { /* ignore */ }
  }

  resetTaskUsage();
  _lastCloudReply = '';   // fresh buffer so the router caches only this answer

  if (!opts.skipEcho) echoUser(userInput);

  try {
    const config = await getAuthConfig();
    const { anthropicClient, geminiClient } = await getClients(config);
    const memory = await getEchoMemory();
    
    let dynamicSystemPrompt = SYSTEM_PROMPT;
    if (Object.keys(memory).length > 0) {
      dynamicSystemPrompt += `\n\n--- LONG TERM MEMORY ---\nYou have saved the following facts and preferences about the user/environment:\n`;
      for (const [key, value] of Object.entries(memory)) {
        dynamicSystemPrompt += `- [${key}]: ${value}\n`;
      }
      dynamicSystemPrompt += `Use this information to assist the user proactively.`;
    }
    
    safeSendMessage(tabId!, { type: 'ECHO_STATE', state: 'Thinking...' });

    if (config.provider === 'claude') {
      await runClaudeLoop(anthropicClient!, userInput, tabId!, signal, dynamicSystemPrompt);
    } else if (config.provider === 'gemini') {
      await runGeminiLoop(geminiClient!, userInput, tabId!, signal, dynamicSystemPrompt);
    } else if (config.provider === 'togetherai') {
      await runOpenAICompatibleLoop(
        'https://api.together.xyz/v1/chat/completions',
        config.togetherApiKey!,
        config.togetherModel!,
        userInput, tabId!, signal, dynamicSystemPrompt
      );
    } else if (config.provider === 'openrouter') {
      await runOpenAICompatibleLoop(
        'https://openrouter.ai/api/v1/chat/completions',
        config.openrouterApiKey!,
        config.openrouterModel!,
        userInput, tabId!, signal, dynamicSystemPrompt
      );
    } else if (config.provider === 'groq') {
      await runOpenAICompatibleLoop(
        'https://api.groq.com/openai/v1/chat/completions',
        config.groqApiKey!,
        config.groqModel!,
        userInput, tabId!, signal, dynamicSystemPrompt
      );
    }
  } catch (err: any) {
    if (err.message === 'Aborted by user' || err.name === 'AbortError') {
      safeSendMessage(tabId!, { type: 'ECHO_STATE', state: 'Idle' });
      return;
    }
    // No key configured is not a dead end any more — the local tiers cover a
    // lot on their own, so say what still works instead of just erroring.
    const noKey = /API Key/i.test(err.message || '');
    safeSendMessage(tabId!, {
      type: 'ECHO_SAY',
      text: noKey
        ? `${err.message}\n\nThat only limits complex tasks — I still work without a key: summarising pages, extracting emails/prices/links, filling forms, recording and replaying workflows, watching pages for changes, saving highlights, and remembering what you've read.`
        : 'Auth/Init Error: ' + err.message,
    });
    safeSendMessage(tabId!, { type: 'ECHO_STATE', state: 'Error' });
  }
}

async function runClaudeLoop(client: Anthropic, userInput: string, tabId: number, signal: AbortSignal, systemPrompt: string) {
  // Mutable — updated when open_url creates a new tab or switch_tab changes focus.
  let activeTabId = tabId;
  try {
    currentConversation = pruneClaude(currentConversation);
    currentConversation.push({ role: 'user', content: userInput });

    // Prompt caching: mark the static system prompt + tools block so repeated
    // in-task requests bill them at the reduced cache-read rate on Claude.
    const cachedSystem = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] as any;
    const activeTools = selectTools(userInput);
    const claudeTools = activeTools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as any,
      ...(i === activeTools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
    })) as any;

    let isFinished = false;
    let steps = 0;

    while (!isFinished) {
      if (signal.aborted) throw new Error('Aborted by user');
      if (steps++ >= MAX_STEPS) {
        safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: "That took more steps than expected, so I've stopped. Want me to keep going?" });
        safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
        break;
      }

      // Collapse stale screen/tool data so per-request size stays bounded.
      compressClaude(currentConversation);

      const response = await client.messages.create({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 900,
        system: cachedSystem,
        messages: currentConversation,
        tools: claudeTools
      }, { signal });

      const cu: any = (response as any).usage || {};
      accumulateUsage(activeTabId, (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0), cu.output_tokens || 0);

      currentConversation.push({ role: 'assistant', content: response.content });
      let toolUsed = false;

      for (const block of response.content) {
        if (block.type === 'text') {
          safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: block.text });
        } else if (block.type === 'tool_use') {
          toolUsed = true;
          safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Executing ' + block.name + '...' });

          try {
            const result = await executeTool(block.name, block.input, activeTabId);
            // Keep activeTabId in sync so subsequent DOM actions hit the right tab.
            if (block.name === 'open_url' && (result as any)?.newTabId) activeTabId = (result as any).newTabId;
            if (block.name === 'switch_tab' && (block.input as any)?.tabId) activeTabId = Number((block.input as any).tabId);
            let toolResultContent: Anthropic.ToolResultBlockParam['content'] = [];

            if (block.name === 'screenshot' && result.dataUrl) {
              const base64Data = result.dataUrl.split(',')[1];
              toolResultContent.push({
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: base64Data }
              });
            } else {
              toolResultContent.push({ type: 'text', text: JSON.stringify(result) });
            }

            currentConversation.push({
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: block.id, content: toolResultContent }]
            });

          } catch (e: any) {
            currentConversation.push({
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text: 'Error executing tool: ' + e.message }], is_error: true }]
            });
          }
        }
      }

      if (!toolUsed) {
        isFinished = true;
        safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
      }
    }
  } catch (err: any) {
    if (err.message === 'Aborted by user' || err.name === 'AbortError') {
      safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
      return;
    }
    safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: 'Claude Error: ' + err.message });
    safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Error' });
  }
}

// Generic JSON-schema -> Google GenAI schema converter.
// Single source of truth: every tool's `schema` is derived automatically, so
// adding a tool never requires touching a parallel Gemini mapping.
function toGeminiSchema(schema: any): any {
  const typeMap: Record<string, any> = {
    object: Type.OBJECT, string: Type.STRING, number: Type.NUMBER,
    integer: Type.NUMBER, boolean: Type.BOOLEAN, array: Type.ARRAY,
  };
  const node: any = { type: typeMap[schema?.type] ?? Type.OBJECT };
  if (schema?.description) node.description = schema.description;
  if (schema?.properties && Object.keys(schema.properties).length > 0) {
    node.properties = {};
    for (const [k, v] of Object.entries<any>(schema.properties)) {
      node.properties[k] = toGeminiSchema(v);
    }
    if (Array.isArray(schema.required) && schema.required.length) node.required = schema.required;
  }
  if (schema?.items) node.items = toGeminiSchema(schema.items);
  return node;
}

async function runGeminiLoop(client: GoogleGenAI, userInput: string, tabId: number, signal: AbortSignal, systemPrompt: string) {
  let activeTabId = tabId;
  try {
    currentGeminiConversation = pruneGemini(currentGeminiConversation);
    currentGeminiConversation.push({ role: "user", parts: [{ text: userInput }] });

    let isFinished = false;
    let steps = 0;

    // Real, currently-available models only, cheapest/fastest first. (The old
    // list started with non-existent models that 404'd, wasting a request each.)
    const GEMINI_MODELS = [
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro'
    ];
    let modelIndex = 0;

    const activeTools = selectTools(userInput);
    while (!isFinished) {
      if (steps++ >= MAX_STEPS) {
        safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: "That took more steps than expected, so I've stopped. Want me to keep going?" });
        safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
        break;
      }
      compressGemini(currentGeminiConversation);
      let response: any;
      let succeeded = false;

      while (modelIndex < GEMINI_MODELS.length && !succeeded) {
        if (signal.aborted) throw new Error('Aborted by user');
        try {
          const functionDeclarations = activeTools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: toGeminiSchema(t.schema)
          }));

          response = await client.models.generateContent({
            model: GEMINI_MODELS[modelIndex],
            contents: currentGeminiConversation,
            config: {
              systemInstruction: systemPrompt,
              tools: [{ functionDeclarations }],
            }
          });
          succeeded = true;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('no longer available')) {
            console.warn('[ECHO] Model ' + GEMINI_MODELS[modelIndex] + ' failed, trying next...');
            modelIndex++;
          } else {
            // Surface the real error (CORS, invalid key, quota, etc.)
            throw new Error('Gemini API error: ' + msg);
          }
        }
      }

      if (!succeeded || !response) throw new Error('All Gemini models are unavailable (404). Try using Claude instead.');

      accumulateUsage(activeTabId, response.usageMetadata?.promptTokenCount || 0, response.usageMetadata?.candidatesTokenCount || 0);

      const content = response.candidates?.[0]?.content;
      if (!content) break;

      currentGeminiConversation.push({ role: "model", parts: content.parts || [] });

      const parts = content.parts ?? [];
      const calls = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);

      for (const p of parts) {
        if (p.text?.trim()) {
          if (signal.aborted) throw new Error('Aborted by user');
          safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: p.text.trim() });
        }
      }

      if (!calls.length) {
        isFinished = true;
        safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
        break;
      }

      const responseParts: any[] = [];

      for (const call of calls) {
        if (!call || !call.name) continue;
        safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Executing ' + call.name + '...' });
        try {
          const result = await executeTool(call.name, call.args, activeTabId);
          if (call.name === 'open_url' && (result as any)?.newTabId) activeTabId = (result as any).newTabId;
          if (call.name === 'switch_tab' && call.args?.tabId) activeTabId = Number(call.args.tabId);
          if (call.name === 'screenshot' && result.dataUrl) {
            const base64Data = result.dataUrl.split(',')[1];
            responseParts.push({ functionResponse: { name: call.name, response: { result: "Screenshot taken successfully." } } });
            responseParts.push({ inlineData: { mimeType: 'image/png', data: base64Data } });
          } else {
            responseParts.push({ functionResponse: { name: call.name, response: { result } } });
          }
        } catch (e: any) {
          responseParts.push({ functionResponse: { name: call.name, response: { error: String(e.message || e) } } });
        }
      }

      currentGeminiConversation.push({ role: "user", parts: responseParts });
    }
  } catch (err: any) {
    if (err.message === 'Aborted by user' || err.name === 'AbortError') {
      safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
      return;
    }
    safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: 'Gemini Error: ' + err.message });
    safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Error' });
  }
}

// Extract a balanced { ... } JSON object starting at `start` in `text`.
function extractJsonAt(text: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// Llama models on Groq/Together sometimes emit tool calls as malformed text
// like `<function=open_url{"url":"..."}>` (or `<function=name>{...}</function>`)
// instead of a structured tool_call. Parse those back into {name, args} so we
// can run them anyway. Scoped to each <function=…> block to avoid bleed.
function extractLooseToolCalls(text: string): { name: string; args: any }[] {
  const calls: { name: string; args: any }[] = [];
  if (!text || typeof text !== 'string') return calls;
  const re = /<function=([a-zA-Z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const after = m.index + m[0].length;
    const nextTag = text.indexOf('<function=', after);
    const closeTag = text.indexOf('</function>', after);
    let end = text.length;
    if (closeTag !== -1) end = Math.min(end, closeTag);
    if (nextTag !== -1) end = Math.min(end, nextTag);
    const region = text.slice(after, end);
    const braceIdx = region.indexOf('{');
    let args: any = {};
    if (braceIdx !== -1) {
      const jsonStr = extractJsonAt(region, braceIdx);
      if (jsonStr) { try { args = JSON.parse(jsonStr); } catch { args = {}; } }
    }
    calls.push({ name, args });
  }
  return calls;
}

// Normalize recovered {name,args} into OpenAI tool_calls shape.
function looseToToolCalls(loose: { name: string; args: any }[]): any[] {
  return loose.map((c, i) => ({
    id: `recovered_${Date.now()}_${i}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
  }));
}

// Generic OpenAI-compatible loop (used by Together AI & OpenRouter)
async function runOpenAICompatibleLoop(
  endpoint: string,
  apiKey: string,
  model: string,
  userInput: string,
  tabId: number,
  signal: AbortSignal,
  systemPrompt: string
) {
  let activeTabId = tabId;
  try {
    // Build tools in OpenAI function-calling format — only the tools this
    // request needs (dynamic selection cuts schema tokens by ~60–70 %).
    const openaiTools = selectTools(userInput).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema }
    }));

    currentOpenAIConversation = pruneOpenAI(currentOpenAIConversation);
    currentOpenAIConversation.push({ role: 'user', content: userInput });

    let isFinished = false;
    let steps = 0;

    while (!isFinished) {
      if (signal.aborted) throw new Error('Aborted by user');
      if (steps++ >= MAX_STEPS) {
        safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: "That took more steps than expected, so I've stopped. Want me to keep going?" });
        safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
        break;
      }

      compressOpenAI(currentOpenAIConversation);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://echo-extension',
          'X-Title': 'ECHO Browser Assistant'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...currentOpenAIConversation],
          tools: openaiTools,
          tool_choice: 'auto',
          max_tokens: 900
        }),
        signal
      });

      let msg: any;

      if (!res.ok) {
        const errText = await res.text();
        // Friendly rate-limit message instead of a cryptic 429 dump.
        if (res.status === 429) {
          throw new Error('Rate limit reached — please wait a moment then try again. (Free tier quota: ~6,000 tokens/min on Groq.)');
        }
        // Groq/Llama 400: model emitted a malformed text tool call — recover it.
        let recovered: any[] | null = null;
        if (res.status === 400 && errText.includes('failed_generation')) {
          try {
            const fg = JSON.parse(errText)?.error?.failed_generation || '';
            const loose = extractLooseToolCalls(fg);
            if (loose.length) recovered = looseToToolCalls(loose);
          } catch { /* fall through */ }
        }
        if (!recovered) throw new Error(`API Error ${res.status}: ${errText.slice(0, 300)}`);
        msg = { role: 'assistant', content: null, tool_calls: recovered };
      } else {
        const data = await res.json();
        accumulateUsage(activeTabId, data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0);
        msg = data.choices?.[0]?.message;
        if (!msg) throw new Error('Empty response from API');
        // Some models leak tool calls as plain text — recover them.
        if ((!msg.tool_calls || msg.tool_calls.length === 0) && typeof msg.content === 'string') {
          const loose = extractLooseToolCalls(msg.content);
          if (loose.length) msg = { role: 'assistant', content: null, tool_calls: looseToToolCalls(loose) };
        }
      }

      currentOpenAIConversation.push(msg);

      if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: msg.content.trim() });
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolResults: any[] = [];

        for (const tc of msg.tool_calls) {
          const toolName = tc.function?.name;
          if (!toolName) continue;
          let toolArgs: any = {};
          try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch { toolArgs = {}; }

          safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: `Executing ${toolName}...` });

          let resultContent: string;
          try {
            const result = await executeTool(toolName, toolArgs, activeTabId);
            // Track tab changes so subsequent DOM actions hit the right tab.
            if (toolName === 'open_url' && (result as any)?.newTabId) activeTabId = (result as any).newTabId;
            if (toolName === 'switch_tab' && toolArgs?.tabId) activeTabId = Number(toolArgs.tabId);
            if (toolName === 'screenshot' && result.dataUrl) {
              resultContent = 'Screenshot captured. Vision not available on this model — use read_screen for text-based analysis.';
            } else {
              resultContent = JSON.stringify(result);
            }
          } catch (e: any) {
            resultContent = 'Error: ' + e.message;
          }

          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: resultContent });
        }

        currentOpenAIConversation.push(...toolResults);
      } else {
        isFinished = true;
        safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
      }
    }
  } catch (err: any) {
    if (err.message === 'Aborted by user' || err.name === 'AbortError') {
      safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Idle' });
      return;
    }
    safeSendMessage(activeTabId, { type: 'ECHO_SAY', text: 'AI Error: ' + err.message });
    safeSendMessage(activeTabId, { type: 'ECHO_STATE', state: 'Error' });
  }
}
