// ── Markdown Renderer ──
// Lightweight, XSS-safe Markdown-to-HTML renderer for dashboard README display.
// No external dependencies — regex-based parsing with HTML sanitization.

/**
 * Escapes HTML special characters to prevent XSS.
 */
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders a Markdown string to sanitized HTML.
 * Supports: headings, bold, italic, inline code, fenced code blocks,
 * unordered/ordered lists, links, blockquotes, horizontal rules, images (as placeholders).
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

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Code block placeholder — pass through
    const cbMatch = line.match(/^\x00CODEBLOCK(\d+)\x00$/);
    if (cbMatch) {
      closeList();
      closeBlockquote();
      out.push(codeBlocks[parseInt(cbMatch[1])]);
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
}

/**
 * Applies inline formatting: bold, italic, inline code, links, images.
 * Input is raw markdown text (not yet HTML-escaped).
 */
function inlineFormat(text) {
  // Escape HTML first
  text = escHtml(text);

  // Inline code (must come before bold/italic to protect backtick content)
  text = text.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // Images → placeholder (local paths don't work in WebView)
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g,
    '<span class="md-img-placeholder" title="$1">[Bild: $1]</span>');

  // Also handle raw <img> tags that were escaped
  text = text.replace(/&lt;img[^&]*?&gt;/gi,
    '<span class="md-img-placeholder">[Bild]</span>');

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

  return text;
}
