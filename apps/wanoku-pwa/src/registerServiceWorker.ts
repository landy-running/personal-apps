export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) {
    console.warn("[wanoku-pwa] service worker is not supported in this browser");
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then((registration) => {
        console.info("[wanoku-pwa] service worker registered", registration.scope);
      })
      .catch((error: unknown) => {
        console.warn("[wanoku-pwa] service worker registration failed", error);
      });
  });
}

