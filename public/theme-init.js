(() => {
  const root = document.documentElement;
  let savedTheme = null;

  try {
    savedTheme = localStorage.getItem("chuxue-theme");
  } catch {
    // The system preference is still available when storage is blocked.
  }

  const theme =
    savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.classList.add("has-js");

  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor.content = theme === "dark" ? "#111210" : "#f7f7f4";
})();
