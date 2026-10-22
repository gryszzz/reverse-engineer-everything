// Loaded as /theme.js. The studio content-security policy blocks inline scripts.
try {
  const stored = localStorage.getItem("ree-studio-theme");
  const theme =
    stored === "light" || stored === "dark"
      ? stored
      : matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  document.documentElement.dataset.theme = theme;
} catch {
  document.documentElement.dataset.theme = "dark";
}
