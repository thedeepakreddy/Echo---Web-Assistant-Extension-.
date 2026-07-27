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

// Open the side panel for the window that holds the given tab (or the active
// window). Must run in a user gesture (command / context-menu / action click).
async function openSidePanel(windowId?: number) {
  if (!chrome.sidePanel) return;
  try {
    if (windowId == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      windowId = tab?.windowId;
    }
    if (windowId != null) await chrome.sidePanel.open({ windowId });
  } catch (e) {
    console.warn('[ECHO] Could not open side panel:', e);
  }
}

// Wake the orb and pop the in-page command input on the active tab.
async function openCommandPalette() {
  isEchoAwake = true;
  await chrome.storage.session.set({ isEchoAwake });
  await broadcastWakeState();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'ECHO_OPEN_PALETTE' }).catch(() => {});
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'wake-echo') {
    isEchoAwake = !isEchoAwake;
    await chrome.storage.session.set({ isEchoAwake });
    await broadcastWakeState();
  } else if (command === 'open-panel') {
    await openSidePanel();
  } else if (command === 'command-palette') {
    await openCommandPalette();
  }
});

// Right-click context menus.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: 'echo-open-panel', title: 'Open ECHO chat panel', contexts: ['all'] });
    chrome.contextMenus.create({ id: 'echo-ask-selection', title: 'Ask ECHO about "%s"', contexts: ['selection'] });
  } catch { /* ignore duplicate-id on reload */ }
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'echo-open-panel') {
    await openSidePanel(tab?.windowId);
  } else if (info.menuItemId === 'echo-ask-selection' && info.selectionText) {
    await openSidePanel(tab?.windowId);
    processUserInput(`About this selected text: "${info.selectionText}"`, tab?.id);
  }
});

// 1x1 PNG data URI so chrome.notifications (type 'basic' requires an icon)
// never fails for lack of a packaged icon file.
const NOTIF_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Scheduled reminders fire here.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('echo_reminder_')) return;
  const { echo_reminders } = await chrome.storage.local.get(['echo_reminders']);
  const reminders = (echo_reminders || {}) as Record<string, any>;
  const reminder = reminders[alarm.name];
  if (!reminder) return;
  chrome.notifications.create(alarm.name, {
    type: 'basic',
    iconUrl: NOTIF_ICON,
    title: 'ECHO Reminder',
    message: reminder.taskName ? `${reminder.message}\n(Click to run: ${reminder.taskName})` : reminder.message,
    priority: 2
  });
});

// Clicking a reminder notification runs its attached saved task, if any.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const { echo_reminders, echo_tasks } = await chrome.storage.local.get(['echo_reminders', 'echo_tasks']);
  const reminder = ((echo_reminders || {}) as Record<string, any>)[notificationId];
  chrome.notifications.clear(notificationId);
  if (reminder?.taskName) {
    const instructions = ((echo_tasks || {}) as Record<string, string>)[reminder.taskName];
    if (instructions) {
      await openSidePanel();
      processUserInput(`Now carry out this saved task step by step:\n${instructions}`);
    }
  }
});

// Listen for messages from content script (e.g. ECHO requests from the UI)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_AWAKE_STATE') {
    sendResponse({ isAwake: isEchoAwake });
    return false; // synchronous response
  }

  if (message.type === 'WAKE_ECHO_REQUEST') {
    // Triggered by the options page "Wake ECHO" button.
    isEchoAwake = true;
    chrome.storage.session.set({ isEchoAwake });
    broadcastWakeState();
    sendResponse({ success: true });
    return false;
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
