export interface AuthConfig {
  provider: 'claude' | 'gemini' | 'togetherai' | 'openrouter' | 'groq';
  anthropicApiKey?: string;
  geminiApiKey?: string;
  togetherApiKey?: string;
  openrouterApiKey?: string;
  groqApiKey?: string;
  togetherModel?: string;
  openrouterModel?: string;
  groqModel?: string;
}

export function getAuthConfig(): Promise<AuthConfig> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['provider', 'anthropicApiKey', 'geminiApiKey', 'togetherApiKey', 'openrouterApiKey', 'groqApiKey', 'togetherModel', 'openrouterModel', 'groqModel'], (result) => {
      const provider = (result.provider as AuthConfig['provider']) || 'claude';
      if (provider === 'claude' && !result.anthropicApiKey) {
        reject(new Error('No Anthropic API Key found. Please set one in the extension options.'));
      } else if (provider === 'gemini' && !result.geminiApiKey) {
        reject(new Error('No Gemini API Key found. Please set one in the extension options.'));
      } else if (provider === 'togetherai' && !result.togetherApiKey) {
        reject(new Error('No Together AI API Key found. Please set one in the extension options.'));
      } else if (provider === 'openrouter' && !result.openrouterApiKey) {
        reject(new Error('No OpenRouter API Key found. Please set one in the extension options.'));
      } else if (provider === 'groq' && !result.groqApiKey) {
        reject(new Error('No Groq API Key found. Please set one in the extension options.'));
      } else {
        resolve({
          provider,
          anthropicApiKey: result.anthropicApiKey as string,
          geminiApiKey: result.geminiApiKey as string,
          togetherApiKey: result.togetherApiKey as string,
          openrouterApiKey: result.openrouterApiKey as string,
          groqApiKey: result.groqApiKey as string,
          togetherModel: (result.togetherModel as string) || 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
          openrouterModel: (result.openrouterModel as string) || 'openrouter/auto',
          groqModel: (result.groqModel as string) || 'llama-3.3-70b-versatile',
        });
      }
    });
  });
}
