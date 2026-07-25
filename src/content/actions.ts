export function handleDomAction(action: string, args: any): any {
  switch (action) {
    case 'read_screen': {
      // Extract visible interactive elements with their center coordinates
      const interactables = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [onclick]'));
      
      let screenInfo = 'Interactive Elements:\n';
      let count = 0;
      
      for (const el of interactables) {
        if (count >= 60) break; // Hard limit to prevent token exhaustion
        const rect = (el as Element).getBoundingClientRect();
        
        // Only include elements mostly in viewport
        if (rect.width > 0 && rect.height > 0 && rect.top >= -50 && rect.bottom <= window.innerHeight + 50) {
          const anyEl = el as any;
          const text = (anyEl.innerText || anyEl.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.id || el.tagName).replace(/\s+/g, ' ').trim();
          if (text) {
            const cx = Math.round(rect.left + rect.width / 2);
            const cy = Math.round(rect.top + rect.height / 2);
            screenInfo += `[${cx}, ${cy}] ${text.substring(0, 40)}\n`;
            count++;
          }
        }
      }

      // Add general page text for context (truncated heavily for free models)
      let pageText = document.body.innerText || '';
      pageText = pageText.replace(/\n\s*\n/g, '\n').substring(0, 1000);
      
      const finalResult = screenInfo + '\n--- Text Context ---\n' + pageText;
      return { success: true, result: finalResult };
    }

    case 'click': {
      // Find element at coordinates
      const el = document.elementFromPoint(args.x, args.y) as HTMLElement;
      if (el) {
        el.click();
        return { success: true, message: `Clicked at (${args.x}, ${args.y})` };
      }
      return { success: false, error: 'No element found at coordinates' };
    }
    
    case 'type': {
      const activeEl = document.activeElement as HTMLInputElement | HTMLTextAreaElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
        if (activeEl.isContentEditable) {
            activeEl.textContent = (activeEl.textContent || '') + args.text;
        } else {
            activeEl.value += args.text;
        }
        // Dispatch events to trigger framework updates (React, etc.)
        activeEl.dispatchEvent(new Event('input', { bubbles: true }));
        activeEl.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, message: 'Typed text' };
      }
      return { success: false, error: 'No input element focused' };
    }

    case 'scroll': {
      window.scrollBy({
        top: args.amount,
        behavior: 'smooth'
      });
      return { success: true, message: 'Scrolled' };
    }

    default:
      throw new Error(`Unknown DOM action: ${action}`);
  }
}
