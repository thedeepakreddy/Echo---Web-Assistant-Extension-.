import React from 'react';
import { createRoot } from 'react-dom/client';
import { handleDomAction } from './actions';
import { EchoUI } from './ui';

// 1. Setup DOM Listener for AI Actions
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Background forwards page actions as { type: 'DOM_ACTION', action, args }.
  if (message.type === 'DOM_ACTION') {
    try {
      const result = handleDomAction(message.action, message.args);
      sendResponse(result);
    } catch (e: any) {
      sendResponse({ success: false, error: e.message });
    }
    return true; // Keep message channel open for async response
  }
});

// 2. Inject React UI globally
const initUI = () => {
  const container = document.createElement('div');
  container.id = 'echo-extension-root';
  // Ensure the container itself floats above everything so it's not affected by page flow
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100vw';
  container.style.height = '100vh';
  container.style.zIndex = '2147483647';
  container.style.pointerEvents = 'none'; // Let clicks pass through if not on the reactor itself
  
  document.body.appendChild(container);

  const root = createRoot(container);
  
  // We wrap EchoUI in a div with pointerEvents: auto so the reactor is clickable,
  // while the rest of the invisible container lets clicks pass through to the page.
  root.render(
    <div style={{ pointerEvents: 'auto' }}>
      <EchoUI />
    </div>
  );
};

// Wait for DOM to be ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initUI();
} else {
  window.addEventListener('DOMContentLoaded', initUI);
}
