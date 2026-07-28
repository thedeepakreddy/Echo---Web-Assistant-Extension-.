import { executeTool } from './tools';
import { processUserInput, abortCurrentWork } from './brain';
import { routeUserInput, ingestPage, getSettings, setSettings, routerReport } from './smart-router';
import { saveHighlight, highlightsForUrl } from './highlights';
import { runWatcherCheck, rehydrateWatchers, WATCH_ALARM_PREFIX, listWatchers } from './page-watcher';
import { cachePrune } from './response-cache';
import { say } from './bus';

console.log('ECHO Background Service Worker initialized.');

let isEchoAwake = false;

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
    chrome.contextMenus.create({ id: 'echo-save-highlight', title: 'Save "%s" to ECHO highlights', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'echo-fill-form', title: 'Fill this form with ECHO', contexts: ['editable', 'page'] });
    chrome.contextMenus.create({ id: 'echo-summarize', title: 'Summarize this page (no API)', contexts: ['page'] });
  } catch { /* ignore duplicate-id on reload */ }
  // Housekeeping on install/update.
  cachePrune().catch(() => {});
  rehydrateWatchers().catch(() => {});
});

// Alarms and watchers survive restarts; re-arm them when the worker wakes.
chrome.runtime.onStartup?.addListener(() => {
  rehydrateWatchers().catch(() => {});
  cachePrune().catch(() => {});
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'echo-open-panel') {
    await openSidePanel(tab?.windowId);
  } else if (info.menuItemId === 'echo-ask-selection' && info.selectionText) {
    await openSidePanel(tab?.windowId);
    routeUserInput(`About this selected text: "${info.selectionText}"`, tab?.id);
  } else if (info.menuItemId === 'echo-save-highlight' && info.selectionText) {
    const h = await saveHighlight(info.pageUrl || tab?.url || '', tab?.title || '', info.selectionText);
    say(tab?.id, `Saved that highlight.`, 0);
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'ECHO_APPLY_HIGHLIGHTS', texts: [h.text] }).catch(() => {});
    }
  } else if (info.menuItemId === 'echo-fill-form') {
    routeUserInput('fill this form', tab?.id);
  } else if (info.menuItemId === 'echo-summarize') {
    routeUserInput('summarize this page', tab?.id);
  }
});

// 1x1 PNG data URI so chrome.notifications (type 'basic' requires an icon)
// never fails for lack of a packaged icon file.
const NOTIF_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Alarms: scheduled reminders AND page watchers land here.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(WATCH_ALARM_PREFIX)) {
    await runWatcherCheck(alarm.name).catch(() => {});
    return;
  }
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

// Clicking a notification: reminders run their task, watchers open their page.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);

  if (notificationId.startsWith(WATCH_ALARM_PREFIX)) {
    const watchers = await listWatchers();
    const w = watchers[notificationId];
    if (w?.url) chrome.tabs.create({ url: w.url });
    return;
  }

  const { echo_reminders, echo_tasks } = await chrome.storage.local.get(['echo_reminders', 'echo_tasks']);
  const reminder = ((echo_reminders || {}) as Record<string, any>)[notificationId];
  if (reminder?.taskName) {
    const instructions = ((echo_tasks || {}) as Record<string, string>)[reminder.taskName];
    if (instructions) {
      await openSidePanel();
      routeUserInput(`Now carry out this saved task step by step:\n${instructions}`);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_AWAKE_STATE') {
    sendResponse({ isAwake: isEchoAwake });
    return false;
  }

  if (message.type === 'WAKE_ECHO_REQUEST') {
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
    return true;
  }

  // Every user request now enters through the router, which spends the
  // cheapest tier that can answer it and only reaches the cloud when needed.
  if (message.type === 'USER_INPUT') {
    routeUserInput(message.text, sender.tab?.id);
    sendResponse({ success: true });
    return false;
  }

  // Escape hatch: force the cloud brain, bypassing tiers 0-2.
  if (message.type === 'USER_INPUT_CLOUD') {
    processUserInput(message.text, sender.tab?.id);
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'ECHO_ABORT') {
    abortCurrentWork();
    sendResponse({ success: true });
    return false;
  }

  // --- local stack plumbing ------------------------------------------------

  if (message.type === 'ECHO_INDEX_PAGE') {
    ingestPage(message.url, message.title, message.text).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'ECHO_SAVE_HIGHLIGHT') {
    saveHighlight(message.url, message.title, message.text)
      .then(h => sendResponse({ success: true, id: h.id }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'ECHO_GET_HIGHLIGHTS') {
    highlightsForUrl(message.url)
      .then(list => sendResponse({ success: true, texts: list.map(h => h.text) }))
      .catch(() => sendResponse({ success: true, texts: [] }));
    return true;
  }

  if (message.type === 'ECHO_GET_SETTINGS') {
    getSettings().then(s => sendResponse({ success: true, settings: s }));
    return true;
  }

  if (message.type === 'ECHO_SET_SETTINGS') {
    setSettings(message.patch || {}).then(s => sendResponse({ success: true, settings: s }));
    return true;
  }

  if (message.type === 'ECHO_ROUTER_REPORT') {
    routerReport().then(text => sendResponse({ success: true, text }));
    return true;
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
    return false;
  }
});
