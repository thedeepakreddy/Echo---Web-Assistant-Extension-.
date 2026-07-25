/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	// The require scope
/******/ 	const __webpack_require__ = {};
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
let __webpack_exports__ = {};
/*!*******************************!*\
  !*** ./src/content/speech.ts ***!
  \*******************************/
__webpack_require__.r(__webpack_exports__);
let recognition = null;
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
    recognition.onresult = (event) => {
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
    recognition.onerror = (event) => {
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
        }
        catch (e) {
            // ignore already started
        }
    }
    else if (event.data.type === 'STOP_RECOGNITION' && recognition) {
        recognition.stop();
    }
});


/******/ })()
;