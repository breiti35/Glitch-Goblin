// ── Notifications, Toasts & Sounds ──
import { esc, timeAgo, logError } from './utils.js';
import { t } from './i18n.js';

// ── Sound Data URIs ──
const SOUNDS = {
  success: "data:audio/wav;base64,UklGRlQBAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YTABAAAAAAAlAEoAbACLAKgAwgDYAOoA9wAAAAUABQAAAAMA/v/2/+3/4f/V/8j/vP+x/6f/n/+Z/5X/lP+V/5r/ov+t/7r/yv/c//D/AAARACoAPABPAGIAdQCHAJYApACvALcAvAC+AL0AuACvAKIAkgB+AGQASABIAC8AEgD0/9T/sv+R/3D/UP8z/xj/AP/s/tz+0P7I/sT+xf7K/tP+4f7z/gj/IP88/1r/ev+d/8H/5v8LAC8AVABxAKAAuwDWAOoA+gAFAQoBC",
  error: "data:audio/wav;base64,UklGRlQBAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YTABAAAAAPj/4f/E/6P/gf9g/0D/JP8N//z+8f7u/vH+/P4O/yb/Rf9p/5L/vf/r/xoASAB1AKAA1QAAASkBSgFkAXUBfgF+AXUBZAFKAV8BKAHyALcAdwA1APIE1v+k/3D/Qf8V//D+0P60/p/+j/6F/oL+hf6O/p3+sv7M/uz+EP84/2P/kP/A//D/IgBTAIIArwDaAAAAJAFCAVoBawF2AXkBdAFoAVQBOAEWAe0AvgCKAFIAFwDZ/5b/"
};

// ── Desktop Notifications ──
/** Zeigt eine Desktop-Benachrichtigung wenn vom Benutzer aktiviert.
 * @param {string} title - Titel der Benachrichtigung.
 * @param {string} body - Inhalt der Benachrichtigung.
 * @param {object} settings - Das settings-Objekt aus dem globalen State.
 */
export function notifyDesktop(title, body, settings) {
  if (settings.notifications_enabled === false) return;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch (e) {
    logError("Notification failed", e);
  }
}

// ── Sounds ──
/** Spielt einen Sound ab (success/error) wenn Sounds aktiviert sind.
 * @param {string} name - Name des Sounds ("success" oder "error").
 * @param {object} settings - Das settings-Objekt aus dem globalen State.
 */
export function playSound(name, settings) {
  if (settings.sounds_enabled === false) return;
  const uri = SOUNDS[name];
  if (!uri) return;
  try {
    const audio = new Audio(uri);
    audio.volume = 0.5;
    audio.play().catch(() => { /* autoplay restricted */ });
  } catch (e) {
    logError("Sound failed", e);
  }
}

// ── Toast System ──
/** Zeigt eine kurze Toast-Benachrichtigung an und fuegt sie dem Notification-Center hinzu.
 * @param {string} message - Der anzuzeigende Text.
 * @param {"info"|"success"|"error"} [type="info"] - Typ der Benachrichtigung.
 * @param {number} [duration=3000] - Anzeigedauer in Millisekunden.
 */
export function showToast(message, type = "info", duration = 3000) {
  // Also add to notification center
  addNotification(message, type);

  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const icons = { success: "\u2713", error: "\u2717", info: "\u24D8" };
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-text">${esc(message)}</span>`;

  container.appendChild(toast);

  // Trigger enter animation
  requestAnimationFrame(() => toast.classList.add("toast-visible"));

  // Auto-dismiss
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    // Fallback removal if transition doesn't fire
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ── Notification Center ──
const notifications = [];
const NOTIF_MAX = 50;

/** Fuegt eine Benachrichtigung in das Notification-Center ein (max. 50 Eintraege).
 * @param {string} message - Der Benachrichtigungstext.
 * @param {"info"|"success"|"error"} [type="info"] - Typ der Benachrichtigung.
 */
export function addNotification(message, type = "info") {
  notifications.unshift({ message, type, time: new Date() });
  if (notifications.length > NOTIF_MAX) notifications.pop();
  updateNotifBadge();
  renderNotifList();
}

function updateNotifBadge() {
  const badge = document.getElementById("header-notif-badge");
  if (badge) {
    const count = notifications.length;
    badge.textContent = count;
    badge.classList.toggle("hidden", count === 0);
  }
}

function renderNotifList() {
  const list = document.getElementById("notif-list");
  if (!list) return;
  if (notifications.length === 0) {
    list.innerHTML = `<p class="empty-state">${esc(t('header.noNotifications'))}</p>`;
    return;
  }
  list.innerHTML = notifications.map(n => {
    const icons = { success: "\u2713", error: "\u2717", info: "\u24D8", warning: "\u26A0" };
    const ago = timeAgo(n.time.toISOString());
    return `<div class="notif-item notif-${n.type}">
      <span class="notif-icon">${icons[n.type] || icons.info}</span>
      <span class="notif-text">${esc(n.message)}</span>
      <span class="notif-time">${ago}</span>
    </div>`;
  }).join("");
}

/** Richtet Event-Listener fuer das Notification-Center ein (Toggle, Clear, Outside-Click). */
export function setupNotifCenter() {
  document.getElementById("header-notif-btn")?.addEventListener("click", () => {
    const panel = document.getElementById("notif-panel");
    if (panel) {
      panel.classList.toggle("hidden");
      renderNotifList();
    }
  });
  document.getElementById("btn-notif-clear")?.addEventListener("click", () => {
    notifications.length = 0;
    updateNotifBadge();
    renderNotifList();
    document.getElementById("notif-panel")?.classList.add("hidden");
  });
  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".notif-wrapper")) {
      document.getElementById("notif-panel")?.classList.add("hidden");
    }
  });
}
