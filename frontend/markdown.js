// ── Markdown Renderer ──
// Lightweight, XSS-safe Markdown-to-HTML renderer for dashboard README display.
// No external dependencies — regex-based parsing with HTML sanitization.
// Supports safe inline HTML via allowlist.

/**
 * Escapes HTML special characters to prevent XSS.
 */
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── HTML Sanitizer (Allowlist-based) ──

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'img', 'a', 'strong', 'em', 'b', 'i', 'br', 'hr',
  'div', 'span', 'details', 'summary',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'ul', 'ol', 'li', 'code', 'pre', 'blockquote',
  'del', 'sub', 'sup', 'dd', 'dt', 'dl',
]);

const ALLOWED_ATTRS = new Set([
  'align', 'valign', 'width', 'height',
  'src', 'alt', 'title',
  'href', 'target', 'rel',
  'colspan', 'rowspan', 'scope',
  'open',
]);

/**
 * Sanitizes an HTML string: keeps only allowed tags with allowed attributes.
 * All event handlers (onclick, onerror, etc.) and unknown tags are stripped.
 */
function sanitizeHtml(html) {
  // Process tags one by one
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)?\/?>/g, (match, tag, attrsStr) => {
    const tagLower = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(tagLower)) return '';

    // Self-closing or closing tag
    if (match.startsWith('</')) return `</${tagLower}>`;

    // Filter attributes
    const cleanAttrs = [];
    if (attrsStr) {
      const attrRegex = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
        if (!ALLOWED_ATTRS.has(attrName)) continue;
        // Block dangerous URI schemes in href/src
        if ((attrName === 'href' || attrName === 'src') && /^\s*(javascript|data|vbscript)\s*:/i.test(attrVal)) continue;
        cleanAttrs.push(`${attrName}="${escHtml(attrVal)}"`);
      }
      // Handle boolean attributes (e.g. "open" on <details>)
      const boolRegex = /\b([a-zA-Z][\w-]*)\b(?!=)/g;
      let boolMatch;
      const usedAttrs = new Set(cleanAttrs.map(a => a.split('=')[0]));
      while ((boolMatch = boolRegex.exec(attrsStr)) !== null) {
        const name = boolMatch[1].toLowerCase();
        if (ALLOWED_ATTRS.has(name) && !usedAttrs.has(name)) {
          cleanAttrs.push(name);
          usedAttrs.add(name);
        }
      }
    }

    // Add rel="noopener" to links for security
    if (tagLower === 'a' && !cleanAttrs.some(a => a.startsWith('rel='))) {
      cleanAttrs.push('rel="noopener"');
    }
    if (tagLower === 'a' && !cleanAttrs.some(a => a.startsWith('target='))) {
      cleanAttrs.push('target="_blank"');
    }

    // Replace external <img> with badge span (CSP blocks external URLs in WebView)
    if (tagLower === 'img') {
      const srcEntry = cleanAttrs.find(a => a.startsWith('src='));
      if (srcEntry) {
        const srcVal = srcEntry.match(/^src="([^"]*)"/)?.[1] || '';
        if (/^https?:\/\//i.test(srcVal)) {
          const altEntry = cleanAttrs.find(a => a.startsWith('alt='));
          const altVal = altEntry ? (altEntry.match(/^alt="([^"]*)"/)?.[1] || '') : '';
          return `<span class="md-badge" title="${altVal}">${altVal || 'Image'}</span>`;
        }
      }
    }

    const selfClosing = tagLower === 'br' || tagLower === 'hr' || tagLower === 'img';
    const attrStr = cleanAttrs.length > 0 ? ' ' + cleanAttrs.join(' ') : '';
    return selfClosing ? `<${tagLower}${attrStr}>` : `<${tagLower}${attrStr}>`;
  });
}

/**
 * Checks if a line is an HTML block element (opening or closing).
 */
function isHtmlBlock(line) {
  const trimmed = line.trim();
  const m = trimmed.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
  if (!m) return false;
  const tag = m[1].toLowerCase();
  const blockTags = new Set([
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'details', 'summary',
    'ul', 'ol', 'blockquote', 'pre', 'hr', 'br',
  ]);
  return blockTags.has(tag) && ALLOWED_TAGS.has(tag);
}

/**
 * Renders a Markdown string to sanitized HTML.
 * Supports: headings, bold, italic, inline code, fenced code blocks,
 * unordered/ordered lists, links, blockquotes, horizontal rules, images (as placeholders),
 * and safe inline HTML via allowlist.
 */
export function renderMarkdown(md) {
  if (!md) return '';

  // Normalize line endings
  md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Extract fenced code blocks before processing (protect from other transforms)
  const codeBlocks = [];
  md = md.replace(/^```(\w*)\n([\s\S]*?)^```/gm, (_match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre class="md-code-block"><code${lang ? ` class="lang-${escHtml(lang)}"` : ''}>${escHtml(code.replace(/\n$/, ''))}</code></pre>`
    );
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Process line by line
  const lines = md.split('\n');
  const out = [];
  let inList = null; // 'ul' | 'ol' | null
  let inBlockquote = false;
  let inHtmlBlock = false;
  let htmlBlockBuf = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Code block placeholder — pass through
    const cbMatch = line.match(/^\x00CODEBLOCK(\d+)\x00$/);
    if (cbMatch) {
      closeList();
      closeBlockquote();
      closeHtmlBlock();
      out.push(codeBlocks[parseInt(cbMatch[1])]);
      continue;
    }

    // HTML block detection: lines starting with allowed block-level HTML tags
    if (!inHtmlBlock && isHtmlBlock(line) && !inList && !inBlockquote) {
      closeList();
      closeBlockquote();
      inHtmlBlock = true;
      htmlBlockBuf = [line];
      // Check if the block closes on the same line
      if (isHtmlBlockComplete(htmlBlockBuf.join('\n'))) {
        closeHtmlBlock();
      }
      continue;
    }
    if (inHtmlBlock) {
      htmlBlockBuf.push(line);
      if (isHtmlBlockComplete(htmlBlockBuf.join('\n'))) {
        closeHtmlBlock();
      }
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      closeBlockquote();
      out.push('<hr class="md-hr">');
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      closeBlockquote();
      const level = headingMatch[1].length;
      out.push(`<h${level} class="md-h${level}">${inlineFormat(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      closeList();
      if (!inBlockquote) {
        out.push('<blockquote class="md-blockquote">');
        inBlockquote = true;
      }
      out.push(`<p>${inlineFormat(line.slice(2))}</p>`);
      continue;
    } else if (inBlockquote) {
      closeBlockquote();
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList();
        out.push('<ul class="md-list">');
        inList = 'ul';
      }
      out.push(`<li>${inlineFormat(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        closeList();
        out.push('<ol class="md-list">');
        inList = 'ol';
      }
      out.push(`<li>${inlineFormat(olMatch[2])}</li>`);
      continue;
    }

    // Close list if we hit a non-list line
    if (inList) closeList();

    // Empty line
    if (line.trim() === '') {
      continue;
    }

    // Paragraph
    out.push(`<p class="md-p">${inlineFormat(line)}</p>`);
  }

  closeList();
  closeBlockquote();
  closeHtmlBlock();

  return out.join('\n');

  function closeList() {
    if (inList) {
      out.push(inList === 'ul' ? '</ul>' : '</ol>');
      inList = null;
    }
  }

  function closeBlockquote() {
    if (inBlockquote) {
      out.push('</blockquote>');
      inBlockquote = false;
    }
  }

  function closeHtmlBlock() {
    if (inHtmlBlock) {
      const raw = htmlBlockBuf.join('\n');
      out.push(sanitizeHtml(raw));
      inHtmlBlock = false;
      htmlBlockBuf = [];
    }
  }
}

/**
 * Checks if an HTML block buffer has balanced opening/closing tags
 * (simple heuristic: empty line or balanced top-level tag).
 */
function isHtmlBlockComplete(block) {
  const trimmed = block.trim();
  // Self-closing tags are always complete
  if (/^<(br|hr|img)\b[^>]*>$/i.test(trimmed)) return true;
  // Check if last line is empty (blank-line terminated)
  if (block.endsWith('\n\n')) return true;
  // Check balanced tags (simple: first opening tag has matching closing tag)
  const openMatch = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  if (!openMatch) return true;
  const tag = openMatch[1].toLowerCase();
  const closeRegex = new RegExp(`</${tag}\\s*>\\s*$`, 'i');
  return closeRegex.test(trimmed);
}

/**
 * Applies inline formatting: bold, italic, inline code, links, images.
 * Input is raw markdown text (not yet HTML-escaped).
 * Preserves allowed inline HTML tags.
 */
function inlineFormat(text) {
  // Extract inline HTML tags before escaping, replace with placeholders
  const inlineTags = [];
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)?\/?>/g, (match, tag) => {
    const tagLower = tag.toLowerCase();
    if (ALLOWED_TAGS.has(tagLower)) {
      const idx = inlineTags.length;
      inlineTags.push(sanitizeHtml(match));
      return `\x00INLINETAG${idx}\x00`;
    }
    return ''; // Strip disallowed tags
  });

  // Escape HTML (now safe — allowed tags are placeholders)
  text = escHtml(text);

  // Inline code (must come before bold/italic to protect backtick content)
  text = text.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // Images → placeholder (local paths don't work in WebView)
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g,
    '<span class="md-img-placeholder" title="$1">[Bild: $1]</span>');

  // Links
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');

  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Restore inline HTML tags from placeholders
  text = text.replace(/\x00INLINETAG(\d+)\x00/g, (_m, idx) => inlineTags[parseInt(idx)]);

  return text;
}
