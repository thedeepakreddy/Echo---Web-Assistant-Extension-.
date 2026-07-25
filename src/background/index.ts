import { executeTool } from './tools';
import { processUserInput, abortCurrentWork } from './brain';

console.log('ECHO Background Service Worker initialized.');

let isEchoAwake = false;

// Initialize state in session storage
chrome.storage.session.set({ isEchoAwake });

const broadcastWakeState = async () => {
  const tabs = await chrome.tabs.query({});
  tabs.forEach(t => {
    if (t.id) {
      chrome.tabs.sendMessage(t.id, { type: 'ECHO_GLOBAL_WAKE', state: isEchoAwake }).catch(() => {});
    }
  });
};

chrome.action.onClicked.addListener(async () => {
  isEchoAwake = !isEchoAwake;
  await chrome.storage.session.set({ isEchoAwake });
  await broadcastWakeState();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'wake-echo') {
    isEchoAwake = !isEchoAwake;
    await chrome.storage.session.set({ isEchoAwake });
    await broadcastWakeState();
  }
});

// Listen for messages from content script (e.g. ECHO requests from the UI)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_AWAKE_STATE') {
    sendResponse({ isAwake: isEchoAwake });
    return false; // synchronous response
  }

  if (message.type === 'EXECUTE_TOOL') {
    executeTool(message.toolName, message.args, sender.tab?.id)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (message.type === 'USER_INPUT') {
    processUserInput(message.text, sender.tab?.id);
    sendResponse({ success: true });
  }

  if (message.type === 'ECHO_ABORT') {
    abortCurrentWork();
    sendResponse({ success: true });
  }

  if (message.type === 'ECHO_SYNC_POSITION') {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id && tab.id !== sender.tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'ECHO_SYNC_POSITION', position: message.position }).catch(() => {});
        }
      });
    });
    sendResponse({ success: true });
  }
});
