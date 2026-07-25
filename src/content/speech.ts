export {};
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

let recognition: any = null;

// Initialize SpeechRecognition
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    window.parent.postMessage({ type: 'ECHO_SPEECH_START' }, '*');
  };

  recognition.onresult = (event: any) => {
    let finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      }
    }
    if (finalTranscript) {
      window.parent.postMessage({ type: 'ECHO_SPEECH_RESULT', text: finalTranscript }, '*');
    }
  };

  recognition.onerror = (event: any) => {
    window.parent.postMessage({ type: 'ECHO_SPEECH_ERROR', error: event.error }, '*');
  };

  recognition.onend = () => {
    window.parent.postMessage({ type: 'ECHO_SPEECH_END' }, '*');
  };
}

window.addEventListener('message', (event) => {
  if (event.data.type === 'START_RECOGNITION' && recognition) {
    try {
      recognition.start();
    } catch (e) {
      // ignore already started
    }
  } else if (event.data.type === 'STOP_RECOGNITION' && recognition) {
    recognition.stop();
  }
});
