// ── Global Error Handler ──
// Catches unhandled promise rejections and logs them.

import { logError } from './utils.js';

export function installErrorHandler() {
  window.addEventListener("unhandledrejection", (event) => {
    logError("unhandled", event.reason);
  });
}
