(() => {
  "use strict";

  const STORAGE_KEY = "agent-commerce-theme";
  const THEMES = new Set(["light", "dark"]);
  const systemPreference = window.matchMedia?.("(prefers-color-scheme: dark)");
  const root = document.documentElement;
  const storedTheme = readStoredTheme();

  if (storedTheme) root.dataset.theme = storedTheme;
  updateThemeColor(resolvedTheme());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeThemeControls, {
      once: true,
    });
  } else {
    initializeThemeControls();
  }

  function initializeThemeControls() {
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.addEventListener("click", toggleTheme);
    }
    root.dataset.themeReady = "true";
    syncThemeControls();

    const handleSystemChange = () => {
      if (!root.hasAttribute("data-theme")) syncThemeControls();
    };
    if (systemPreference?.addEventListener) {
      systemPreference.addEventListener("change", handleSystemChange);
    } else {
      systemPreference?.addListener?.(handleSystemChange);
    }
  }

  function toggleTheme() {
    const nextTheme = resolvedTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = nextTheme;
    writeStoredTheme(nextTheme);
    syncThemeControls();
  }

  function syncThemeControls() {
    const theme = resolvedTheme();
    const nextTheme = theme === "dark" ? "light" : "dark";
    updateThemeColor(theme);

    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.dataset.currentTheme = theme;
      button.setAttribute("aria-pressed", String(theme === "dark"));
      button.setAttribute(
        "aria-label",
        `Color theme: ${theme}. Switch to ${nextTheme} mode.`,
      );
      button.title = `Switch to ${nextTheme} mode`;
      const label = button.querySelector("[data-theme-label]");
      if (label) label.textContent = `${capitalize(theme)} mode`;
    }
  }

  function resolvedTheme() {
    if (THEMES.has(root.dataset.theme)) return root.dataset.theme;
    return systemPreference?.matches ? "dark" : "light";
  }

  function readStoredTheme() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return THEMES.has(value) ? value : null;
    } catch {
      return null;
    }
  }

  function writeStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // The selected theme still applies for this page when storage is blocked.
    }
  }

  function updateThemeColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#0b100e" : "#f4f1e8";
  }

  function capitalize(value) {
    return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  }
})();
