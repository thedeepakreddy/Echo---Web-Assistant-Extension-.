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
  const [status, setStatus] = useState('');

  useEffect(() => {
    chrome.storage.local.get([
      'provider', 'anthropicApiKey', 'geminiApiKey',
      'togetherApiKey', 'openrouterApiKey', 'groqApiKey',
      'togetherModel', 'openrouterModel', 'groqModel'
    ], (result) => {
      if (result.provider) setProvider(result.provider as Provider);
      if (result.anthropicApiKey) setAnthropicApiKey(result.anthropicApiKey as string);
      if (result.geminiApiKey) setGeminiApiKey(result.geminiApiKey as string);
      if (result.togetherApiKey) setTogetherApiKey(result.togetherApiKey as string);
      if (result.openrouterApiKey) setOpenrouterApiKey(result.openrouterApiKey as string);
      if (result.groqApiKey) setGroqApiKey(result.groqApiKey as string);
      if (result.togetherModel) setTogetherModel(result.togetherModel as string);
      if (result.openrouterModel) setOpenrouterModel(result.openrouterModel as string);
      if (result.groqModel) setGroqModel(result.groqModel as string);
    });
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
    }, () => {
      setStatus('✓ Saved!');
      setTimeout(() => setStatus(''), 2000);
    });
  };

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

      <button onClick={saveOptions} style={{ marginBottom: '10px' }}>Save Settings</button>
      {status && <span className="status-msg">{status}</span>}

      <hr style={{ borderColor: '#444', margin: '20px 0' }} />

      <button
        onClick={() => {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && tabs[0].id) {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'WAKE_ECHO' }).catch(() => {
                setStatus('Failed to wake. Refresh the page!');
              });
              window.close();
            }
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
