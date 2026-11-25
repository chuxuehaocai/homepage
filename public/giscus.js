(() => {
  const mount = document.querySelector("[data-giscus]");
  if (!mount) return;

  const origin = "https://giscus.app";
  const isDark = () => document.documentElement.dataset.theme === "dark";
  const themeName = (dark) => (dark ? "dark" : "light");
  const categoryId = mount.dataset.categoryId;

  if (!categoryId) {
    mount.innerHTML = '<p class="comments-setup">评论区还没启用：给仓库安装 giscus App，' +
      '然后重新构建（或提供 <code>GISCUS_CATEGORY_ID</code>）。</p>';
    return;
  }

  const script = document.createElement("script");
  script.src = origin + "/client.js";
  script.async = true;
  script.crossOrigin = "anonymous";

  const attributes = {
    repo: mount.dataset.repo,
    repoId: mount.dataset.repoId,
    category: mount.dataset.category,
    categoryId,
    mapping: mount.dataset.mapping || "pathname",
    strict: mount.dataset.strict || "0",
    reactionsEnabled: mount.dataset.reactionsEnabled || "1",
    emitMetadata: "0",
    inputPosition: mount.dataset.inputPosition || "top",
    theme: themeName(isDark()),
    lang: mount.dataset.lang || "zh-CN",
    loading: "lazy",
  };

  for (const [key, value] of Object.entries(attributes)) {
    if (value) script.dataset[key] = value;
  }

  mount.appendChild(script);

  // 跟随站点的亮暗切换：giscus 只接受 postMessage 更新主题。
  const syncTheme = () => {
    const frame = document.querySelector("iframe.giscus-frame");
    if (!frame || !frame.contentWindow) return;

    frame.contentWindow.postMessage(
      { giscus: { setConfig: { theme: themeName(isDark()) } } },
      origin,
    );
  };

  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  // iframe 是异步插入的，插入后再对齐一次，避免首屏主题和站点不一致。
  new MutationObserver(() => {
    const frame = document.querySelector("iframe.giscus-frame");
    if (frame) {
      frame.addEventListener("load", syncTheme, { once: true });
      syncTheme();
    }
  }).observe(mount, { childList: true });
})();
