// Site Intelligence — pre-learned DOM knowledge for popular sites.
//
// When ECHO recognises the site it's on (or the site a request names) it can
// act directly through a known selector instead of paying for read_screen +
// a model round-trip. "Search YouTube for lo-fi" becomes a plain DOM write.

export interface SiteProfile {
  id: string;
  /** Hostname fragments that identify this site. */
  match: string[];
  /** Human name used in replies. */
  name: string;
  /** Where to go when the user names the site without a URL. */
  home: string;
  /** Selector for the site's main search box, in priority order. */
  search?: string[];
  /** Build a direct search URL — always more reliable than typing. */
  searchUrl?: (q: string) => string;
  /** Extra named selectors ECHO can click by intent word. */
  actions?: Record<string, string[]>;
}

export const SITE_PROFILES: SiteProfile[] = [
  {
    id: 'google', name: 'Google', match: ['google.com', 'google.co'],
    home: 'https://www.google.com',
    search: ['textarea[name="q"]', 'input[name="q"]'],
    searchUrl: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'youtube', name: 'YouTube', match: ['youtube.com', 'youtu.be'],
    home: 'https://www.youtube.com',
    search: ['input#search', 'input[name="search_query"]'],
    searchUrl: q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    actions: {
      subscribe: ['#subscribe-button button', 'ytd-subscribe-button-renderer button'],
      like: ['#top-level-buttons-computed button[aria-label*="like" i]'],
      fullscreen: ['.ytp-fullscreen-button'],
      play: ['.ytp-play-button'],
    },
  },
  {
    id: 'gmail', name: 'Gmail', match: ['mail.google.com'],
    home: 'https://mail.google.com',
    search: ['input[aria-label="Search mail"]', 'input[name="q"]'],
    actions: {
      compose: ['div[gh="cm"]', 'div[role="button"][gh="cm"]'],
      reply: ['div[aria-label^="Reply" i]'],
      archive: ['div[aria-label^="Archive" i]'],
      send: ['div[role="button"][aria-label^="Send" i]'],
    },
  },
  {
    id: 'github', name: 'GitHub', match: ['github.com'],
    home: 'https://github.com',
    search: ['input[name="q"]', 'button[aria-label*="search" i]'],
    searchUrl: q => `https://github.com/search?q=${encodeURIComponent(q)}`,
    actions: {
      star: ['button[aria-label*="Star" i]', 'form.js-social-form button'],
      issues: ['a#issues-tab', 'a[data-tab-item="i1issues-tab"]'],
      pulls: ['a#pull-requests-tab'],
      code: ['a#code-tab'],
    },
  },
  {
    id: 'amazon', name: 'Amazon', match: ['amazon.com', 'amazon.in', 'amazon.co'],
    home: 'https://www.amazon.com',
    search: ['input#twotabsearchtextbox', 'input[name="field-keywords"]'],
    searchUrl: q => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
    actions: {
      cart: ['a#nav-cart', '#nav-cart-count-container'],
      'add to cart': ['input#add-to-cart-button', '#add-to-cart-button'],
      buy: ['input#buy-now-button'],
    },
  },
  {
    id: 'twitter', name: 'X (Twitter)', match: ['twitter.com', 'x.com'],
    home: 'https://x.com',
    search: ['input[data-testid="SearchBox_Search_Input"]'],
    searchUrl: q => `https://x.com/search?q=${encodeURIComponent(q)}`,
    actions: {
      post: ['a[data-testid="SideNav_NewTweet_Button"]', 'div[data-testid="tweetButtonInline"]'],
      like: ['div[data-testid="like"]'],
      repost: ['div[data-testid="retweet"]'],
    },
  },
  {
    id: 'reddit', name: 'Reddit', match: ['reddit.com'],
    home: 'https://www.reddit.com',
    search: ['input[name="q"]', 'faceplate-search-input input'],
    searchUrl: q => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
    actions: {
      upvote: ['button[aria-label="upvote" i]'],
      comment: ['button[aria-label*="comment" i]'],
    },
  },
  {
    id: 'wikipedia', name: 'Wikipedia', match: ['wikipedia.org'],
    home: 'https://www.wikipedia.org',
    search: ['input#searchInput', 'input[name="search"]'],
    searchUrl: q => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
  },
  {
    id: 'linkedin', name: 'LinkedIn', match: ['linkedin.com'],
    home: 'https://www.linkedin.com',
    search: ['input.search-global-typeahead__input', 'input[placeholder="Search"]'],
    searchUrl: q => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(q)}`,
  },
  {
    id: 'stackoverflow', name: 'Stack Overflow', match: ['stackoverflow.com', 'stackexchange.com'],
    home: 'https://stackoverflow.com',
    search: ['input[name="q"]'],
    searchUrl: q => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'chatgpt', name: 'ChatGPT', match: ['chatgpt.com', 'chat.openai.com'],
    home: 'https://chatgpt.com',
    search: ['#prompt-textarea', 'textarea[data-id]'],
  },
  {
    id: 'netflix', name: 'Netflix', match: ['netflix.com'],
    home: 'https://www.netflix.com',
    search: ['input[data-uia="search-box-input"]'],
    searchUrl: q => `https://www.netflix.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'spotify', name: 'Spotify', match: ['spotify.com'],
    home: 'https://open.spotify.com',
    search: ['input[data-testid="search-input"]'],
    searchUrl: q => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
    actions: { play: ['button[data-testid="control-button-playpause"]'] },
  },
  {
    id: 'maps', name: 'Google Maps', match: ['google.com/maps', 'maps.google'],
    home: 'https://www.google.com/maps',
    search: ['input#searchboxinput'],
    searchUrl: q => `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
  },
  {
    id: 'drive', name: 'Google Drive', match: ['drive.google.com'],
    home: 'https://drive.google.com',
    search: ['input[aria-label="Search in Drive"]', 'input[placeholder*="Search" i]'],
  },
  {
    id: 'notion', name: 'Notion', match: ['notion.so', 'notion.com'],
    home: 'https://www.notion.so',
    search: ['div[role="button"][aria-label="Search"]'],
  },
  {
    id: 'stackblitz', name: 'StackBlitz', match: ['stackblitz.com'], home: 'https://stackblitz.com',
  },
  {
    id: 'hackernews', name: 'Hacker News', match: ['news.ycombinator.com'],
    home: 'https://news.ycombinator.com',
    searchUrl: q => `https://hn.algolia.com/?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'ebay', name: 'eBay', match: ['ebay.com', 'ebay.co'],
    home: 'https://www.ebay.com',
    search: ['input#gh-ac'],
    searchUrl: q => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  },
  {
    id: 'flipkart', name: 'Flipkart', match: ['flipkart.com'],
    home: 'https://www.flipkart.com',
    search: ['input[name="q"]', 'input[title="Search for products, brands and more"]'],
    searchUrl: q => `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`,
  },
];

/** Find the profile for a URL (or a bare site name the user typed). */
export function matchSite(urlOrName: string): SiteProfile | null {
  if (!urlOrName) return null;
  const s = urlOrName.toLowerCase();
  // Longest match wins so "google.com/maps" beats "google.com".
  let best: SiteProfile | null = null;
  let bestLen = 0;
  for (const p of SITE_PROFILES) {
    for (const m of p.match) {
      if (s.includes(m) && m.length > bestLen) { best = p; bestLen = m.length; }
    }
  }
  if (best) return best;
  // Bare name: "search youtube for x" / "open spotify"
  for (const p of SITE_PROFILES) {
    if (new RegExp(`\\b${p.id}\\b`).test(s)) return p;
  }
  return null;
}

/** A direct search URL for a site, when we know one. */
export function siteSearchUrl(profile: SiteProfile, query: string): string | null {
  return profile.searchUrl ? profile.searchUrl(query) : null;
}

/** Selectors for a named on-page action ("subscribe", "compose"…). */
export function siteActionSelectors(profile: SiteProfile, intent: string): string[] | null {
  if (!profile.actions) return null;
  const key = intent.toLowerCase();
  for (const [name, sels] of Object.entries(profile.actions)) {
    if (key.includes(name)) return sels;
  }
  return null;
}
