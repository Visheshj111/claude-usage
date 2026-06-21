(function () {
  try {
    const mode = localStorage.getItem("themeMode") || "auto";
    const isDark = mode === "dark" ||
      (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", isDark);
  } catch {
    // Keep page boot resilient if storage access is unavailable.
  }
})();
