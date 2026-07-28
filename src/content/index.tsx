import React from 'react';
import { createRoot } from 'react-dom/client';
import { handleDomAction } from './actions';
import { EchoUI } from './ui';
import { initHighlighter, renderHighlights } from './highlighter';
import { initPassiveObserver } from './passive-observer';

// 1. DOM actions requested by the background (model tools AND the local stack).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DOM_ACTION') {
    try {
      const result = handleDomAction(message.action, message.args);
      sendResponse(result);
    } catch (e: any) {
      sendResponse({ success: false, error: e.message });
    }
    return true; // keep the channel open
  }

  // Background pushes back the highlights it has stored for this page.
  if (message.type === 'ECHO_APPLY_HIGHLIGHTS') {
    try {
      const painted = renderHighlights(message.texts || []);
      sendResponse({ success: true, painted });
    } catch {
      sendResponse({ success: false });
    }
    return true;
  }
});

// 2. Inject the React UI (reactor orb + chat + suggestion toast).
const initUI = () => {
  if (document.getElementById('echo-extension-root')) return;

  const container = document.createElement('div');
  container.id = 'echo-extension-root';
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100vw';
  container.style.height = '100vh';
  container.style.zIndex = '2147483647';
  container.style.pointerEvents = 'none'; // clicks pass through except on the orb

  document.body.appendChild(container);

  const root = createRoot(container);
  root.render(
    <div style={{ pointerEvents: 'auto' }}>
      <EchoUI />
    </div>
  );
};

// 3. Local-first features that run without any user action.
const initLocalFeatures = () => {
  chrome.storage.local.get(['echo_local_settings'], (r) => {
    const s = (r.echo_local_settings || {}) as any;
    const autoIndex = s.autoIndex !== false;
    const passive = s.passiveSuggest !== false;

    // Highlight capture is always on — it is purely local and user-initiated.
    initHighlighter();

    if (passive) initPassiveObserver();

    if (autoIndex) reportPageToKB();

    // Ask the background for any highlights saved on this page.
    chrome.runtime.sendMessage({ type: 'ECHO_GET_HIGHLIGHTS', url: location.href })
      .then((res: any) => {
        if (res?.texts?.length) renderHighlights(res.texts);
      })
      .catch(() => { /* background asleep — nothing to restore */ });
  });
};

/** Hand the readable text of this page to the background knowledge base. */
function reportPageToKB() {
  // Wait for the page to settle so SPAs have rendered their real content.
  setTimeout(() => {
    try {
      if (!/^https?:/.test(location.href)) return;
      const main = document.querySelector('article, main, [role="main"]') as HTMLElement | null;
      const source = main && main.innerText.length > 400 ? main : document.body;
      const text = (source?.innerText || '').replace(/\n\s*\n/g, '\n').trim();
      if (text.length < 250) return;
      chrome.runtime.sendMessage({
        type: 'ECHO_INDEX_PAGE',
        url: location.href,
        title: document.title,
        text: text.substring(0, 6000),
      }).catch(() => {});
    } catch { /* ignore */ }
  }, 2500);
}

const boot = () => { initUI(); initLocalFeatures(); };

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  boot();
} else {
  window.addEventListener('DOMContentLoaded', boot);
}
