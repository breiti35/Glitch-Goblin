// ── Internationalization Module ──
// Lightweight i18n for vanilla JS with DE/EN support.

import de from './locales/de.js';
import en from './locales/en.js';

const locales = { de, en };
let current = 'de';
const listeners = [];

/**
 * Translate a key. Supports dot-notation and {param} interpolation.
 * Falls back to key itself if not found.
 */
export function t(key, params = {}) {
  const keys = key.split('.');
  let val = locales[current];
  for (const k of keys) {
    if (val == null) break;
    val = val[k];
  }
  if (typeof val !== 'string') return key;
  return val.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
}

/**
 * Set the active locale and re-translate the DOM.
 */
export function setLocale(locale) {
  if (!locales[locale]) return;
  current = locale;
  document.documentElement.lang = locale;
  translateDOM();
  listeners.forEach(fn => fn(locale));
}

export function getLocale() {
  return current;
}

export function onLocaleChange(fn) {
  listeners.push(fn);
}

/**
 * Translate all elements with data-i18n attributes.
 */
export function translateDOM() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const translated = t(el.dataset.i18n);
    if (translated !== el.dataset.i18n) el.textContent = translated;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const translated = t(el.dataset.i18nTitle);
    if (translated !== el.dataset.i18nTitle) el.title = translated;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const translated = t(el.dataset.i18nPlaceholder);
    if (translated !== el.dataset.i18nPlaceholder) el.placeholder = translated;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const translated = t(el.dataset.i18nHtml);
    if (translated !== el.dataset.i18nHtml) el.innerHTML = translated;
  });
}
