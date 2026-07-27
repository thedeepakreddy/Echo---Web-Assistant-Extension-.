import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Type } from '@google/genai';
import { getAuthConfig, AuthConfig } from './auth';
import { executeTool } from './tools';

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

const SHARED_TOOLS: EchoTool[] = [
  {
    name: "read_screen",
    description: "Read the page: URL, title, NUMBERED interactive elements, and visible text. Call once before clicking/typing to get element numbers.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "get_page_text",
    description: "Get the page's readable text (for summarizing / answering about content).",
    schema: { type: "object", properties: {} }
  },
  {
    name: "screenshot",
    description: "Take a visual screenshot. ONLY use for images, colors, or visual layout questions that read_screen cannot answer — it burns API quota.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "click_element",
    description: "Click a numbered element from read_screen. Pass its number as 'index'. If the number is missing or wrong, call read_screen again first.",
    schema: {
      type: "object",
      properties: { index: { type: "number", description: "The [number] of the element from read_screen" } },
      required: ["index"]
    }
  },
  {
    name: "type_text",
    description: "Type into a numbered input. submit=true presses Enter (e.g. to search) in one step.",
    schema: {
      type: "object",
      properties: {
        index: { type: "number", description: "element number from read_screen" },
        text: { type: "string" },
        submit: { type: "boolean" }
      },
      required: ["index", "text"]
    }
  },
  {
    name: "press_key",
    description: "Press one key (Enter, Escape, Tab, Backspace, Delete, Arrow keys) on the focused element.",
    schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"]
    }
  },
  {
    name: "scroll",
    description: "Scroll the page vertically. Positive amount scrolls down, negative scrolls up (in pixels).",
    schema: {
      type: "object",
      properties: { amount: { type: "number", description: "Pixels to scroll (positive down, negative up)" } },
      required: ["amount"]
    }
  },
  {
    name: "find_on_page",
    description: "Find text on the page, scroll it into view, and briefly highlight it. Returns whether it was found.",
    schema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to find" } },
      required: ["text"]
    }
  },
  {
    name: "extract_table",
    description: "Extract a table from the page as JSON rows. Optional 'index' picks which table (default 0).",
    schema: {
      type: "object",
      properties: { index: { type: "number", description: "Which table to extract (0-based, optional)" } }
    }
  },
  {
    name: "open_url",
    description: "Open a URL in a NEW browser tab.",
    schema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to open" } },
      required: ["url"]
    }
  },
  {
    name: "navigate",
    description: "Navigate the CURRENT tab to a URL (does not open a new tab).",
    schema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to navigate to" } },
      required: ["url"]
    }
  },
  {
    name: "go_back",
    description: "Go back one step in the current tab's history.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "go_forward",
    description: "Go forward one step in the current tab's history.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "list_tabs",
    description: "List the user's open tabs (id, title, url). Use before switching or closing tabs.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "switch_tab",
    description: "Focus/activate an open tab by its id (from list_tabs).",
    schema: {
      type: "object",
      properties: { tabId: { type: "number", description: "The id of the tab to activate" } },
      required: ["tabId"]
    }
  },
  {
    name: "close_tab",
    description: "Close an open tab by its id (from list_tabs).",
    schema: {
      type: "object",
      properties: { tabId: { type: "number", description: "The id of the tab to close" } },
      required: ["tabId"]
    }
  },
  {
    name: "download_data",
    description: "Save text content (CSV, JSON, notes, extracted data) as a file download for the user.",
    schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "The filename, e.g. 'data.csv'" },
        content: { type: "string", description: "The text content of the file" }
      },
      required: ["filename", "content"]
    }
  },
  {
    name: "save_memory",
    description: "Save a fact, preference, or task into ECHO's long-term memory so you remember it across sessions.",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "A unique, concise key (e.g. 'user_name', 'default_email')" },
        value: { type: "string", description: "The information to remember" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "list_memory",
    description: "List everything currently saved in ECHO's long-term memory.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "delete_memory",
    description: "Delete a fact from ECHO's long-term memory by its key.",
    schema: {
      type: "object",
      properties: { key: { type: "string", description: "The key of the memory to delete" } },
      required: ["key"]
    }
  },
  {
    name: "save_task",
    description: "Save a reusable named task (macro) as plain-English instructions to re-run later.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name for the task" },
        instructions: { type: "string", description: "The step-by-step instructions to run later" }
      },
      required: ["name", "instructions"]
    }
  },
  {
    name: "run_task",
    description: "Load a saved task by name. After calling this, immediately carry out the returned instructions using your tools.",
    schema: {
      type: "object",
      properties: { name: { type: "string", description: "The name of the saved task" } },
      required: ["name"]
    }
  },
  {
    name: "list_tasks",
    description: "List all saved tasks (macros) and their instructions.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "delete_task",
    description: "Delete a saved task by name.",
    schema: {
      type: "object",
      properties: { name: { type: "string", description: "The name of the saved task" } },
      required: ["name"]
    }
  },
  {
    name: "schedule_reminder",
    description: "Set a reminder that fires a desktop notification after a delay. Optionally attach a saved task name so clicking the notification runs that task.",
    schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The reminder message to show" },
        in_minutes: { type: "number", description: "Minutes from now to fire the reminder (min 0.5)" },
        task_name: { type: "string", description: "Optional: a saved task to offer to run when clicked" }
      },
      required: ["message", "in_minutes"]
    }
  }
];

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

// Append an entry to the persistent transcript (capped) for the side panel.
function pushTranscript(entry: { role: 'user' | 'echo'; text: string }) {
  chrome.storage.local.get(['echo_transcript'], (r) => {
    const t = (r.echo_transcript || []) as any[];
    t.push({ ...entry, ts: Date.now() });
    chrome.storage.local.set({ echo_transcript: t.slice(-200) });
  });
}

// Single choke point for UI updates. Sends to the content-script orb on the
// active tab AND mirrors conversational messages to extension pages (the side
// panel / popup) so every surface stays in sync. Persists spoken replies.
function safeSendMessage(tabId: number | undefined, msg: any) {
  if (tabId !== undefined && tabId !== null) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => { /* ignore missing receiver errors */ });
  }
  if (msg.type === 'ECHO_SAY' || msg.type === 'ECHO_STATE' || msg.type === 'ECHO_USAGE') {
    // Reaches the side panel / popup. No-op (caught) if none are open.
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* ignore */ }
  }
  if (msg.type === 'ECHO_SAY' && typeof msg.text === 'string') {
    pushTranscript({ role: 'echo', text: msg.text });
  }
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

export async function processUserInput(userInput: string, tabId?: number) {
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

  // Record the user's message so the side panel transcript shows it immediately.
  pushTranscript({ role: 'user', text: userInput });
  try { chrome.runtime.sendMessage({ type: 'ECHO_USER_ECHO', text: userInput }).catch(() => {}); } catch { /* ignore */ }

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
    safeSendMessage(tabId!, { type: 'ECHO_SAY', text: 'Auth/Init Error: ' + err.message });
    safeSendMessage(tabId!, { type: 'ECHO_STATE', state: 'Error' });
  }
}

async function runClaudeLoop(client: Anthropic, userInput: string, tabId: number, signal: AbortSignal, systemPrompt: string) {
  try {
    currentConversation = pruneClaude(currentConversation);
    currentConversation.push({ role: 'user', content: userInput });

    // Prompt caching: mark the static system prompt + tools block so repeated
    // in-task requests bill them at the reduced cache-read rate on Claude.
    const cachedSystem = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] as any;
    const claudeTools = SHARED_TOOLS.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as any,
      ...(i === SHARED_TOOLS.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
    })) as any;

    let isFinished = false;
    let steps = 0;

    while (!isFinished) {
      if (signal.aborted) throw new Error('Aborted by user');
      if (steps++ >= MAX_STEPS) {
        safeSendMessage(tabId, { type: 'ECHO_SAY', text: "That took more steps than expected, so I've stopped. Want me to keep going?" });
        safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
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
      accumulateUsage(tabId, (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0), cu.output_tokens || 0);

      currentConversation.push({ role: 'assistant', content: response.content });
      let toolUsed = false;

      for (const block of response.content) {
        if (block.type === 'text') {
          safeSendMessage(tabId, { type: 'ECHO_SAY', text: block.text });
        } else if (block.type === 'tool_use') {
          toolUsed = true;
          safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Executing ' + block.name + '...' });
          
          try {
            const result = await executeTool(block.name, block.input, tabId);
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
        safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
      }
    }
  } catch (err: any) {
    if (err.message === 'Aborted by user' || err.name === 'AbortError') {
      safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
      return;
    }
    safeSendMessage(tabId, { type: 'ECHO_SAY', text: 'Claude Error: ' + err.message });
    safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Error' });
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

    while (!isFinished) {
      if (steps++ >= MAX_STEPS) {
        safeSendMessage(tabId, { type: 'ECHO_SAY', text: "That took more steps than expected, so I've stopped. Want me to keep going?" });
        safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
        break;
      }
      compressGemini(currentGeminiConversation);
      let response: any;
      let succeeded = false;

      while (modelIndex < GEMINI_MODELS.length && !succeeded) {
        if (signal.aborted) throw new Error('Aborted by user');
        try {
          const functionDeclarations = SHARED_TOOLS.map(t => ({
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

      accumulateUsage(tabId, response.usageMetadata?.promptTokenCount || 0, response.usageMetadata?.candidatesTokenCount || 0);

      const content = response.candidates?.[0]?.content;
      if (!content) break;
      
      currentGeminiConversation.push({ role: "model", parts: content.parts || [] });

      const parts = content.parts ?? [];
      const calls = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);

      for (const p of parts) {
        if (p.text?.trim()) {
          if (signal.aborted) throw new Error('Aborted by user');
          safeSendMessage(tabId, { type: 'ECHO_SAY', text: p.text.trim() });
        }
      }

      if (!calls.length) {
        isFinished = true;
        safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
        break;
      }

      const responseParts: any[] = [];
      
      for (const call of calls) {
        if (!call || !call.name) continue;
        safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Executing ' + call.name + '...' });
        try {
          const result = await executeTool(call.name, call.args, tabId);
          if (call.name === 'screenshot' && result.dataUrl) {
             const base64Data = result.dataUrl.split(',')[1];
             responseParts.push({
               functionResponse: { name: call.name, response: { result: "Screenshot taken successfully." } }
             });
             responseParts.push({
               inlineData: { mimeType: 'image/png', data: base64Data }
             });
          } else {
             responseParts.push({
               functionResponse: { name: call.name, response: { result } }
             });
          }
        } catch (e: any) {
           responseParts.push({
             functionResponse: { name: call.name, response: { error: String(e.message || e) } }
           });
        }
      }
      
      currentGeminiConversation.push({ role: "user", parts: responseParts });
    }
  } catch (err: any) {
    if (err.message === 'Aborted by user' || err.name === 'AbortError') {
      safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
      return;
    }
    safeSendMessage(tabId, { type: 'ECHO_SAY', text: 'Gemini Error: ' + err.message });
    safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Error' });
  }
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
  try {
    // Build tools in OpenAI function-calling format
    const openaiTools = SHARED_TOOLS.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema
      }
    }));

    currentOpenAIConversation = pruneOpenAI(currentOpenAIConversation);
    currentOpenAIConversation.push({ role: 'user', content: userInput });

    let isFinished = false;
    let steps = 0;

    while (!isFinished) {
      if (signal.aborted) throw new Error('Aborted by user');
      if (steps++ >= MAX_STEPS) {
        safeSendMessage(tabId, { type: 'ECHO_SAY', text: "That took more steps than expected, so I've stopped. Want me to keep going?" });
        safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
        break;
      }

      // Collapse stale tool outputs so per-request size stays bounded.
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
          messages: [
            { role: 'system', content: systemPrompt },
            ...currentOpenAIConversation
          ],
          tools: openaiTools,
          tool_choice: 'auto',
          max_tokens: 900
        }),
        signal
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API Error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      accumulateUsage(tabId, data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0);
      const choice = data.choices?.[0];
      const msg = choice?.message;

      if (!msg) throw new Error('Empty response from API');

      currentOpenAIConversation.push(msg);

      // Handle text response
      if (msg.content && msg.content.trim()) {
        safeSendMessage(tabId, { type: 'ECHO_SAY', text: msg.content.trim() });
      }

      // Handle tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolResults: any[] = [];

        for (const tc of msg.tool_calls) {
          const toolName = tc.function.name;
          const toolArgs = JSON.parse(tc.function.arguments || '{}');

          safeSendMessage(tabId, { type: 'ECHO_STATE', state: `Executing ${toolName}...` });

          let resultContent: string;
          try {
            const result = await executeTool(toolName, toolArgs, tabId);
            if (toolName === 'screenshot' && result.dataUrl) {
              // For screenshot, we just tell the model it was taken (most free models don't support vision)
              resultContent = 'Screenshot captured. Note: Image vision may not be available on this model. Use read_screen for text-based analysis.';
            } else {
              resultContent = JSON.stringify(result);
            }
          } catch (e: any) {
            resultContent = 'Error: ' + e.message;
          }

          toolResults.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultContent
          });
        }

        // Push all tool results back
        currentOpenAIConversation.push(...toolResults);

      } else {
        // No tool calls — we're done
        isFinished = true;
        safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
      }
    }
  } catch (err: any) {
    if (err.message === 'Aborted by user' || err.name === 'AbortError') {
      safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Idle' });
      return;
    }
    safeSendMessage(tabId, { type: 'ECHO_SAY', text: 'AI Error: ' + err.message });
    safeSendMessage(tabId, { type: 'ECHO_STATE', state: 'Error' });
  }
}
