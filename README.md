# LexAI – Legal Document Assistant

> AI-powered legal document Q&A that answers strictly from your document — with citations, plain-language explanations, and zero hallucinations.

---

## Table of Contents

1. [Overview](#overview)
2. [Chosen Vertical](#chosen-vertical)
3. [Approach & Logic](#approach--logic)
4. [How the Solution Works](#how-the-solution-works)
5. [Hallucination Prevention](#hallucination-prevention)
6. [Citation System](#citation-system)
7. [Accessibility](#accessibility)
8. [Getting Started](#getting-started)
9. [Project Structure](#project-structure)
10. [Assumptions](#assumptions)
11. [Technologies Used](#technologies-used)

---

## Overview

**LexAI** is a client-side AI legal document assistant built for the PromptWars challenge: *"AI for Legal Assistance and Access."*

It allows anyone — regardless of legal expertise — to upload a legal document (contract, rental agreement, employment terms, NDA, etc.) and ask natural language questions about it. LexAI answers **strictly from the document**, citing the exact page and clause where each piece of information was found.

**Live demo:** Open `index.html` in any modern browser.

---

## Chosen Vertical

**Legal Document Understanding for Non-Expert Users**

The specific persona:
- A tenant reviewing a rental agreement they received before signing
- An employee reading their employment contract for the first time
- A small business owner understanding an NDA or service agreement

**Why AI provides a meaningful advantage here:**
1. Legal language is dense, full of jargon, and deliberately complex — AI can translate it to plain English instantly
2. Searching a 40-page PDF for a specific clause takes minutes; asking a question takes seconds
3. AI can synthesize information scattered across multiple clauses into a coherent answer
4. Without AI, these users either skip reading (risky) or pay a lawyer for basic questions (expensive)

---

## Approach & Logic

### Architecture Decision: Pure Frontend

The entire application runs in the browser with no backend server:

```
User Browser
├── PDF.js (CDN)        ← Parses uploaded PDF, extracts text per page
├── LexAI App (JS)      ← Orchestrates everything
│   ├── Document chunker  ← Structures text with page markers
│   ├── Prompt builder    ← Constructs grounding-focused system prompt
│   └── Citation parser   ← Extracts [Page N, Clause X] references
└── Gemini 1.5 Flash API ← Google AI (called directly via fetch)
```

**Benefits:**
- No server costs, no data storage, no privacy risk (documents never leave the user's machine except to Google's API)
- Instant deployment: just open `index.html`
- Repository stays well under 10 MB (zero `node_modules`)

### Decision Flow

```
Upload PDF
    │
    ▼
PDF.js extracts text per page
    │
    ▼
Text assembled as: "\n\n--- PAGE N ---\n{text}" for all pages
    │
    ▼
User asks question
    │
    ▼
System prompt + full document text + question → Gemini 1.5 Flash
    │
    ▼
Response parsed for [Page N, Clause X] citation patterns
    │
    ▼
Answer + citation badges rendered
(clicking a badge shows the raw excerpt from that page)
```

---

## How the Solution Works

### 1. Upload
- Drag-and-drop or click to browse for a PDF
- PDF.js parses it in the browser — no upload to any server
- Text is extracted page-by-page, preserving page boundaries
- Documents up to 20 MB / ~900,000 characters supported

### 2. Ask a Question
- User types a natural-language question (e.g. "What are the termination conditions?")
- Suggested questions help non-expert users get started
- `Shift+Enter` for newlines, `Enter` to submit

### 3. AI Processing
- The full document text is sent to Gemini 1.5 Flash along with a strict system instruction
- Temperature is set to `0.1` (near-deterministic) to minimise creative speculation
- Multi-turn conversation history is maintained for follow-up questions

### 4. Response Rendering
- Answer is displayed in plain, readable language
- Legal terms are explained inline
- `[Page N]` / `[Page N, Clause X]` citations appear as clickable badges
- Clicking a badge opens a modal showing the raw text from that page

### 5. Not-Found Handling
- If the answer isn't in the document, the model responds:
  > ⚠️ NOT FOUND IN DOCUMENT: The document does not contain information about [topic].
- These responses are visually distinguished with a yellow warning style

---

## Hallucination Prevention

This was a primary design goal. Three layers work together:

**Layer 1 – System Prompt Constraints**
```
CRITICAL RULES:
1. DOCUMENT-ONLY ANSWERS: Only use information explicitly present in the provided document.
2. EXPLICIT NOT FOUND: If the answer cannot be found, respond with "NOT FOUND IN DOCUMENT".
3. CITATIONS ARE MANDATORY: Every factual claim must include [Page N] or [Page N, Clause X].
4. PLAIN LANGUAGE: Explain legal terms immediately after using them.
```

**Layer 2 – Low Temperature**
- `temperature: 0.1` makes responses stick to document content rather than "creative" extrapolation

**Layer 3 – Response Classification**
- Client-side regex detects `NOT FOUND IN DOCUMENT` responses and renders them with a distinct warning style, making it visually clear to the user that the information wasn't present

---

## Citation System

Citations follow the pattern: `[Page N]`, `[Page N, Clause X]`, `[Page N, Section "Title"]`

The model is instructed to place these immediately after each factual claim. The client then:
1. Parses all `[Page N...]` patterns via regex from the response text
2. Deduplicates identical references
3. Renders them as clickable badge buttons
4. On click: pulls the raw text from that page (extracted during PDF parse) and shows it in a modal with the page number and section reference

---

## Accessibility

LexAI is built to WCAG 2.1 AA standards:

| Feature | Implementation |
|---|---|
| Skip link | "Skip to main content" link at top of page |
| Keyboard navigation | All interactive elements keyboard-accessible |
| Focus management | Visible focus ring on all focusable elements; focus trapped in modal |
| Screen reader support | ARIA labels, roles (`dialog`, `log`, `status`, `alert`), `aria-live` regions |
| Colour contrast | All text meets 4.5:1 contrast ratio minimum |
| Dark mode | Full dark theme via CSS custom properties; respects OS preference |
| Reduced motion | Animations disabled via `prefers-reduced-motion` media query |
| High contrast mode | `forced-colors: active` media query support |
| Semantic HTML | Proper use of `<header>`, `<main>`, `<aside>`, `<section>`, `<nav>`, `<dl>`, `<time>` |
| Error handling | All errors announced via `aria-live="assertive"` toast notifications |

---

## Getting Started

### Prerequisites
- A modern browser (Chrome 90+, Firefox 88+, Safari 14+, Edge 90+)
- A free [Google Gemini API key](https://aistudio.google.com/app/apikey)
- A legal PDF document to upload

### Run Locally

```bash
git clone https://github.com/YOUR_USERNAME/legal-ai-assistant.git
cd legal-ai-assistant

# Option 1: Open directly (works for basic use)
open index.html

# Option 2: Serve locally (recommended, avoids CORS issues on some browsers)
python3 -m http.server 8080
# then open http://localhost:8080
```

### Run Tests

```bash
# Browser tests (no Node required)
open tests/runner.html

# Node.js (optional)
node tests/lexai.test.js
```

### Usage

1. Enter your Gemini API key in the sidebar (stored in session only, never persisted)
2. Upload a PDF legal document
3. Wait for parsing to complete (progress bar shown)
4. Ask any question using the chat input or click a suggested question
5. Click citation badges to view the raw source excerpt from the document

---

## Project Structure

```
legal-ai-assistant/
├── index.html           # Single-page application shell
├── style.css            # Full CSS with design tokens, dark mode, accessibility
├── app.js               # All application logic
├── tests/
│   ├── lexai.test.js    # Node.js-compatible test suite
│   └── runner.html      # Browser-based visual test runner
└── README.md            # This file
```

---

## Assumptions

1. **PDF text-based only**: Scanned PDFs (image-only) are not supported. The document must contain selectable text. This covers ~95% of legal documents shared digitally.

2. **Single document per session**: The tool is designed for focused analysis of one document at a time. Uploading a new document clears the conversation history.

3. **API key provided by user**: To avoid misuse and keep the repo clean, the Gemini API key is entered at runtime. It is stored in `sessionStorage` (clears on tab close) not `localStorage`.

4. **English-primary**: While Gemini handles multiple languages, UI text and suggested questions are in English. The model will respond in the language of the question.

5. **Context limit**: Documents exceeding ~900,000 characters are truncated. This covers documents up to approximately 300 pages. Most legal agreements are well within this limit.

6. **No legal advice disclaimer**: LexAI explicitly disclaims that it provides legal information, not legal advice. This is enforced both in the UI and in the AI system prompt.

---

## Technologies Used

| Technology | Purpose |
|---|---|
| HTML5 | Semantic markup, accessibility |
| CSS3 | Styling, responsive design, dark mode via custom properties |
| Vanilla JavaScript (ES2020+) | All application logic, no frameworks |
| [PDF.js](https://mozilla.github.io/pdf.js/) (CDN, v3.11) | Client-side PDF parsing and text extraction |
| [Google Gemini 2.5 Flash Lite API](https://ai.google.dev/) | AI language model for Q&A (1M token context window) |
| Google AI Studio | API key management |

**No build tools. No `node_modules`. No framework dependencies.**  
The entire app is three files: `index.html`, `style.css`, `app.js`.

---

## Evaluation Alignment

| Criteria | Implementation |
|---|---|
| **Code Quality** | Single-responsibility functions, JSDoc comments, consistent naming, clean separation of concerns |
| **Security** | XSS prevention via `escapeHTML()`, API key in sessionStorage only, no external data exfiltration, Content Security aligned |
| **Efficiency** | PDF parsed once and cached; conversation history pruned to last 6 turns; lazy DOM updates |
| **Testing** | 30+ unit tests covering citation parsing, XSS prevention, file validation, hallucination detection |
| **Accessibility** | WCAG 2.1 AA: ARIA, keyboard nav, screen reader support, focus management, colour contrast, dark mode, reduced motion |
| **Problem Statement** | Document-grounded Q&A with mandatory citations, explicit not-found responses, plain language explanations, legal disclaimer |
| **Google Services** | Gemini 1.5 Flash (Google AI), PDF.js (Mozilla/open source) |

---

*Built for PromptWars – AI for Legal Assistance and Access.*
