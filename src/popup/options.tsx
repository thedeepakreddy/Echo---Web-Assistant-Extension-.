import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './options.css';

type Provider = 'claude' | 'gemini' | 'togetherai' | 'openrouter' | 'groq';

const TOGETHER_MODELS = [
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', label: 'Llama 3.3 70B (Free)' },
  { id: 'meta-llama/Llama-Vision-Free', label: 'Llama Vision (Free)' },
  { id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B-Free', label: 'DeepSeek R1 Distill (Free)' },
];

const OPENROUTER_MODELS = [
  { id: 'openrouter/auto', label: 'Auto (Best Available Free Model) ⭐' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (Free)' },
  { id: 'deepseek/deepseek-chat-v3-0324:free', label: 'DeepSeek Chat V3 (Free)' },
  { id: 'google/gemma-3-27b-it:free', label: 'Gemma 3 27B (Free)' },
  { id: 'mistralai/mistral-7b-instruct:free', label: 'Mistral 7B (Free)' },
];

const GROQ_MODELS = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
  { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
  { id: 'gemma2-9b-it', label: 'Gemma 2 9B' },
  { id: 'llama3-70b-8192', label: 'Llama 3 70B' },
];

function Options() {
  const [provider, setProvider] = useState<Provider>('claude');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [togetherApiKey, setTogetherApiKey] = useState('');
  const [openrouterApiKey, setOpenrouterApiKey] = useState('');
  const [groqApiKey, setGroqApiKey] = useState('');
  const [togetherModel, setTogetherModel] = useState(TOGETHER_MODELS[0].id);
  const [openrouterModel, setOpenrouterModel] = useState(OPENROUTER_MODELS[0].id);
  const [groqModel, setGroqModel] = useState(GROQ_MODELS[0].id);
  const [handsfree, setHandsfree] = useState(false);
  const [status, setStatus] = useState('');
  // Local-first stack (tiers 0-2). Defaults on — this is what saves the quota.
  const [localFirst, setLocalFirst] = useState(true);
  const [useCache, setUseCache] = useState(true);
  const [useLocalLlm, setUseLocalLlm] = useState(true);
  const [autoIndex, setAutoIndex] = useState(true);
  const [passiveSuggest, setPassiveSuggest] = useState(true);
  const [report, setReport] = useState('');

  useEffect(() => {
    chrome.storage.local.get([
      'provider', 'anthropicApiKey', 'geminiApiKey',
      'togetherApiKey', 'openrouterApiKey', 'groqApiKey',
      'togetherModel', 'openrouterModel', 'groqModel', 'echo_handsfree'
    ], (result) => {
      if (result.provider) setProvider(result.provider as Provider);
      if (result.echo_handsfree) setHandsfree(result.echo_handsfree as boolean);
      if (result.anthropicApiKey) setAnthropicApiKey(result.anthropicApiKey as string);
      if (result.geminiApiKey) setGeminiApiKey(result.geminiApiKey as string);
      if (result.togetherApiKey) setTogetherApiKey(result.togetherApiKey as string);
      if (result.openrouterApiKey) setOpenrouterApiKey(result.openrouterApiKey as string);
      if (result.groqApiKey) setGroqApiKey(result.groqApiKey as string);
      if (result.togetherModel) setTogetherModel(result.togetherModel as string);
      if (result.openrouterModel) setOpenrouterModel(result.openrouterModel as string);
      if (result.groqModel) setGroqModel(result.groqModel as string);
    });

    // Router settings live under their own key and default to enabled.
    chrome.storage.local.get(['echo_local_settings'], (r) => {
      const s = (r.echo_local_settings || {}) as any;
      setLocalFirst(s.localFirst !== false);
      setUseCache(s.useCache !== false);
      setUseLocalLlm(s.useLocalLlm !== false);
      setAutoIndex(s.autoIndex !== false);
      setPassiveSuggest(s.passiveSuggest !== false);
    });

    chrome.runtime.sendMessage({ type: 'ECHO_ROUTER_REPORT' })
      .then((r: any) => { if (r?.text) setReport(r.text); })
      .catch(() => {});
  }, []);

  const saveOptions = () => {
    chrome.storage.local.set({
      provider,
      anthropicApiKey,
      geminiApiKey,
      togetherApiKey,
      openrouterApiKey,
      groqApiKey,
      togetherModel,
      openrouterModel,
      groqModel,
      echo_handsfree: handsfree,
      echo_local_settings: { localFirst, useCache, useLocalLlm, autoIndex, passiveSuggest },
    }, () => {
      setStatus('✓ Saved!');
      setTimeout(() => setStatus(''), 2000);
    });
  };

  const Toggle = ({ id, checked, onChange, label, hint }: {
    id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint: string;
  }) => (
    <div className="echo-toggle">
      <input id={id} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <div>
        <label htmlFor={id}>{label}</label>
        <small>{hint}</small>
      </div>
    </div>
  );

  return (
    <div className="options-container">
      <h2>ECHO Settings</h2>

      <div className="input-group">
        <label>Brain Provider</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
          <option value="claude">Anthropic Claude</option>
          <option value="gemini">Google Gemini (Free)</option>
          <option value="groq">Groq (Free & Fast)</option>
          <option value="togetherai">Together AI (Free)</option>
          <option value="openrouter">OpenRouter (Free)</option>
        </select>
      </div>

      {provider === 'claude' && (
        <div className="input-group">
          <label>Anthropic API Key</label>
          <input
            type="password"
            value={anthropicApiKey}
            onChange={(e) => setAnthropicApiKey(e.target.value)}
            placeholder="sk-ant-..."
          />
        </div>
      )}

      {provider === 'gemini' && (
        <div className="input-group">
          <label>Gemini API Key</label>
          <input
            type="password"
            value={geminiApiKey}
            onChange={(e) => setGeminiApiKey(e.target.value)}
            placeholder="AIzaSy..."
          />
          <small style={{ color: '#888', marginTop: '4px', display: 'block' }}>
            Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" style={{ color: '#4a90e2' }}>aistudio.google.com</a>
          </small>
        </div>
      )}

      {provider === 'togetherai' && (
        <>
          <div className="input-group">
            <label>Together AI API Key</label>
            <input
              type="password"
              value={togetherApiKey}
              onChange={(e) => setTogetherApiKey(e.target.value)}
              placeholder="together-..."
            />
            <small style={{ color: '#888', marginTop: '4px', display: 'block' }}>
              Get a free key at <a href="https://api.together.xyz" target="_blank" style={{ color: '#4a90e2' }}>api.together.xyz</a>
            </small>
          </div>
          <div className="input-group">
            <label>Model</label>
            <select value={togetherModel} onChange={(e) => setTogetherModel(e.target.value)}>
          {TOGETHER_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
        </>
      )}

      {provider === 'openrouter' && (
        <>
          <div className="input-group">
            <label>OpenRouter API Key</label>
            <input
              type="password"
              value={openrouterApiKey}
              onChange={(e) => setOpenrouterApiKey(e.target.value)}
              placeholder="sk-or-..."
            />
            <small style={{ color: '#888', marginTop: '4px', display: 'block' }}>
              Get a free key at <a href="https://openrouter.ai/keys" target="_blank" style={{ color: '#4a90e2' }}>openrouter.ai</a>
            </small>
          </div>
          <div className="input-group">
            <label>Model</label>
            <select value={openrouterModel} onChange={(e) => setOpenrouterModel(e.target.value)}>
              {OPENROUTER_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
        </>
      )}

      {provider === 'groq' && (
        <>
          <div className="input-group">
            <label>Groq API Key</label>
            <input
              type="password"
              value={groqApiKey}
              onChange={(e) => setGroqApiKey(e.target.value)}
              placeholder="gsk_..."
            />
            <small style={{ color: '#888', marginTop: '4px', display: 'block' }}>
              Get a free key at <a href="https://console.groq.com/keys" target="_blank" style={{ color: '#4a90e2' }}>console.groq.com</a>
            </small>
          </div>
          <div className="input-group">
            <label>Model</label>
            <select value={groqModel} onChange={(e) => setGroqModel(e.target.value)}>
              {GROQ_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
        </>
      )}

      <hr style={{ borderColor: '#333', margin: '18px 0 14px' }} />
      <h3 className="section-title">Local Brain — saves your API quota</h3>
      {report && <div className="router-report">{report.split('\n').map((l, i) => <div key={i}>{l}</div>)}</div>}

      <Toggle
        id="localFirst" checked={localFirst} onChange={setLocalFirst}
        label="Answer locally first"
        hint="Try instant, cached and on-device answers before spending API quota. Turn off to always use the cloud."
      />
      <Toggle
        id="useCache" checked={useCache} onChange={setUseCache}
        label="Reuse past answers"
        hint="Replay a stored answer when you ask the same thing again."
      />
      <Toggle
        id="useLocalLlm" checked={useLocalLlm} onChange={setUseLocalLlm}
        label="On-device summarising"
        hint="Summarise and answer page questions on your own machine — uses Chrome's built-in AI when available."
      />
      <Toggle
        id="autoIndex" checked={autoIndex} onChange={setAutoIndex}
        label="Remember pages you read"
        hint="Builds a private, local index so you can ask 'what was that article about…'. Never leaves your browser."
      />
      <Toggle
        id="passiveSuggest" checked={passiveSuggest} onChange={setPassiveSuggest}
        label="Proactive suggestions"
        hint="Offer help when a page has a long article or an empty form. No AI runs until you accept."
      />
      <Toggle
        id="handsfree" checked={handsfree} onChange={setHandsfree}
        label="Hands-free mode"
        hint="Re-open the mic automatically after ECHO finishes speaking."
      />

      <button onClick={saveOptions} style={{ marginBottom: '10px' }}>Save Settings</button>
      {status && <span className="status-msg">{status}</span>}

      <hr style={{ borderColor: '#444', margin: '20px 0' }} />

      <button
        onClick={() => {
          // Route through the background service worker so it flips the global
          // wake state and broadcasts to the active tab's content script.
          chrome.runtime.sendMessage({ type: 'WAKE_ECHO_REQUEST' }, () => {
            window.close();
          });
        }}
        style={{ background: '#4a90e2' }}
      >
        Wake ECHO on current page
      </button>

      <div className="help-text">
        <p>Or press <b>Cmd+Shift+E</b> on any webpage to wake ECHO.</p>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('popup-root')!);
root.render(<Options />);
