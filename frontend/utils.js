// ── Utility Functions ──
// Pure utility functions with no app dependencies.

import { t, getLocale } from './i18n.js';

export function esc(str) {
  if (str == null) return "";
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

export function timeAgo(dateStr) {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "";
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);

    if (diff < 0) return t('time.justNow');
    if (diff < 60) return t('time.justNow');
    if (diff < 3600) {
      const m = Math.floor(diff / 60);
      return t('time.minutesAgo', {n: m});
    }
    if (diff < 86400) {
      const h = Math.floor(diff / 3600);
      return t('time.hoursAgo', {n: h});
    }
    const d = Math.floor(diff / 86400);
    if (d === 1) return t('time.oneDayAgo');
    if (d < 30) return t('time.daysAgo', {n: d});
    const months = Math.floor(d / 30);
    if (months === 1) return t('time.oneMonthAgo');
    return t('time.monthsAgo', {n: months});
  } catch {
    return "";
  }
}

export function formatDuration(ms) {
  if (ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "min";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "min";
  const d = Math.floor(h / 24);
  return d + "d " + (h % 24) + "h";
}

export function formatTimeShort(dateStr) {
  try {
    const locale = getLocale() === 'de' ? 'de-DE' : 'en-US';
    const d = new Date(dateStr);
    return d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }) + " " +
           d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

// Escaping for arguments passed to the LOCAL shell (bash, PowerShell, CMD).
// Double quotes work on all three; single quotes fail in CMD.
export function shellEscapeLocal(s) {
  if (!s) return '""';
  if (/^[a-zA-Z0-9._\-\/~@:+]+$/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

// Escaping for arguments inside an SSH remote-command string.
// The remote server always runs bash/sh, so POSIX single-quote rules apply.
// Do NOT use this for local-shell arguments (single quotes fail in CMD).
export function shellEscape(s) {
  if (!s) return "''";
  if (/^[a-zA-Z0-9._\-\/~@:+]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function validateDeployParam(name, value) {
  if (!value) return true;
  if (value.length > 500) {
    console.error(`Security: ${name} exceeds max length (500)`);
    return false;
  }
  if (/[;\|&\$`\n\r\0<>\(\)\{\}!\~\#\%\^\*\?\[\]"\\]/.test(value)) {
    console.error(`Security: ${name} contains forbidden characters`);
    return false;
  }
  return true;
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Wraps an async function to prevent concurrent execution (double-click guard).
export function withGuard(fn) {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try {
      await fn(...args);
    } finally {
      running = false;
    }
  };
}

export function logError(context, error) {
  const msg = `[${context}] ${error?.message || error}`;
  console.error(msg, error);
  const body = document.getElementById("log-body");
  if (body) {
    const line = document.createElement("div");
    line.className = "log-line error";
    line.textContent = msg;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }
}
