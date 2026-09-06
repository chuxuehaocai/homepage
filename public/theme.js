const root = document.documentElement;
const toggle = document.querySelector("#theme-toggle");
const themeColor = document.querySelector('meta[name="theme-color"]');
const systemPreference = window.matchMedia("(prefers-color-scheme: dark)");
const storageKey = "chuxue-theme";

function readSavedTheme() {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function saveTheme(theme) {
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // The selected theme still applies for the current page view.
  }
}

function applyTheme(theme, persist = false) {
  const isDark = theme === "dark";

  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  themeColor.content = isDark ? "#111210" : "#f7f7f4";
  toggle.setAttribute("aria-label", isDark ? "切换到亮色模式" : "切换到暗色模式");
  toggle.title = isDark ? "切换到亮色模式" : "切换到暗色模式";

  if (persist) {
    saveTheme(theme);
  }
}

applyTheme(root.dataset.theme || (systemPreference.matches ? "dark" : "light"));

toggle.addEventListener("click", () => {
  applyTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
});

systemPreference.addEventListener("change", (event) => {
  if (!readSavedTheme()) {
    applyTheme(event.matches ? "dark" : "light");
  }
});
