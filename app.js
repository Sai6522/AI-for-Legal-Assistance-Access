/**
 * LexAI – Legal Document Assistant
 * app.js
 *
 * Architecture:
 *  - Parses uploaded PDF using PDF.js (CDN)
 *  - Chunks document text by page
 *  - Calls Google Gemini 2.5 Flash API directly from the browser
 *  - Enforces strict document-grounding via system prompt
 *  - Extracts citations (page, clause, excerpt) from AI responses
 *  - Zero hallucination policy: model must refuse if info not in document
 */

'use strict';

// ─── PDF.js worker ───────────────────────────────────────────────────────────
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const MAX_CONTEXT_CHARS  = 3_000_000; // ~3M chars — safe for Gemini 2.5 Flash's 1M token window
const MAX_FILE_SIZE_MB   = 20;

// ─── APPLICATION STATE ────────────────────────────────────────────────────────
const state = {
  apiKey: '',
  document: {
    name: '',
    totalPages: 0,
    pages: [],      // Array<{ pageNum: number, text: string }>
    fullText: '',
    wordCount: 0,
    charCount: 0,
  },
  isReady: false,   // both apiKey + document loaded
  isLoading: false,
  conversationHistory: [], // [{role, parts}] for Gemini multi-turn
};

// ─── DOM REFERENCES ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dom = {
  // API key
  apiKeyInput:    $('api-key-input'),
  toggleApiKey:   $('toggle-api-key'),
  eyeOpen:        $('eye-open'),
  eyeClosed:      $('eye-closed'),
  apiKeyStatus:   $('api-key-status'),

  // Theme
  themeToggle:    $('theme-toggle'),
  themeIconLight: $('theme-icon-light'),
  themeIconDark:  $('theme-icon-dark'),

  // Upload
  dropZone:       $('drop-zone'),
  fileInput:      $('file-input'),
  docInfo:        $('doc-info'),
  docName:        $('doc-name'),
  docMeta:        $('doc-meta'),
  removeDoc:      $('remove-doc'),
  parseProgress:  $('parse-progress'),
  parseBar:       $('parse-bar'),
  parseStatus:    $('parse-status'),

  // Stats
  docStats:   $('doc-stats'),
  statPages:  $('stat-pages'),
  statWords:  $('stat-words'),
  statChunks: $('stat-chunks'),
  statChars:  $('stat-chars'),

  // Suggested
  suggestedSection: $('suggested-section'),
  suggestedList:    $('suggested-list'),

  // Chat
  welcomeState:  $('welcome-state'),
  chatMessages:  $('chat-messages'),
  chatForm:      $('chat-form'),
  questionInput: $('question-input'),
  sendBtn:       $('send-btn'),
  charCount:     $('char-count'),
  inputNotice:   $('input-notice'),

  // Toast
  toastContainer: $('toast-container'),

  // Modal
  citationModal:  $('citation-modal'),
  modalClose:     $('modal-close'),
  modalPage:      $('modal-page'),
  modalSection:   $('modal-section'),
  modalExcerpt:   $('modal-excerpt'),
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────

/**
 * Returns a debounced version of `fn` that delays invocation by `delay` ms.
 * Prevents rapid-fire calls (e.g. textarea input events on every keystroke).
 * @param {Function} fn - Function to debounce.
 * @param {number} delay - Milliseconds to wait after last call.
 * @returns {Function}
 */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Sanitizes a string for safe insertion as DOM text content.
 * Strips path separators and trims to a max length to prevent
 * oversized filenames from breaking layout or leaking path info.
 * @param {string} name - Raw filename from File API.
 * @returns {string} Safe display name.
 */
function sanitizeFileName(name) {
  return String(name)
    .replace(/[/\\]/g, '')   // strip path separators
    .replace(/\.{2,}/g, '')  // strip path traversal (..)
    .replace(/[^\w.\- ]/g, '') // keep only safe chars
    .trim()
    .slice(0, 128);
}

// ─── THEME ────────────────────────────────────────────────────────────────────
/**
 * Initialises the colour theme from localStorage or OS preference.
 */
function initTheme() {
  const saved = localStorage.getItem('lexai-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
}

/**
 * Applies a colour theme to the document root and persists the choice.
 * @param {'light'|'dark'} theme
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('lexai-theme', theme);
  if (theme === 'dark') {
    dom.themeIconLight.classList.add('hidden');
    dom.themeIconDark.classList.remove('hidden');
  } else {
    dom.themeIconLight.classList.remove('hidden');
    dom.themeIconDark.classList.add('hidden');
  }
}

dom.themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ─── API KEY HANDLING ─────────────────────────────────────────────────────────
dom.apiKeyInput.addEventListener('input', () => {
  const key = dom.apiKeyInput.value.trim();
  state.apiKey = key;

  if (key.length > 10) {
    showStatus(dom.apiKeyStatus, 'API key set — not validated until first query', 'info');
  } else if (key.length === 0) {
    dom.apiKeyStatus.classList.add('hidden');
  } else {
    showStatus(dom.apiKeyStatus, 'Key looks too short', 'error');
  }

  updateReadyState();
});

dom.toggleApiKey.addEventListener('click', () => {
  const isPassword = dom.apiKeyInput.type === 'password';
  dom.apiKeyInput.type = isPassword ? 'text' : 'password';
  dom.eyeOpen.classList.toggle('hidden', isPassword);
  dom.eyeClosed.classList.toggle('hidden', !isPassword);
  dom.toggleApiKey.setAttribute('aria-label', isPassword ? 'Hide API key' : 'Show API key');
});

// ─── FILE UPLOAD & DRAG-DROP ──────────────────────────────────────────────────
dom.dropZone.addEventListener('click', () => dom.fileInput.click());

dom.dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    dom.fileInput.click();
  }
});

dom.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dom.dropZone.classList.add('drag-over');
  dom.dropZone.setAttribute('aria-label', 'Release to upload');
});

dom.dropZone.addEventListener('dragleave', () => {
  dom.dropZone.classList.remove('drag-over');
  dom.dropZone.setAttribute('aria-label', 'Upload legal document. Click or drag and drop a PDF file here.');
});

dom.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dom.dropZone.classList.remove('drag-over');
  dom.dropZone.setAttribute('aria-label', 'Upload legal document. Click or drag and drop a PDF file here.');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

dom.fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleFile(file);
  // Reset so same file can be re-selected
  dom.fileInput.value = '';
});

dom.removeDoc.addEventListener('click', removeDocument);

/**
 * Validates a user-selected file and initiates PDF parsing.
 * Rejects non-PDF files and files exceeding MAX_FILE_SIZE_MB.
 * @param {File} file - File object from drag-drop or file input.
 * @returns {Promise<void>}
 */
async function handleFile(file) {
  if (file.type !== 'application/pdf') {
    showToast('Only PDF files are supported.', 'error');
    return;
  }
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_FILE_SIZE_MB) {
    showToast(`File is too large (${sizeMB.toFixed(1)} MB). Maximum is ${MAX_FILE_SIZE_MB} MB.`, 'error');
    return;
  }

  // Show file info UI
  dom.dropZone.classList.add('hidden');
  dom.docInfo.classList.remove('hidden');
  dom.docName.textContent = sanitizeFileName(file.name); // sanitized before DOM insertion
  dom.docMeta.textContent = `${(sizeMB).toFixed(2)} MB`;

  // Reset state
  resetDocumentState();
  state.document.name = file.name;

  await parsePDF(file);
}

/**
 * Extracts and reconstructs plain text from a single PDF page's text content items.
 * Detects line breaks via y-coordinate changes between items.
 * @param {{ items: Array<{str: string, transform: number[]}> }} content - PDF.js text content.
 * @returns {string} Reconstructed plain text for the page.
 */
function extractPageText(content) {
  let pageText = '';
  let lastY = null;
  for (const item of content.items) {
    if ('str' in item) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
        pageText += '\n';
      }
      pageText += item.str;
      lastY = item.transform[5];
    }
  }
  return pageText.trim();
}

/**
 * Parses a PDF file using PDF.js, extracting text from all pages in parallel
 * via Promise.all for significantly faster processing on multi-page documents.
 * @param {File} file - The PDF file to parse.
 * @returns {Promise<void>}
 */
async function parsePDF(file) {
  showProgress(0, 'Starting…');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    state.document.totalPages = pdf.numPages;
    state.document.pages = [];
    showProgress(10, `Loading ${pdf.numPages} pages in parallel…`);

    // Fetch all pages in parallel — significantly faster than sequential await-in-loop
    const pageNums = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    const pageTexts = await Promise.all(
      pageNums.map(async (i) => {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        return extractPageText(content);
      })
    );

    showProgress(80, 'Processing text…');

    let fullText = '';
    let wordCount = 0;

    pageTexts.forEach((pageText, idx) => {
      const pageNum = idx + 1;
      state.document.pages.push({ pageNum, text: pageText });
      fullText += `\n\n--- PAGE ${pageNum} ---\n${pageText}`;
      wordCount += pageText.split(/\s+/).filter(Boolean).length;
    });

    // Trim to context limit
    if (fullText.length > MAX_CONTEXT_CHARS) {
      fullText = fullText.slice(0, MAX_CONTEXT_CHARS);
      showToast('Document is very large — only the first portion was loaded into context.', 'warning');
    }

    state.document.fullText = fullText;
    state.document.wordCount = wordCount;
    state.document.charCount = fullText.length;

    hideProgress();
    updateDocMeta();
    updateStats();

    dom.docStats.classList.remove('hidden');
    dom.suggestedSection.classList.remove('hidden');

    // Reset conversation for new document
    state.conversationHistory = [];

    updateReadyState();
    showToast(`Document loaded: ${state.document.totalPages} pages, ~${wordCount.toLocaleString()} words.`, 'success');

  } catch (err) {
    console.error('PDF parse error:', err);
    hideProgress();
    showToast('Failed to parse PDF. Please ensure it is a valid, non-protected PDF file.', 'error');
    removeDocument();
  }
}

/**
 * Resets all document-related state to its initial empty values.
 * Also clears conversation history and invalidates the document context cache.
 */
function resetDocumentState() {
  state.document = {
    name: '',
    totalPages: 0,
    pages: [],
    fullText: '',
    wordCount: 0,
    charCount: 0,
  };
  state.conversationHistory = [];
  cachedDocumentContext = null; // invalidate cache for new document
}

/**
 * Removes the currently loaded document, resets all state, and
 * restores the upload drop zone UI.
 */
function removeDocument() {
  resetDocumentState();
  dom.dropZone.classList.remove('hidden');
  dom.docInfo.classList.add('hidden');
  dom.docStats.classList.add('hidden');
  dom.suggestedSection.classList.add('hidden');
  hideProgress();
  updateReadyState();
}

/**
 * Updates the document metadata line shown below the filename
 * with page count and approximate word count.
 */
function updateDocMeta() {
  const { totalPages, wordCount } = state.document;
  dom.docMeta.textContent = `${totalPages} pages · ~${wordCount.toLocaleString()} words`;
}

/**
 * Populates the Document Stats panel with page, word, chunk and character counts.
 */
function updateStats() {
  const { totalPages, wordCount, charCount, pages } = state.document;
  dom.statPages.textContent  = totalPages.toLocaleString();
  dom.statWords.textContent  = wordCount.toLocaleString();
  dom.statChunks.textContent = pages.length.toLocaleString();
  dom.statChars.textContent  = charCount.toLocaleString();
}

/**
 * Shows the progress bar and updates its value and label text.
 * @param {number} pct - Completion percentage (0–100).
 * @param {string} label - Status text to display below the bar.
 */
function showProgress(pct, label) {
  dom.parseProgress.classList.remove('hidden');
  dom.parseBar.style.width = `${pct}%`;
  dom.parseProgress.setAttribute('aria-valuenow', pct);
  dom.parseStatus.textContent = label;
}

/**
 * Hides the progress bar and clears the status label.
 */
function hideProgress() {
  dom.parseProgress.classList.add('hidden');
  dom.parseStatus.textContent = '';
}

// ─── READY STATE ─────────────────────────────────────────────────────────────

/**
 * Syncs the chat input enabled/disabled state and notice text
 * based on whether both an API key and a loaded document are present.
 */
function updateReadyState() {
  const hasDoc = state.document.fullText.length > 0;
  const hasKey = state.apiKey.length > 10;
  state.isReady = hasDoc && hasKey;

  dom.questionInput.disabled = !state.isReady;
  dom.sendBtn.disabled = !state.isReady;

  if (!hasDoc && !hasKey) {
    dom.inputNotice.textContent = 'Upload a document and enter your API key to start asking questions.';
    dom.inputNotice.classList.remove('hidden');
  } else if (!hasDoc) {
    dom.inputNotice.textContent = 'Upload a legal document (PDF) to start.';
    dom.inputNotice.classList.remove('hidden');
  } else if (!hasKey) {
    dom.inputNotice.textContent = 'Enter your Gemini API key above to enable questions.';
    dom.inputNotice.classList.remove('hidden');
  } else {
    dom.inputNotice.classList.add('hidden');
  }
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────

/**
 * Handles textarea resize and character counter updates.
 * Debounced to avoid excessive DOM writes on every keystroke.
 */
const handleInputResize = debounce(() => {
  dom.questionInput.style.height = 'auto';
  dom.questionInput.style.height = Math.min(dom.questionInput.scrollHeight, 160) + 'px';

  const len = dom.questionInput.value.length;
  dom.charCount.textContent = `${len} / 2000`;
  dom.charCount.className = 'char-count' + (len > 1800 ? ' danger' : len > 1500 ? ' warning' : '');
}, 100);

// Auto-resize textarea
dom.questionInput.addEventListener('input', handleInputResize);

dom.questionInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!dom.sendBtn.disabled) dom.chatForm.requestSubmit();
  }
});

dom.chatForm.addEventListener('submit', async e => {
  e.preventDefault();
  const question = dom.questionInput.value.trim();
  if (!question || state.isLoading) return;
  await handleQuestion(question);
});

// Suggested question buttons
dom.suggestedList.addEventListener('click', e => {
  const btn = e.target.closest('.suggested-btn');
  if (!btn || !state.isReady) return;
  const q = btn.dataset.question;
  if (q) handleQuestion(q);
});

/** Minimum milliseconds between successive API submissions to prevent duplicate requests. */
const MIN_REQUEST_INTERVAL_MS = 1000;
let lastRequestTime = 0;

/**
 * Main question handler: validates state, shows user message,
 * enforces rate-limit, calls Gemini, and renders the response.
 * @param {string} question - The user's natural-language question.
 */
async function handleQuestion(question) {
  if (state.isLoading) return;

  // Rate-limit guard: reject if last request was < 1 s ago
  const now = Date.now();
  if (now - lastRequestTime < MIN_REQUEST_INTERVAL_MS) {
    showToast('Please wait a moment before sending another question.', 'warning');
    return;
  }
  lastRequestTime = now;

  // Switch from welcome to chat view
  dom.welcomeState.classList.add('hidden');
  dom.chatMessages.classList.remove('hidden');

  // Render user message
  appendMessage('user', question);

  // Clear input
  dom.questionInput.value = '';
  dom.questionInput.style.height = 'auto';
  dom.charCount.textContent = '0 / 2000';
  dom.sendBtn.disabled = true;
  state.isLoading = true;

  // Typing indicator
  const typingId = showTypingIndicator();

  try {
    const response = await callGemini(question);
    removeTypingIndicator(typingId);
    renderAssistantResponse(response);
  } catch (err) {
    removeTypingIndicator(typingId);
    const msg = err.message || 'An unexpected error occurred.';
    renderErrorMessage(msg);
    console.error('Gemini API error:', err);
  } finally {
    state.isLoading = false;
    dom.sendBtn.disabled = !state.isReady;
    scrollChatToBottom();
  }
}

// ─── GEMINI API ───────────────────────────────────────────────────────────────

/**
 * Builds a grounding-focused system instruction for Gemini.
 * This is the core of hallucination prevention.
 * @returns {string} System instruction text.
 */
function buildSystemInstruction() {
  return `You are LexAI, a precise legal document analysis assistant.

CRITICAL RULES — you must follow these without exception:

1. DOCUMENT-ONLY ANSWERS: You must ONLY answer using information explicitly present in the provided document. Never add external legal knowledge, general legal principles, or assumptions not stated in the document.

2. EXPLICIT NOT FOUND: If the answer to a question cannot be found in the document, respond with:
   "⚠️ NOT FOUND IN DOCUMENT: The document does not contain information about [topic]. I cannot answer this from the provided text."
   Never guess or hallucinate an answer.

3. CITATIONS ARE MANDATORY: Every factual claim must include a citation in this exact format:
   [Page X] or [Page X, Clause Y] or [Page X, Section "Title"]
   Place citations immediately after the claim they support.

4. PLAIN LANGUAGE: Explain legal terms in plain language immediately after using them. Do not assume legal expertise.

5. NO LEGAL ADVICE: End significant answers with: "⚠️ Note: This is an informational summary only. Consult a qualified lawyer for legal advice."

6. STRUCTURED RESPONSES: Use clear paragraphs. For lists of obligations/rights, use bullet points.

7. CONFIDENCE: Only state facts you can directly quote or closely paraphrase from the document. Use phrases like "The document states…", "According to [Page X]…", "Clause Y specifies…"

The document text follows. Answer all questions strictly from this content.`;
}

/**
 * Cached document context prefix — built once when a document is loaded,
 * reused on every first-turn API call to avoid rebuilding on each question.
 * Reset to null whenever a new document is loaded.
 * @type {string|null}
 */
let cachedDocumentContext = null;

/**
 * Builds and caches the document context string for the first conversation turn.
 * Subsequent calls return the cached value without re-building.
 * @returns {string} Formatted document context string.
 */
function getDocumentContext() {
  if (cachedDocumentContext === null) {
    cachedDocumentContext =
      `DOCUMENT TO ANALYZE:\n${state.document.fullText}\n\n---END OF DOCUMENT---\n\n`;
  }
  return cachedDocumentContext;
}

/**
 * Calls the Gemini 2.5 Flash API with the full document context.
 * The API key is sent via the x-goog-api-key request header (not URL query param)
 * to prevent credential exposure in browser history and server access logs.
 * Uses conversation history for multi-turn support.
 * @param {string} question - The user's question to send to the model.
 * @returns {Promise<string>} The model's text response.
 */
async function callGemini(question) {
  // For the first turn, prepend the full document context to the question.
  // For subsequent turns, document context is already established in history.
  const isFirstTurn = state.conversationHistory.length === 0;

  let userContent = question;
  if (isFirstTurn) {
    userContent = `${getDocumentContext()}USER QUESTION: ${question}`;
  } else {
    userContent = `USER QUESTION (about the same document): ${question}`;
  }

  // Add current question to history
  const currentTurn = { role: 'user', parts: [{ text: userContent }] };
  const historyToSend = [...state.conversationHistory, currentTurn];

  const body = {
    system_instruction: {
      parts: [{ text: buildSystemInstruction() }],
    },
    contents: historyToSend,
    generationConfig: {
      temperature: 0.1,      // Low temperature → more deterministic, less hallucination
      topP: 0.8,
      topK: 40,
      maxOutputTokens: 8192,
      stopSequences: [],
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  // API key is sent via request header (x-goog-api-key), NOT as a URL query param.
  // Using a header prevents the key from appearing in browser history, server access
  // logs, and Referer headers — a critical security improvement.
  const res = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': state.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let errMsg = `API error ${res.status}`;
    try {
      const errData = await res.json();
      errMsg = errData.error?.message || errMsg;
    } catch (_) { /* ignore */ }

    if (res.status === 400) throw new Error(`Bad request: ${errMsg}. Check your API key.`);
    if (res.status === 401 || res.status === 403)
      throw new Error('Invalid API key. Please check your Gemini API key in the sidebar.');
    if (res.status === 429) throw new Error('Rate limit reached. Please wait a moment and try again.');
    if (res.status >= 500) throw new Error('Gemini API is temporarily unavailable. Please try again later.');
    throw new Error(errMsg);
  }

  const data = await res.json();

  // Handle blocked responses
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error('No response received from Gemini. The request may have been blocked.');
  }

  if (candidate.finishReason === 'SAFETY') {
    throw new Error('Response was blocked due to safety filters. Please rephrase your question.');
  }

  const responseText = candidate.content?.parts?.[0]?.text || '';
  if (!responseText) {
    throw new Error('Empty response received from Gemini.');
  }

  // Update conversation history (keep last 6 turns to avoid context overflow)
  state.conversationHistory.push(currentTurn);
  state.conversationHistory.push({ role: 'model', parts: [{ text: responseText }] });
  if (state.conversationHistory.length > 12) {
    // Remove oldest two (one user + one model turn), keep document context turn
    state.conversationHistory.splice(2, 2);
  }

  return responseText;
}

// ─── RENDERING ────────────────────────────────────────────────────────────────

/** SVG icons keyed by avatar type, defined once to avoid inline duplication. */
const AVATAR_ICONS = {
  assistant: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`,
  error:     `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
};

/**
 * Creates a standardised message avatar element.
 * Extracted to eliminate duplicated avatar DOM code across
 * renderAssistantResponse, renderErrorMessage, showTypingIndicator,
 * and createMessageElement.
 * @param {'user'|'assistant'|'error'} type - Avatar style.
 * @returns {HTMLElement} A div.message-avatar element.
 */
function createMessageAvatar(type) {
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  if (type === 'user') {
    avatar.textContent = 'You';
  } else {
    avatar.innerHTML = AVATAR_ICONS[type] || AVATAR_ICONS.assistant;
  }
  return avatar;
}

/**
 * Appends a user or assistant message bubble to the chat log.
 * Does not scroll — callers are responsible for scrolling after all
 * DOM mutations are complete to avoid redundant reflows.
 * @param {'user'|'assistant'} role - Speaker role.
 * @param {string} text - Message text content.
 * @returns {HTMLElement} The created message element.
 */
function appendMessage(role, text) {
  const el = createMessageElement(role, text);
  dom.chatMessages.appendChild(el);
  return el;
}

/**
 * Parses an AI response, extracts citations, and renders the full
 * assistant message bubble with citation badges into the chat log.
 * @param {string} text - Raw AI response text from Gemini.
 */
function renderAssistantResponse(text) {
  const citations = extractCitations(text);
  const isNotFound = /NOT FOUND IN DOCUMENT/i.test(text);

  const wrapper = document.createElement('div');
  wrapper.classList.add('message', 'assistant');
  if (isNotFound) wrapper.classList.add('not-found');

  const avatar = createMessageAvatar('assistant');

  const content = document.createElement('div');
  content.className = 'message-content';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.setAttribute('role', 'article');
  bubble.setAttribute('aria-label', 'Assistant response');
  bubble.innerHTML = formatResponseHTML(text);

  const timeEl = document.createElement('time');
  timeEl.className = 'message-time';
  timeEl.textContent = formatTime(new Date());

  content.appendChild(bubble);

  // Render citation badges
  if (citations.length > 0) {
    const citDiv = document.createElement('div');
    citDiv.className = 'citations';
    citDiv.setAttribute('aria-label', `${citations.length} source citation${citations.length > 1 ? 's' : ''}`);

    const label = document.createElement('p');
    label.className = 'citations-label';
    label.textContent = `${citations.length} Source Citation${citations.length > 1 ? 's' : ''}`;
    citDiv.appendChild(label);

    citations.forEach(cit => {
      const btn = document.createElement('button');
      btn.className = 'citation-badge';
      btn.setAttribute('aria-label', `View citation: ${cit.label}`);
      btn.innerHTML = `
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        ${escapeHTML(cit.label)}
      `;
      btn.addEventListener('click', () => openCitationModal(cit));
      citDiv.appendChild(btn);
    });

    content.appendChild(citDiv);
  }

  content.appendChild(timeEl);
  wrapper.appendChild(avatar);
  wrapper.appendChild(content);
  dom.chatMessages.appendChild(wrapper);
  scrollChatToBottom();
}

/**
 * Renders an error message bubble in the chat log.
 * @param {string} msg - Human-readable error description.
 */
function renderErrorMessage(msg) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant not-found';

  const avatar = createMessageAvatar('error');

  const content = document.createElement('div');
  content.className = 'message-content';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.setAttribute('role', 'alert');
  bubble.innerHTML = `<strong>⚠️ Error:</strong> ${escapeHTML(msg)}`;

  content.appendChild(bubble);
  wrapper.appendChild(avatar);
  wrapper.appendChild(content);
  dom.chatMessages.appendChild(wrapper);
}

/**
 * Creates a generic message wrapper element for user or assistant roles.
 * Used by {@link appendMessage} for user messages and simple assistant text.
 * @param {'user'|'assistant'} role - Speaker role.
 * @param {string} text - Message text content.
 * @returns {HTMLElement} Fully constructed message element ready to append.
 */
function createMessageElement(role, text) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const avatar = createMessageAvatar(role);

  const content = document.createElement('div');
  content.className = 'message-content';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (role === 'user') {
    bubble.textContent = text;
  } else {
    bubble.innerHTML = formatResponseHTML(text);
  }

  const timeEl = document.createElement('time');
  timeEl.className = 'message-time';
  timeEl.textContent = formatTime(new Date());

  content.appendChild(bubble);
  content.appendChild(timeEl);
  wrapper.appendChild(avatar);
  wrapper.appendChild(content);
  return wrapper;
}

/**
 * Inserts an animated typing indicator bubble and returns its DOM id.
 * @returns {string} Unique element id for later removal.
 */
function showTypingIndicator() {
  const id = 'typing-' + Date.now();
  const wrapper = document.createElement('div');
  wrapper.id = id;
  wrapper.className = 'message assistant typing-indicator';
  wrapper.setAttribute('role', 'status');
  wrapper.setAttribute('aria-label', 'LexAI is thinking…');

  const avatar = createMessageAvatar('assistant');

  const content = document.createElement('div');
  content.className = 'message-content';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';

  content.appendChild(bubble);
  wrapper.appendChild(avatar);
  wrapper.appendChild(content);
  dom.chatMessages.appendChild(wrapper);
  scrollChatToBottom();
  return id;
}

/**
 * Removes the typing indicator element from the chat log.
 * @param {string} id - Element id returned by {@link showTypingIndicator}.
 */
function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

/**
 * Smoothly scrolls the chat message container to the latest message.
 */
function scrollChatToBottom() {
  requestAnimationFrame(() => {
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  });
}

// ─── CITATION EXTRACTION ──────────────────────────────────────────────────────

/**
 * Extracts all citation references from an AI response string.
 * Supports formats: [Page N], [Page N, Clause X], [Page N, Section "Title"],
 * [Page N, Article X], [Page N, Paragraph X], [Page N, Annex X].
 * Deduplicates identical references and attaches source excerpts.
 * @param {string} text - Raw AI response text.
 * @returns {Array<{label: string, pageNum: number, sectionType: string|null, sectionId: string|null, excerpt: string}>}
 */
function extractCitations(text) {
  const found = [];
  const seen = new Set();

  // Matches: [Page N], [Page N, Clause X], [Page N, Section "Y"], [Page N, Article Z], etc.
  const pattern = /\[Page\s+(\d+)(?:,\s*(Clause|Section|Article|Paragraph|Annex)\s+([^\]]+))?\]/gi;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const pageNum = parseInt(match[1], 10);
    const sectionType = match[2] || null;
    const sectionId = match[3] ? match[3].replace(/['"]/g, '').trim() : null;

    const label = sectionType
      ? `Page ${pageNum}, ${sectionType} ${sectionId}`
      : `Page ${pageNum}`;

    if (!seen.has(label)) {
      seen.add(label);

      // Pull excerpt from parsed page data
      const pageData = state.document.pages.find(p => p.pageNum === pageNum);
      const excerpt = pageData ? getExcerpt(pageData.text, sectionId) : '';

      found.push({ label, pageNum, sectionType, sectionId, excerpt });
    }
  }

  return found;
}

/**
 * Extracts a relevant excerpt from a page's text, centred on the sectionId match.
 * Falls back to the first 400 characters when no match is found.
 * @param {string} pageText - Full text of the page.
 * @param {string|null} sectionId - Clause/section identifier to search for.
 * @returns {string} Excerpt string, truncated with ellipsis if needed.
 */
function getExcerpt(pageText, sectionId) {
  if (!pageText) return '';
  if (!sectionId) return pageText.slice(0, 400) + (pageText.length > 400 ? '…' : '');

  const idx = pageText.toLowerCase().indexOf(sectionId.toLowerCase());
  if (idx === -1) return pageText.slice(0, 400) + (pageText.length > 400 ? '…' : '');

  const start = Math.max(0, idx - 100);
  const end   = Math.min(pageText.length, idx + 400);
  return (start > 0 ? '…' : '') + pageText.slice(start, end) + (end < pageText.length ? '…' : '');
}

// ─── CITATION MODAL ───────────────────────────────────────────────────────────
/**
 * Opens the citation detail modal showing the raw source excerpt for a citation.
 * @param {{ pageNum: number, sectionType: string|null, sectionId: string|null, excerpt: string }} cit
 */
function openCitationModal(cit) {
  dom.modalPage.textContent    = `Page ${cit.pageNum}`;
  dom.modalSection.textContent = cit.sectionId ? `${cit.sectionType} ${cit.sectionId}` : '–';
  dom.modalExcerpt.textContent = cit.excerpt || 'No excerpt available for this page.';
  dom.citationModal.classList.remove('hidden');
  dom.modalClose.focus();

  // Trap focus inside modal
  trapFocus(dom.citationModal);
}

dom.modalClose.addEventListener('click', () => {
  dom.citationModal.classList.add('hidden');
});

dom.citationModal.addEventListener('click', e => {
  if (e.target === dom.citationModal) dom.citationModal.classList.add('hidden');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !dom.citationModal.classList.contains('hidden')) {
    dom.citationModal.classList.add('hidden');
  }
});

/**
 * Traps keyboard focus within a modal element while it is open.
 * Automatically removes the handler when the element gains the 'hidden' class.
 * @param {HTMLElement} element - The modal container element.
 */
function trapFocus(element) {
  const focusable = element.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  const handler = e => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  };

  element.addEventListener('keydown', handler);
  // Remove on close
  const observer = new MutationObserver(() => {
    if (element.classList.contains('hidden')) {
      element.removeEventListener('keydown', handler);
      observer.disconnect();
    }
  });
  observer.observe(element, { attributes: true });
}

// ─── STATUS BADGES ────────────────────────────────────────────────────────────

/**
 * Shows a status badge element with a given message and visual type.
 * @param {HTMLElement} el - The badge element to update.
 * @param {string} msg - Message text to display.
 * @param {'success'|'error'|'info'|'warning'} type - Visual style.
 */
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status-badge ${type}`;
  el.classList.remove('hidden');
}

// ─── TOAST NOTIFICATIONS ─────────────────────────────────────────────────────

/**
 * Displays a transient toast notification at the bottom-right of the screen.
 * @param {string} message - Text to display in the toast.
 * @param {'info'|'success'|'error'|'warning'} [type='info'] - Visual style.
 * @param {number} [durationMs=5000] - Auto-dismiss delay in milliseconds.
 */
function showToast(message, type = 'info', durationMs = 5000) {
  const icons = {
    success: `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning: `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info:    `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <span class="toast-icon ${type}">${icons[type] || icons.info}</span>
    <span class="toast-message">${escapeHTML(message)}</span>
  `;

  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'opacity 300ms, transform 300ms';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// ─── TEXT FORMATTING ──────────────────────────────────────────────────────────

/**
 * Converts plain AI response text to safe HTML with markdown-like formatting.
 *
 * Runs a single sequential pipeline on the escaped string:
 *   escape → bold → italic → citations → warnings → lists → paragraphs → line breaks
 *
 * Uses a whitelist/escape-first approach: raw text is HTML-entity-encoded before
 * any markup is injected, preventing XSS from AI-generated content.
 *
 * @param {string} text - Raw plain-text response from the AI model.
 * @returns {string} Safe HTML string wrapped in a <p> element.
 */
function formatResponseHTML(text) {
  // Step 1 — escape all HTML entities first (XSS prevention)
  let out = escapeHTML(text);

  // Step 2 — inline formatting
  out = out
    // Bold **text**
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    // Italic *text* (only single asterisks not adjacent to bold markers)
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    // Citation spans [Page N ...] → styled pill
    .replace(
      /\[Page\s+(\d+)(?:,\s*[^\]]+)?\]/g,
      m => `<span class="inline-citation" aria-label="Citation: ${escapeAttr(m)}">${m}</span>`
    )
    // Warning lines starting with ⚠️
    .replace(/(⚠️[^\n]+)/g, '<span class="response-warning">$1</span>');

  // Step 3 — block structure (lists then paragraphs)
  out = out
    // Unordered list items (- or •)
    .replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
    // Numbered list items
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> runs in a single <ul>
    .replace(/(<li>.*<\/li>(\n|<br>)*)+/gs, match => `<ul>${match}</ul>`)
    // Collapse accidental nested ul tags
    .replace(/<\/ul>\s*<ul>/g, '')
    // Double newlines → paragraph break
    .replace(/\n{2,}/g, '</p><p>')
    // Single newline → line break
    .replace(/\n/g, '<br>');

  return `<p>${out}</p>`;
}

/**
 * Escapes a string for safe insertion as HTML text content.
 * Prevents XSS by replacing all HTML special characters with entities.
 * @param {string} str - Raw input string.
 * @returns {string} HTML-entity-encoded string.
 */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes a string for safe insertion inside an HTML attribute value.
 * @param {string} str - Raw input string.
 * @returns {string} Attribute-safe encoded string.
 */
function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Formats a Date object as a locale-aware HH:MM time string.
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── INITIALISATION ───────────────────────────────────────────────────────────
function init() {
  initTheme();
  updateReadyState();

  // Restore API key from session storage only (no default — user must paste their own key)
  const savedKey = sessionStorage.getItem('lexai-api-key');
  if (savedKey) {
    dom.apiKeyInput.value = savedKey;
    state.apiKey = savedKey;
    showStatus(dom.apiKeyStatus, 'API key ready (gemini-2.5-flash)', 'success');
    updateReadyState();
  }

  // Save API key to session (clears on tab close)
  dom.apiKeyInput.addEventListener('change', () => {
    if (state.apiKey.length > 10) {
      sessionStorage.setItem('lexai-api-key', state.apiKey);
    } else {
      sessionStorage.removeItem('lexai-api-key');
    }
  });

  console.info('LexAI initialised.');
}

document.addEventListener('DOMContentLoaded', init);
