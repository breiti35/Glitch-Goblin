// ── Search Spotlight ──
import { esc } from './utils.js';
import { state, switchView } from './app.js';
import { openDetailPanel } from './detail.js';
import { t } from './i18n.js';

/** Oeffnet das Search-Spotlight-Overlay und fokussiert das Eingabefeld. */
export function openSearchSpotlight() {
  const overlay = document.getElementById("search-overlay");
  if (overlay) {
    overlay.classList.remove("hidden");
    const input = document.getElementById("global-search-input");
    if (input) { input.value = ""; input.focus(); }
    document.getElementById("global-search-results")?.classList.add("hidden");
  }
}

/** Schliesst das Search-Spotlight-Overlay. */
export function closeSearchSpotlight() {
  document.getElementById("search-overlay")?.classList.add("hidden");
  document.getElementById("global-search-results")?.classList.add("hidden");
}

/** Fuehrt die globale Suche ueber Tickets und Settings-Keywords aus. */
export function globalSearch() {
  const input = document.getElementById("global-search-input");
  const query = (input?.value || "").toLowerCase().trim();

  let dropdown = document.getElementById("global-search-results");
  if (!dropdown) {
    dropdown = document.createElement("div");
    dropdown.id = "global-search-results";
    dropdown.className = "global-search-results hidden";
    input.parentElement.appendChild(dropdown);
  }

  if (!query || query.length < 2) {
    dropdown.classList.add("hidden");
    return;
  }

  const results = [];

  // Search tickets
  (state.board.tickets || []).forEach(tk => {
    if (tk.title.toLowerCase().includes(query) || (tk.description || "").toLowerCase().includes(query) || tk.id.toLowerCase().includes(query)) {
      results.push({ type: "ticket", icon: "\u{1F4CB}", label: `${tk.id} — ${tk.title}`, sub: tk.column, action: () => { switchView("board"); openDetailPanel(tk); } });
    }
  });

  // Search settings keywords
  const settingsKeywords = ["claude", "terminal", "deploy", "docker", "ssh", "backup", "theme", "accent", "bug-sync", "model", "shell"];
  settingsKeywords.forEach(kw => {
    if (kw.includes(query)) {
      results.push({ type: "settings", icon: "\u2699", label: `Settings: ${kw}`, sub: "", action: () => switchView("settings") });
    }
  });

  if (results.length === 0) {
    dropdown.innerHTML = `<div class="search-empty">${esc(t('search.noResults'))}</div>`;
  } else {
    dropdown.innerHTML = results.slice(0, 10).map((r, i) => `
      <div class="search-result-item" data-search-idx="${i}">
        <span class="search-icon">${r.icon}</span>
        <span class="search-label">${esc(r.label)}</span>
        <span class="search-sub">${esc(r.sub)}</span>
      </div>
    `).join("");

    dropdown.querySelectorAll(".search-result-item").forEach((el, i) => {
      el.addEventListener("click", () => {
        results[i].action();
        closeSearchSpotlight();
      });
    });
  }

  dropdown.classList.remove("hidden");
}
