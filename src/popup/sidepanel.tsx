import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './sidepanel.css';

interface Msg { role: 'user' | 'echo'; text: string; ts?: number; tier?: number }

// Which brain answered. Tier 3 is the only one that spends API quota.
const TIERS: Record<number, { label: string; title: string; cls: string }> = {
  0: { label: 'instant', title: 'Answered locally — no AI, no API', cls: 't0' },
  1: { label: 'cached', title: 'Replayed from a stored answer — no API', cls: 't1' },
  2: { label: 'on-device', title: 'Answered by the on-device model — no API', cls: 't2' },
  3: { label: 'cloud', title: 'Answered by the cloud API — used quota', cls: 't3' },
};

function Panel() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const [usage, setUsage] = useState<{ steps: number; taskTokens: number; sessionTokens: number } | null>(null);
  const [report, setReport] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

  const refreshReport = () => {
    chrome.runtime.sendMessage({ type: 'ECHO_ROUTER_REPORT' })
      .then((r: any) => { if (r?.text) setReport(r.text); })
      .catch(() => {});
  };

  // Load persisted transcript on open, then listen for live updates.
  useEffect(() => {
    chrome.storage.local.get(['echo_transcript'], (r) => {
      if (Array.isArray(r.echo_transcript)) setMessages(r.echo_transcript as Msg[]);
    });
    refreshReport();

    const onMessage = (m: any) => {
      if (m.type === 'ECHO_SAY') {
        setMessages(prev => [...prev, { role: 'echo', text: m.text, tier: m.tier }]);
        refreshReport();
      } else if (m.type === 'ECHO_USER_ECHO') {
        setMessages(prev => [...prev, { role: 'user', text: m.text }]);
      } else if (m.type === 'ECHO_STATE') {
        setStatus(m.state === 'Idle' ? '' : m.state);
      } else if (m.type === 'ECHO_USAGE') {
        setUsage({ steps: m.steps, taskTokens: m.taskTokens, sessionTokens: m.sessionTokens });
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  const send = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = input.trim();
    if (!text) return;
    chrome.runtime.sendMessage({ type: 'USER_INPUT', text });
    setInput('');
    setStatus('Thinking...');
    setUsage(u => (u ? { ...u, steps: 0, taskTokens: 0 } : u)); // reset task portion; keep session
  };

  const clearTranscript = () => {
    chrome.storage.local.set({ echo_transcript: [] });
    setMessages([]);
    setStatus('');
  };

  const reportLines = report ? report.split('\n') : [];

  return (
    <div className="echo-panel">
      <header className="echo-panel-header">
        <span className="echo-dot" /> ECHO
        <button className="echo-clear" onClick={clearTranscript} title="Clear conversation">Clear</button>
      </header>

      {reportLines.length > 0 && (
        <div className="echo-router" title="How many requests were answered without spending API quota">
          <div className="echo-router-main">🧠 {reportLines[0]}</div>
          {reportLines[1] && <div className="echo-router-sub">{reportLines[1]}</div>}
        </div>
      )}

      {usage && (
        <div className="echo-usage" title="Cloud API usage — steps are API round-trips this task">
          ⚡ {usage.steps} {usage.steps === 1 ? 'step' : 'steps'} · {fmt(usage.taskTokens)} tokens this task
          <span className="echo-usage-session"> · {fmt(usage.sessionTokens)} session</span>
        </div>
      )}

      <div className="echo-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="echo-empty">
            Ask ECHO anything, or give it a task on the current page.<br />
            Try <b>"summarize this page"</b>, <b>"extract emails"</b>,<br />
            <b>"record a workflow"</b> or <b>"watch this page"</b>.
          </div>
        )}
        {messages.map((m, i) => {
          const tier = m.role === 'echo' && m.tier !== undefined ? TIERS[m.tier] : null;
          return (
            <div key={i} className={`echo-msg ${m.role}`}>
              <div className="echo-bubble">
                {m.text}
                {tier && <span className={`echo-tier ${tier.cls}`} title={tier.title}>{tier.label}</span>}
              </div>
            </div>
          );
        })}
        {status && <div className="echo-status">{status}</div>}
      </div>

      <form className="echo-input-row" onSubmit={send}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Message ECHO…"
          autoFocus
        />
        <button type="submit" disabled={!input.trim()}>➤</button>
      </form>
    </div>
  );
}

const root = createRoot(document.getElementById('echo-panel-root')!);
root.render(<Panel />);
