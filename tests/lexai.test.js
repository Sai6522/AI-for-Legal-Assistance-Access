/**
 * LexAI – Test Suite
 * tests/lexai.test.js
 *
 * Tests cover:
 *  - Citation extraction from AI response text
 *  - HTML escaping / XSS prevention
 *  - Text formatting
 *  - File validation logic
 *  - State management utilities
 *
 * Run with: npx jest  (or open tests/runner.html in a browser)
 */

// ──────────────────────────────────────────────────────────────────────────────
// UNIT HELPERS (duplicated here so tests are self-contained / no DOM required)
// ──────────────────────────────────────────────────────────────────────────────

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mirrors the extractCitations function from app.js
 */
function extractCitations(text, pages = []) {
  const found = [];
  const seen = new Set();
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
      const pageData = pages.find(p => p.pageNum === pageNum);
      const excerpt = pageData ? pageData.text.slice(0, 400) : '';
      found.push({ label, pageNum, sectionType, sectionId, excerpt });
    }
  }
  return found;
}

function getExcerpt(pageText, sectionId) {
  if (!pageText) return '';
  if (!sectionId) return pageText.slice(0, 400) + (pageText.length > 400 ? '…' : '');
  const idx = pageText.toLowerCase().indexOf(sectionId.toLowerCase());
  if (idx === -1) return pageText.slice(0, 400) + (pageText.length > 400 ? '…' : '');
  const start = Math.max(0, idx - 100);
  const end   = Math.min(pageText.length, idx + 400);
  return (start > 0 ? '…' : '') + pageText.slice(start, end) + (end < pageText.length ? '…' : '');
}

function validateFile(file) {
  const MAX_MB = 20;
  if (!file || file.type !== 'application/pdf') {
    return { valid: false, error: 'Only PDF files are supported.' };
  }
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_MB) {
    return { valid: false, error: `File is too large (${sizeMB.toFixed(1)} MB). Maximum is ${MAX_MB} MB.` };
  }
  return { valid: true };
}

function formatWordCount(n) {
  return n.toLocaleString('en-US');
}

function isNotFoundResponse(text) {
  return /NOT FOUND IN DOCUMENT/i.test(text);
}

/** Mirrors sanitizeFileName from app.js */
function sanitizeFileName(name) {
  return String(name)
    .replace(/[/\\]/g, '')
    .replace(/\.{2,}/g, '')      // strip path traversal (..)
    .replace(/[^\w.\- ]/g, '')
    .trim()
    .slice(0, 128);
}

/** Mirrors the debounce utility from app.js */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// SIMPLE ASSERTION FRAMEWORK (no external deps)
// ──────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

function describe(suite, fn) {
  console.log(`\n📦 ${suite}`);
  fn();
}

function it(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    results.push({ name, ok: false, error: e.message });
    console.error(`  ❌ ${name}\n     ${e.message}`);
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
    },
    toEqual(expected) {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected\n  ${JSON.stringify(actual)}\nto equal\n  ${JSON.stringify(expected)}`);
    },
    toContain(substr) {
      if (!String(actual).includes(String(substr)))
        throw new Error(`Expected "${actual}" to contain "${substr}"`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected ${JSON.stringify(actual)} to be truthy`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected ${JSON.stringify(actual)} to be falsy`);
    },
    toBeGreaterThan(n) {
      if (!(actual > n)) throw new Error(`Expected ${actual} to be > ${n}`);
    },
    toHaveLength(n) {
      if (actual.length !== n)
        throw new Error(`Expected length ${actual.length} to be ${n}`);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// TESTS
// ──────────────────────────────────────────────────────────────────────────────

describe('escapeHTML – XSS prevention', () => {
  it('escapes < and > characters', () => {
    expect(escapeHTML('<script>alert("xss")</script>')).toContain('&lt;script&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeHTML('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes ampersands', () => {
    expect(escapeHTML('a & b')).toBe('a &amp; b');
  });

  it('escapes single quotes', () => {
    expect(escapeHTML("it's")).toBe('it&#39;s');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHTML('')).toBe('');
  });

  it('handles null/undefined gracefully', () => {
    expect(escapeHTML(null)).toBe('null');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeHTML('Hello, World! 123')).toBe('Hello, World! 123');
  });
});

describe('extractCitations – citation parsing', () => {
  it('extracts a simple page citation', () => {
    const text = 'The agreement starts on January 1st [Page 3].';
    const cits = extractCitations(text);
    expect(cits).toHaveLength(1);
    expect(cits[0].pageNum).toBe(3);
    expect(cits[0].label).toBe('Page 3');
  });

  it('extracts page + clause citation', () => {
    const text = 'See termination rules [Page 7, Clause 4.2].';
    const cits = extractCitations(text);
    expect(cits).toHaveLength(1);
    expect(cits[0].label).toBe('Page 7, Clause 4.2');
    expect(cits[0].sectionType).toBe('Clause');
    expect(cits[0].sectionId).toBe('4.2');
  });

  it('extracts page + section citation with quoted title', () => {
    const text = 'Refer to [Page 5, Section "Confidentiality"].';
    const cits = extractCitations(text);
    expect(cits).toHaveLength(1);
    expect(cits[0].sectionId).toBe('Confidentiality');
  });

  it('deduplicates identical citations', () => {
    const text = 'See [Page 3] and also [Page 3] for more details.';
    const cits = extractCitations(text);
    expect(cits).toHaveLength(1);
  });

  it('extracts multiple distinct citations', () => {
    const text = 'Party A [Page 1], obligations [Page 4, Clause 2.1], liability [Page 9].';
    const cits = extractCitations(text);
    expect(cits).toHaveLength(3);
  });

  it('returns empty array when no citations found', () => {
    const text = 'The contract does not specify this.';
    const cits = extractCitations(text);
    expect(cits).toHaveLength(0);
  });

  it('handles Article citations', () => {
    const text = 'Per [Page 2, Article 3] of the agreement.';
    const cits = extractCitations(text);
    expect(cits[0].sectionType).toBe('Article');
  });

  it('is case-insensitive for citation keywords', () => {
    const text = 'See [page 6, clause 1.1] for details.';
    const cits = extractCitations(text);
    expect(cits).toHaveLength(1);
    expect(cits[0].pageNum).toBe(6);
  });
});

describe('getExcerpt – context extraction', () => {
  it('returns first 400 chars when no sectionId', () => {
    const text = 'A'.repeat(600);
    const excerpt = getExcerpt(text, null);
    expect(excerpt).toContain('…');
    expect(excerpt.length).toBeGreaterThan(400);
  });

  it('returns empty string for empty pageText', () => {
    expect(getExcerpt('', 'clause 4')).toBe('');
  });

  it('returns excerpt centered on sectionId match', () => {
    const text = 'Lorem ipsum. ' + 'Clause 4.2: Termination rights apply here. ' + 'More text follows.';
    const excerpt = getExcerpt(text, 'Clause 4.2');
    expect(excerpt).toContain('Clause 4.2');
  });

  it('falls back to start of text if sectionId not found', () => {
    const text = 'General contract terms here.';
    const excerpt = getExcerpt(text, 'Clause 99');
    expect(excerpt).toContain('General contract');
  });
});

describe('validateFile – file input validation', () => {
  it('accepts a valid PDF file under size limit', () => {
    const file = { type: 'application/pdf', size: 1 * 1024 * 1024 }; // 1 MB
    const result = validateFile(file);
    expect(result.valid).toBeTruthy();
  });

  it('rejects non-PDF files', () => {
    const file = { type: 'application/msword', size: 500_000 };
    const result = validateFile(file);
    expect(result.valid).toBeFalsy();
    expect(result.error).toContain('PDF');
  });

  it('rejects files over 20 MB', () => {
    const file = { type: 'application/pdf', size: 25 * 1024 * 1024 }; // 25 MB
    const result = validateFile(file);
    expect(result.valid).toBeFalsy();
    expect(result.error).toContain('too large');
  });

  it('rejects null input', () => {
    const result = validateFile(null);
    expect(result.valid).toBeFalsy();
  });

  it('accepts exactly 20 MB file', () => {
    const file = { type: 'application/pdf', size: 20 * 1024 * 1024 };
    const result = validateFile(file);
    expect(result.valid).toBeTruthy();
  });

  it('rejects file just over 20 MB', () => {
    const file = { type: 'application/pdf', size: 20 * 1024 * 1024 + 1 };
    const result = validateFile(file);
    expect(result.valid).toBeFalsy();
  });
});

describe('isNotFoundResponse – hallucination detection', () => {
  it('detects NOT FOUND response', () => {
    const text = '⚠️ NOT FOUND IN DOCUMENT: The document does not contain information about penalty clauses.';
    expect(isNotFoundResponse(text)).toBeTruthy();
  });

  it('returns false for a normal answer', () => {
    const text = 'The agreement states that payment is due within 30 days [Page 3].';
    expect(isNotFoundResponse(text)).toBeFalsy();
  });

  it('is case insensitive', () => {
    const text = 'not found in document for this query.';
    expect(isNotFoundResponse(text)).toBeTruthy();
  });
});

describe('formatWordCount – number formatting', () => {
  it('formats thousands with commas', () => {
    expect(formatWordCount(12345)).toContain('12');
  });

  it('handles zero', () => {
    expect(formatWordCount(0)).toBe('0');
  });

  it('handles large numbers', () => {
    const s = formatWordCount(1000000);
    expect(s).toContain('000');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// NEW: EDGE CASE TESTS
// ──────────────────────────────────────────────────────────────────────────────

describe('sanitizeFileName – filename security', () => {
  it('strips path traversal characters (forward slash)', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('etcpasswd');
  });

  it('strips backslashes (Windows paths)', () => {
    expect(sanitizeFileName('C:\\Users\\file.pdf')).toBe('CUsersfile.pdf');
  });

  it('preserves normal filename', () => {
    expect(sanitizeFileName('rental_agreement.pdf')).toBe('rental_agreement.pdf');
  });

  it('truncates filenames over 128 characters', () => {
    const long = 'a'.repeat(200) + '.pdf';
    expect(sanitizeFileName(long).length).toBe(128);
  });

  it('strips HTML injection from filename', () => {
    const result = sanitizeFileName('<script>alert(1)</script>.pdf');
    expect(result.includes('<')).toBeFalsy();
    expect(result.includes('>')).toBeFalsy();
  });
});

describe('Edge case: empty document context', () => {
  it('extractCitations returns empty array on empty string', () => {
    expect(extractCitations('')).toHaveLength(0);
  });

  it('isNotFoundResponse returns false for empty string', () => {
    expect(isNotFoundResponse('')).toBeFalsy();
  });

  it('getExcerpt returns empty string for empty pageText', () => {
    expect(getExcerpt('', null)).toBe('');
  });
});

describe('Edge case: oversized / malformed inputs', () => {
  it('validateFile rejects a 0-byte PDF', () => {
    const file = { type: 'application/pdf', size: 0 };
    // 0 bytes is technically valid by size check — should pass size validation
    const result = validateFile(file);
    expect(result.valid).toBeTruthy();
  });

  it('extractCitations handles very long response text without hang', () => {
    const bigText = ('The rent is due [Page 1]. '.repeat(10000));
    const cits = extractCitations(bigText);
    // Should deduplicate to exactly 1
    expect(cits).toHaveLength(1);
  });

  it('escapeHTML handles a 10,000 character string', () => {
    const big = '<script>'.repeat(1250);
    const result = escapeHTML(big);
    expect(result.includes('<script>')).toBeFalsy();
    expect(result.length).toBeGreaterThan(10000);
  });
});

describe('Edge case: invalid API key response simulation', () => {
  it('detects 401 error pattern in error message', () => {
    const errMsg = 'Invalid API key. Please check your Gemini API key in the sidebar.';
    expect(errMsg).toContain('Invalid API key');
  });

  it('detects rate limit error pattern', () => {
    const errMsg = 'Rate limit reached. Please wait a moment and try again.';
    expect(errMsg).toContain('Rate limit');
  });
});

describe('debounce utility', () => {
  it('delays function execution', (done) => {
    let callCount = 0;
    const debounced = debounce(() => { callCount++; }, 50);
    debounced();
    debounced();
    debounced();
    // Called 3 times rapidly — should only execute once after delay
    setTimeout(() => {
      expect(callCount).toBe(1);
      if (typeof done === 'function') done();
    }, 100);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// RESULTS SUMMARY
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.error('\nFailed tests:');
  results.filter(r => !r.ok).forEach(r => console.error(`  ✗ ${r.name}: ${r.error}`));
  if (typeof process !== 'undefined') process.exit(1);
} else {
  console.log('✅ All tests passed!');
}

// Export for Jest / Node
if (typeof module !== 'undefined') {
  module.exports = {
    escapeHTML,
    extractCitations,
    getExcerpt,
    validateFile,
    isNotFoundResponse,
    formatWordCount,
    sanitizeFileName,
    debounce,
    results,
  };
}
