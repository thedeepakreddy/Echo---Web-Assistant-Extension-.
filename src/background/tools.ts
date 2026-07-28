// Poll until a tab's status is 'complete' or the timeout fires.
// Resolves early on chrome.runtime.lastError so callers never hang.
function waitForTabLoad(tabId: number, timeout = 9000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.status === 'complete') { resolve(); return; }
        if (Date.now() - start > timeout) { resolve(); return; }
        setTimeout(poll, 300);
      });
    };
    setTimeout(poll, 700); // give the navigation a moment to start
  });
}

// Tools that run inside the page and are forwarded to the content script.
// The second group is used by the local (Tier 0/1) stack rather than the model.
const DOM_ACTIONS = new Set([
  'read_screen', 'click_element', 'type_text', 'press_key',
  'scroll', 'find_on_page', 'get_page_text', 'extract_table',
  'go_back', 'go_forward',
  // local-stack actions
  'extract_pattern', 'fill_form', 'click_selector', 'read_value',
  'record_start', 'record_stop', 'play_step',
  'render_highlights', 'clear_highlights',
]);

export async function executeTool(toolName: string, args: any, tabId?: number): Promise<any> {
  if (DOM_ACTIONS.has(toolName)) {
    if (!tabId) throw new Error('No active tab to execute action');
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: toolName, args }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response || !response.success) reject(new Error(response?.error || 'Action failed'));
        else resolve(response.result);
      });
    });
  }

  switch (toolName) {
    case 'screenshot': {
      // Capture the visible tab
      return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab({ format: 'png' }, (dataUrl) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve({ dataUrl });
        });
      });
    }

    case 'open_url': {
      // Create the tab, wait for it to fully load, then return the NEW tab's id.
      // The brain loops watch for `newTabId` in the result and update their
      // activeTabId so all subsequent DOM actions go to the right tab.
      const newTab = await new Promise<chrome.tabs.Tab>((resolve, reject) => {
        chrome.tabs.create({ url: args.url }, (tab) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(tab);
        });
      });
      await waitForTabLoad(newTab.id!);
      return { success: true, newTabId: newTab.id, message: `Opened ${args.url} in a new tab (id: ${newTab.id}). Use read_screen now to see it.` };
    }

    case 'navigate': {
      if (!tabId) throw new Error('No active tab to navigate');
      await new Promise<void>((resolve, reject) => {
        chrome.tabs.update(tabId, { url: args.url }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      // Wait for the page to finish loading before the brain calls read_screen.
      await waitForTabLoad(tabId);
      return { success: true, message: `Navigated to ${args.url} — page loaded, ready for read_screen.` };
    }

    case 'list_tabs': {
      return new Promise((resolve, reject) => {
        chrome.tabs.query({}, (tabs) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          const list = tabs.slice(0, 30).map(t => ({
            id: t.id,
            title: (t.title || '').substring(0, 70),
            url: (t.url || '').substring(0, 120),
            active: t.active
          }));
          resolve({ success: true, tabs: list });
        });
      });
    }

    case 'switch_tab': {
      return new Promise((resolve, reject) => {
        chrome.tabs.update(Number(args.tabId), { active: true }, (tab) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (tab?.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
          resolve({ success: true, message: `Switched to tab ${args.tabId}` });
        });
      });
    }

    case 'close_tab': {
      return new Promise((resolve, reject) => {
        chrome.tabs.remove(Number(args.tabId), () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve({ success: true, message: `Closed tab ${args.tabId}` });
        });
      });
    }

    case 'download_data': {
      const content = String(args.content ?? '');
      const filename = String(args.filename || 'echo-download.txt');
      const mime = filename.endsWith('.json') ? 'application/json'
        : filename.endsWith('.csv') ? 'text/csv' : 'text/plain';
      const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
      return new Promise((resolve, reject) => {
        chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve({ success: true, message: `Downloaded ${filename}`, downloadId: id });
        });
      });
    }

    case 'list_memory': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_memory'], (result) => {
          const memory = (result.echo_memory || {}) as Record<string, string>;
          resolve({ success: true, memory });
        });
      });
    }

    case 'save_task': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_tasks'], (r) => {
          const tasks = (r.echo_tasks || {}) as Record<string, string>;
          tasks[args.name] = args.instructions;
          chrome.storage.local.set({ echo_tasks: tasks }, () =>
            resolve({ success: true, message: `Saved task '${args.name}'.` }));
        });
      });
    }

    case 'list_tasks': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_tasks'], (r) =>
          resolve({ success: true, tasks: (r.echo_tasks || {}) as Record<string, string> }));
      });
    }

    case 'delete_task': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_tasks'], (r) => {
          const tasks = (r.echo_tasks || {}) as Record<string, string>;
          delete tasks[args.name];
          chrome.storage.local.set({ echo_tasks: tasks }, () =>
            resolve({ success: true, message: `Deleted task '${args.name}'.` }));
        });
      });
    }

    case 'run_task': {
      // Returns the saved instructions so the model can carry them out in the
      // same loop with its normal tools (no nested agent invocation).
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_tasks'], (r) => {
          const tasks = (r.echo_tasks || {}) as Record<string, string>;
          const instructions = tasks[args.name];
          if (!instructions) resolve({ success: true, result: `No saved task named '${args.name}'. Saved tasks: ${Object.keys(tasks).join(', ') || '(none)'}` });
          else resolve({ success: true, result: `Now carry out this saved task step by step:\n${instructions}` });
        });
      });
    }

    case 'schedule_reminder': {
      const minutes = Math.max(0.5, Number(args.in_minutes) || 1);
      const alarmName = `echo_reminder_${Date.now()}`;
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_reminders'], (r) => {
          const reminders = (r.echo_reminders || {}) as Record<string, any>;
          reminders[alarmName] = { message: args.message || 'ECHO reminder', taskName: args.task_name || null };
          chrome.storage.local.set({ echo_reminders: reminders }, () => {
            chrome.alarms.create(alarmName, { delayInMinutes: minutes });
            resolve({ success: true, message: `Reminder set for ~${minutes} min from now.` });
          });
        });
      });
    }

    case 'save_memory': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_memory'], (result) => {
          const memory: Record<string, string> = (result.echo_memory || {}) as Record<string, string>;
          memory[args.key] = args.value;
          chrome.storage.local.set({ echo_memory: memory }, () => {
            resolve({ success: true, message: `Saved '${args.key}' to memory.` });
          });
        });
      });
    }

    case 'delete_memory': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_memory'], (result) => {
          const memory: Record<string, string> = (result.echo_memory || {}) as Record<string, string>;
          delete memory[args.key];
          chrome.storage.local.set({ echo_memory: memory }, () => {
            resolve({ success: true, message: `Deleted '${args.key}' from memory.` });
          });
        });
      });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
