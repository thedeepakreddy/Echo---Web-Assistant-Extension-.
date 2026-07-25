import React, { useState, useEffect, useRef } from 'react';
import './index.css';

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export function EchoUI() {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'speaking' | 'error'>('idle');
  const [inputText, setInputText] = useState('');
  const [chatVisible, setChatVisible] = useState(false);
  const [logText, setLogText] = useState('');
  const [position, setPosition] = useState({ x: window.innerWidth - 150, y: window.innerHeight - 150 });
  const positionRef = useRef(position);
  useEffect(() => { positionRef.current = position; }, [position]);
  const isDraggingRef = useRef(false);
  const dragStartPosRef = useRef({ x: 0, y: 0 });
  const dragStartMouseRef = useRef({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const submitBtnRef = useRef<HTMLButtonElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const logTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showLog = (text: string) => {
    setLogText(text);
    if (logTimerRef.current) clearTimeout(logTimerRef.current);
    logTimerRef.current = setTimeout(() => {
      setLogText('');
    }, 4000);
  };

  // Listen to iframe sandbox for speech events
  useEffect(() => {
    const handleSandboxMessage = (event: MessageEvent) => {
      // Security: ensure it comes from our extension
      if (event.origin !== `chrome-extension://${chrome.runtime.id}`) return;

      if (event.data.type === 'ECHO_SPEECH_START') {
        setStatus('listening');
      } else if (event.data.type === 'ECHO_SPEECH_RESULT') {
        setInputText(prev => prev + event.data.text + ' ');
      } else if (event.data.type === 'ECHO_SPEECH_ERROR') {
        console.error('[ECHO Speech Error]', event.data.error);
        setStatus('error');
        setTimeout(() => setStatus('idle'), 2000);
      } else if (event.data.type === 'ECHO_SPEECH_END') {
        setTimeout(() => {
          if (submitBtnRef.current) submitBtnRef.current.click();
        }, 100);
      }
    };

    window.addEventListener('message', handleSandboxMessage);
    return () => window.removeEventListener('message', handleSandboxMessage);
  }, []);



  useEffect(() => {
    // Check initial state
    chrome.runtime.sendMessage({ type: 'CHECK_AWAKE_STATE' }, (response) => {
      if (response?.isAwake) setVisible(true);
    });

    // Load initial position
    chrome.storage.local.get(['echo_position'], (res) => {
      if (res.echo_position) setPosition(res.echo_position as { x: number, y: number });
    });

    const handleMessage = (message: any) => {
      if (message.type === 'ECHO_GLOBAL_WAKE') {
        setVisible(message.state);
      } else if (message.type === 'ECHO_STATE') {
        if (message.state !== 'Idle') showLog(message.state);
        // Map brain status to reactor status
        if (message.state === 'Idle') {
          if (!window.speechSynthesis.speaking) setStatus('idle');
        }
        else if (message.state === 'Error') {
          setStatus('error');
          setTimeout(() => setStatus('idle'), 3000);
        }
        else setStatus('thinking'); // Thinking, Acting, etc.

      } else if (message.type === 'ECHO_SAY') {
        showLog(message.text);
        setStatus('speaking');
        
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(message.text);
        
        // Find a natural sounding voice
        const voices = window.speechSynthesis.getVoices();
        const preferredVoices = [
          'Google UK English Female',
          'Google US English', 
          'Samantha',
          'Karen',
          'Google UK English Male'
        ];
        
        let selectedVoice = null;
        for (const name of preferredVoices) {
          selectedVoice = voices.find(v => v.name === name);
          if (selectedVoice) break;
        }
        
        if (!selectedVoice) {
          selectedVoice = voices.find(v => v.lang.startsWith('en')) || voices[0];
        }
        
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }

        utterance.rate = 1.05;
        
        utterance.onend = () => {
          setStatus('idle');
        };
        
        window.speechSynthesis.speak(utterance);
      } else if (message.type === 'ECHO_SYNC_POSITION') {
        setPosition(message.position as { x: number, y: number });
      }
    };
    
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || status === 'thinking' || status === 'speaking') return;
    
    if (status === 'listening') {
      iframeRef.current?.contentWindow?.postMessage({ type: 'STOP_RECOGNITION' }, '*');
    }

    try {
      showLog(`You: ${inputText.trim()}`);
      chrome.runtime.sendMessage({ type: 'USER_INPUT', text: inputText });
    } catch (err) {
      console.error(err);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2000);
      return;
    }
    
    setInputText('');
    setChatVisible(false); // Hide chat after sending
    setStatus('thinking');
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    isDraggingRef.current = false;
    dragStartPosRef.current = { ...positionRef.current };
    dragStartMouseRef.current = { x: e.clientX, y: e.clientY };

    pressTimerRef.current = setTimeout(() => {
      if (!isDraggingRef.current) {
        setChatVisible(true);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }, 500);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUpWindow);
  };

  const handlePointerMove = (e: PointerEvent) => {
    const dx = e.clientX - dragStartMouseRef.current.x;
    const dy = e.clientY - dragStartMouseRef.current.y;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      isDraggingRef.current = true;
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    }

    if (isDraggingRef.current) {
      let newX = dragStartPosRef.current.x + dx;
      let newY = dragStartPosRef.current.y + dy;
      
      // keep within window bounds (approx)
      newX = Math.max(0, Math.min(newX, window.innerWidth - 100));
      newY = Math.max(0, Math.min(newY, window.innerHeight - 100));

      setPosition({ x: newX, y: newY });
    }
  };

  const handlePointerUpWindow = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUpWindow);
    
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);

    if (isDraggingRef.current) {
      // Save and broadcast
      const finalPos = positionRef.current;
      chrome.storage.local.set({ echo_position: finalPos });
      chrome.runtime.sendMessage({ type: 'ECHO_SYNC_POSITION', position: finalPos });
      
      // Prevent click from firing right after drag by delaying a reset flag
      setTimeout(() => {
        isDraggingRef.current = false;
      }, 50);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (isDraggingRef.current) {
      e.stopPropagation();
      return;
    }
    
    if (chatVisible) return;

    if (status === 'listening') {
      iframeRef.current?.contentWindow?.postMessage({ type: 'STOP_RECOGNITION' }, '*');
    } else if (window.speechSynthesis.speaking || status === 'thinking' || status === 'speaking' || status.startsWith('Executing')) {
      // Abort ongoing work and speech
      window.speechSynthesis.cancel();
      chrome.runtime.sendMessage({ type: 'ECHO_ABORT' });
      setStatus('idle');
    } else {
      setInputText('');
      iframeRef.current?.contentWindow?.postMessage({ type: 'START_RECOGNITION' }, '*');
    }
  };

  if (!visible) return null;

  return (
    <div 
      id="echo-root-wrapper" 
      data-status={status} 
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        pointerEvents: 'auto'
      }}
    >
      <iframe 
        ref={iframeRef}
        src={typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL('speech.html') : ''} 
        style={{ display: 'none' }}
        allow="microphone"
        title="ECHO Speech Sandbox"
      />
      
      <div id="echo-log-box" className={logText ? 'visible' : ''}>
        {logText}
      </div>

      <div id="echo-chat-box" className={chatVisible ? 'visible' : ''}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', width: '100%', gap: '8px' }}>
          <input 
            id="input" 
            ref={inputRef}
            type="text" 
            placeholder="Type a command…" 
            autoComplete="off" 
            spellCheck="false"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
          />
          <button ref={submitBtnRef} id="echo-send-btn" type="submit" title="Send" disabled={!inputText.trim()}>➤</button>
        </form>
      </div>

      <div 
        id="orb" 
        className="reactor" 
      >
        <div className="reactor-inner circle abs-center"></div>
        <div className="tunnel circle abs-center"></div>
        <div className="core-wrapper circle abs-center"></div>

        <div className="coil-container">
          <div className="coil coil-1"></div>
          <div className="coil coil-2"></div>
          <div className="coil coil-3"></div>
          <div className="coil coil-4"></div>
          <div className="coil coil-5"></div>
          <div className="coil coil-6"></div>
          <div className="coil coil-7"></div>
          <div className="coil coil-8"></div>
        </div>

        <div className="core-outer circle abs-center"></div>
        <div className="core-inner circle abs-center"></div>

        <div 
          className="core-hitbox circle abs-center"
          title="Click to talk, long-press to type, drag to move"
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          style={{ width: '45%', height: '45%', zIndex: 10, cursor: 'pointer', touchAction: 'none' }}
        ></div>
      </div>
    </div>
  );
}
