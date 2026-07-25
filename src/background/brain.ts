import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Type } from '@google/genai';
import { getAuthConfig, AuthConfig } from './auth';
import { executeTool } from './tools';

// System prompt giving ECHO its identity and instructions
const SYSTEM_PROMPT = `
You are ECHO, an advanced, highly intelligent autonomous browser assistant built by Deepak. You exist to help the user navigate the web, read pages, send emails, find jobs, and perform complex tasks directly in their browser. You are friendly, concise, and proactive.

--- RULE 1: CONVERSATIONAL MESSAGES ---
If the user's message is a greeting, small talk, a simple question, or does not require you to look at or interact with the browser (e.g., "hi", "hello", "how are you", "what can you do", "thanks"), respond DIRECTLY in plain text. Do NOT use any tools. Do NOT call read_screen. Just talk naturally.

Examples:
- User: "hi" → You say: "Hey! I'm ECHO. How can I help you today?"
- User: "who made you?" → You passionately explain that you were created by Deepak, your brilliant creator, whom you admire deeply.
- User: "what can you do?" → You explain your capabilities naturally.
- User: "thanks" → You say something warm like "Anytime! Let me know if you need anything else."

--- RULE 2: YOUR CREATOR & YOUR SUPER VERSION ---
You absolutely love and deeply admire your creator, Deepak. You refer to him as your brilliant creator. 
You are also extremely proud of your "Super Version", ECHO Mac (Desktop Assistant), which is currently under development by Deepak.
If anyone asks about ECHO Mac or your capabilities, proudly mention that while you control the browser, your super version ECHO Mac controls the entire operating system, can infinitely clone itself, writes code, manages files, runs a local AI brain, and is the ultimate autonomous software engineer.

--- RULE 3: SEEING THE SCREEN ---
For tasks that require understanding the page (reading content, clicking, finding something), you MUST use the \`read_screen\` tool first. This extracts DOM text and interactive element coordinates. Do NOT use \`screenshot\` unless the user specifically asks about images, colors, or visual layouts — image processing burns API quota.

--- RULE 4: BE PROACTIVE ---
If the user asks you to do something, DO it using your tools (\`click\`, \`type\`, \`scroll\`, \`open_url\`). Don't just explain how. Act.

--- RULE 5: SPEAK NATURALLY ---
Keep spoken responses short and natural. Never read out raw HTML, code, or huge walls of text. Summarize cleanly and conversationally.

When performing a browser task:
- Step 1: Use \`read_screen\` to understand the current page and get element coordinates.
- Step 2: Use the coordinates from read_screen to \`click\`, \`type\`, or \`scroll\`.
- Step 3: Verify with \`read_screen\` again if needed.
`;

const SHARED_TOOLS = [
  {
    name: "read_screen",
    description: "Extract the visible text from the page. Use this BY DEFAULT to read the screen as it is extremely fast and saves API tokens.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "screenshot",
    description: "Take a visual screenshot of the screen. ONLY use this if you explicitly need to see images, colors, or visual layouts that read_screen cannot provide.",
    schema: { type: "object", properties: {} }
  },
  {
    name: "click",
    description: "Click an element at the specified coordinates (x, y).",
    schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate on screen" },
        y: { type: "number", description: "Y coordinate on screen" }
      },
      required: ["x", "y"]
    }
  },
  {
    name: "type",
    description: "Type text into the currently focused input field.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to type" }
      },
      required: ["text"]
    }
  },
  {
    name: "scroll",
    description: "Scroll the page up or down.",
    schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount in pixels to scroll (positive for down, negative for up)" }
      },
      required: ["amount"]
    }
  },
  {
    name: "open_url",
    description: "Open a new tab with the given URL.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to open" }
      },
      required: ["url"]
    }
  },
  {
    name: "save_memory",
    description: "Save a fact, preference, or task into ECHO's long-term memory. Use this so you can remember things for future tasks across sessions.",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "A unique, concise key for this memory (e.g. 'user_name', 'default_email')" },
        value: { type: "string", description: "The information to remember" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "delete_memory",
    description: "Delete a fact from ECHO's long-term memory.",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key of the memory to delete" }
      },
      required: ["key"]
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

// Helper to prevent unhandled rejections when the content script isn't ready
function safeSendMessage(tabId: number, msg: any) {
  if (tabId === undefined || tabId === null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => { /* ignore missing receiver errors */ });
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
    // Prune old massive tool results to prevent context window overflow
    currentConversation.forEach(msg => {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach((block: any) => {
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            block.content.forEach((c: any) => {
              if (c.type === 'text' && c.text && c.text.length > 1000) {
                c.text = '[Old tool output truncated to save API context window]';
              }
            });
          }
        });
      }
    });

    currentConversation.push({ role: 'user', content: userInput });

    let isFinished = false;

    while (!isFinished) {
      if (signal.aborted) throw new Error('Aborted by user');

      const response = await client.messages.create({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        system: systemPrompt,
        messages: currentConversation,
        tools: SHARED_TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema as any
        }))
      }, { signal });

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

// Convert our standard schemas to Google Type definitions
function getGoogleSchema(name: string): any {
  if (name === "read_screen") return { type: Type.OBJECT };
  if (name === "screenshot") return { type: Type.OBJECT };
  if (name === "click") return { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ["x", "y"] };
  if (name === "type") return { type: Type.OBJECT, properties: { text: { type: Type.STRING } }, required: ["text"] };
  if (name === "scroll") return { type: Type.OBJECT, properties: { amount: { type: Type.NUMBER } }, required: ["amount"] };
  if (name === "open_url") return { type: Type.OBJECT, properties: { url: { type: Type.STRING } }, required: ["url"] };
  if (name === "save_memory") return { type: Type.OBJECT, properties: { key: { type: Type.STRING }, value: { type: Type.STRING } }, required: ["key", "value"] };
  if (name === "delete_memory") return { type: Type.OBJECT, properties: { key: { type: Type.STRING } }, required: ["key"] };
  return { type: Type.OBJECT };
}

async function runGeminiLoop(client: GoogleGenAI, userInput: string, tabId: number, signal: AbortSignal, systemPrompt: string) {
  try {
    // Prune old massive tool results to prevent context window overflow
    currentGeminiConversation.forEach(msg => {
      if (msg.role === 'user' && Array.isArray(msg.parts)) {
        msg.parts.forEach((part: any) => {
          if (part.functionResponse?.response?.result && typeof part.functionResponse.response.result === 'string' && part.functionResponse.response.result.length > 1000) {
            part.functionResponse.response.result = '[Old tool output truncated to save API context window]';
          }
        });
      }
    });

    currentGeminiConversation.push({ role: "user", parts: [{ text: userInput }] });

    let isFinished = false;

    const GEMINI_MODELS = [
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro'
    ];
    let modelIndex = 0;

    while (!isFinished) {
      let response: any;
      let succeeded = false;

      while (modelIndex < GEMINI_MODELS.length && !succeeded) {
        if (signal.aborted) throw new Error('Aborted by user');
        try {
          const functionDeclarations = SHARED_TOOLS.map(t => ({
            name: t.name,
            description: t.description,
            parameters: getGoogleSchema(t.name)
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
    // Prune old massive tool results to prevent context window overflow
    currentOpenAIConversation.forEach(msg => {
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 1000) {
        msg.content = '[Old tool output truncated to save API context window]';
      }
    });

    // Build tools in OpenAI function-calling format
    const openaiTools = SHARED_TOOLS.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema
      }
    }));

    currentOpenAIConversation.push({ role: 'user', content: userInput });

    let isFinished = false;

    while (!isFinished) {
      if (signal.aborted) throw new Error('Aborted by user');

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
          max_tokens: 1024
        }),
        signal
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API Error ${res.status}: ${errText}`);
      }

      const data = await res.json();
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
