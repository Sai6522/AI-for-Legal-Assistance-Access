/**
 * LexAI – Legal Document Assistant
 * app.js
 *
 * Architecture:
 *  - Parses uploaded PDF using PDF.js (CDN)
 *  - Chunks document text by page
 *  - Calls Google Gemini 1.5 Flash API directly from the browser
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

const MAX_CONTEXT_CHARS  = 3_000_000; // ~3M chars — safe for Gemini 2.5 Flash Lite's 1M token window
const MAX_FILE_SIZE_MB   = 20;
const CHUNK_OVERLAP_CHARS = 200;     // Overlap between page chunks for context continuity

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

// ─── THEME ────────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('lexai-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
}

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
 * Validates and starts PDF parsing for an uploaded file.
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
  dom.docName.textContent = file.name;
  dom.docMeta.textContent = `${(sizeMB).toFixed(2)} MB`;

  // Reset state
  resetDocumentState();
  state.document.name = file.name;

  await parsePDF(file);
}

/**
 * Parses a PDF file using PDF.js, extracting text per page.
 */
async function parsePDF(file) {
  showProgress(0, 'Starting…');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    state.document.totalPages = pdf.numPages;
    state.document.pages = [];

    let fullText = '';
    let wordCount = 0;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      // Reconstruct page text preserving rough line structure
      let pageText = '';
      let lastY = null;
      for (const item of content.items) {
        if ('str' in item) {
          // New line detection based on y-coordinate change
          if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
            pageText += '\n';
          }
          pageText += item.str;
          lastY = item.transform[5];
        }
      }
      pageText = pageText.trim();

      state.document.pages.push({ pageNum: i, text: pageText });
      fullText += `\n\n--- PAGE ${i} ---\n${pageText}`;
      wordCount += pageText.split(/\s+/).filter(Boolean).length;

      const progress = Math.round((i / pdf.numPages) * 100);
      showProgress(progress, `Parsing page ${i} of ${pdf.numPages}…`);
    }

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
}

function removeDocument() {
  resetDocumentState();
  dom.dropZone.classList.remove('hidden');
  dom.docInfo.classList.add('hidden');
  dom.docStats.classList.add('hidden');
  dom.suggestedSection.classList.add('hidden');
  hideProgress();
  updateReadyState();
}

function updateDocMeta() {
  const { totalPages, wordCount } = state.document;
  dom.docMeta.textContent = `${totalPages} pages · ~${wordCount.toLocaleString()} words`;
}

function updateStats() {
  const { totalPages, wordCount, charCount, pages } = state.document;
  dom.statPages.textContent  = totalPages.toLocaleString();
  dom.statWords.textContent  = wordCount.toLocaleString();
  dom.statChunks.textContent = pages.length.toLocaleString();
  dom.statChars.textContent  = charCount.toLocaleString();
}

function showProgress(pct, label) {
  dom.parseProgress.classList.remove('hidden');
  dom.parseBar.style.width = `${pct}%`;
  dom.parseProgress.setAttribute('aria-valuenow', pct);
  dom.parseStatus.textContent = label;
}

function hideProgress() {
  dom.parseProgress.classList.add('hidden');
  dom.parseStatus.textContent = '';
}

// ─── READY STATE ─────────────────────────────────────────────────────────────
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

// Auto-resize textarea
dom.questionInput.addEventListener('input', () => {
  dom.questionInput.style.height = 'auto';
  dom.questionInput.style.height = Math.min(dom.questionInput.scrollHeight, 160) + 'px';

  const len = dom.questionInput.value.length;
  dom.charCount.textContent = `${len} / 2000`;
  dom.charCount.className = 'char-count' + (len > 1800 ? ' danger' : len > 1500 ? ' warning' : '');
});

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

/**
 * Main question handler: shows user message, calls Gemini, renders response.
 */
async function handleQuestion(question) {
  if (state.isLoading) return;

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
 * Calls the Gemini 1.5 Flash API with the full document context.
 * Uses a conversation history for multi-turn support.
 */
async function callGemini(question) {
  // Build context-augmented user message for the first turn
  // For subsequent turns, document context is already in system instruction
  const isFirstTurn = state.conversationHistory.length === 0;

  let userContent = question;
  if (isFirstTurn) {
    userContent =
      `DOCUMENT TO ANALYZE:\n${state.document.fullText}\n\n---END OF DOCUMENT---\n\nUSER QUESTION: ${question}`;
  } else {
    // On subsequent turns, add a reminder about the document
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

  const res = await fetch(`${GEMINI_API_URL}?key=${encodeURIComponent(state.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

/**
 * Appends a user message bubble to the chat.
 */
function appendMessage(role, text) {
  const el = createMessageElement(role, text);
  dom.chatMessages.appendChild(el);
  scrollChatToBottom();
  return el;
}

/**
 * Parses and renders the assistant's full response, extracting citations.
 */
function renderAssistantResponse(text) {
  const citations = extractCitations(text);
  const isNotFound = /NOT FOUND IN DOCUMENT/i.test(text);

  const wrapper = document.createElement('div');
  wrapper.classList.add('message', 'assistant');
  if (isNotFound) wrapper.classList.add('not-found');

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;

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
 * Renders an error message in chat.
 */
function renderErrorMessage(msg) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant not-found';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

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

function createMessageElement(role, text) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = role === 'user' ? 'You' : 'AI';

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

function showTypingIndicator() {
  const id = 'typing-' + Date.now();
  const wrapper = document.createElement('div');
  wrapper.id = id;
  wrapper.className = 'message assistant typing-indicator';
  wrapper.setAttribute('role', 'status');
  wrapper.setAttribute('aria-label', 'LexAI is thinking…');

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;

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

function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  });
}

// ─── CITATION EXTRACTION ──────────────────────────────────────────────────────

/**
 * Extracts citation references like [Page 3], [Page 3, Clause 4.2], [Page 3, Section "Title"]
 * from the AI response text.
 */
function extractCitations(text) {
  const found = [];
  const seen = new Set();

  // Matches: [Page N], [Page N, Clause X], [Page N, Section "Y"], [Page N, Section Y]
  const pattern = /\[Page\s+(\d+)(?:,\s*(Clause|Section|Article|Paragraph|Clause|Annex)\s+([^\]]+))?\]/gi;
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
 * Extracts a relevant excerpt from page text, searching for section/clause text.
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
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status-badge ${type}`;
  el.classList.remove('hidden');
}

// ─── TOAST NOTIFICATIONS ─────────────────────────────────────────────────────
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
 * Converts plain AI response text to safe HTML with minimal markdown-like formatting.
 * Uses a whitelist approach to avoid XSS.
 */
function formatResponseHTML(text) {
  let escaped = escapeHTML(text);

  // Bold **text**
  escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // Italic *text*
  escaped = escaped.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Citation badges inline  [Page N, ...] → styled span
  escaped = escaped.replace(
    /\[Page\s+(\d+)(?:,\s*[^\]]+)?\]/g,
    match => `<span class="inline-citation" aria-label="Citation: ${escapeAttr(match)}" style="font-size:.75rem;font-weight:600;color:var(--clr-primary);background:var(--clr-primary-light);padding:.1rem .35rem;border-radius:var(--radius-full);white-space:nowrap;">${match}</span>`
  );

  // Warning/not found blocks
  escaped = escaped.replace(
    /(⚠️[^\n]+)/g,
    '<span style="color:var(--clr-warning);font-weight:600;">$1</span>'
  );

  // Bullet points: lines starting with - or •
  escaped = escaped.replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>');
  escaped = escaped.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  // Fix duplicate nested ul
  escaped = escaped.replace(/<\/ul>\s*<ul>/g, '');

  // Numbered lists
  escaped = escaped.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // Paragraphs (double newline)
  escaped = escaped.replace(/\n{2,}/g, '</p><p>');

  // Single newlines → line break
  escaped = escaped.replace(/\n/g, '<br>');

  return `<p>${escaped}</p>`;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── INITIALISATION ───────────────────────────────────────────────────────────
// Pre-configured API key (gemini-2.5-flash)
const DEFAULT_API_KEY = 'AIzaSyA4Kch049i_7BGnKR8BmGfX_C0kaBOljUY';

function init() {
  initTheme();
  updateReadyState();

  // Restore API key from session storage, or fall back to default
  const savedKey = sessionStorage.getItem('lexai-api-key') || DEFAULT_API_KEY;
  if (savedKey) {
    dom.apiKeyInput.value = savedKey;
    state.apiKey = savedKey;
    sessionStorage.setItem('lexai-api-key', savedKey);
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
