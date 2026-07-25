export async function executeTool(toolName: string, args: any, tabId?: number): Promise<any> {
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
      return new Promise((resolve, reject) => {
        chrome.tabs.create({ url: args.url }, (tab) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve({ tabId: tab.id });
        });
      });
    }

    case 'read_screen':
    case 'click':
    case 'type':
    case 'scroll': {
      if (!tabId) throw new Error('No active tab to execute action');
      // Forward the action to the content script to execute on the DOM
      return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: toolName, args }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (!response || !response.success) reject(new Error(response?.error || 'Action failed'));
          else resolve(response.result);
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
