export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) {
    console.warn("[runos-pwa] service worker is not supported in this browser");
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then((registration) => {
        console.info("[runos-pwa] service worker registered", registration.scope);
      })
      .catch((error: unknown) => {
        console.warn("[runos-pwa] service worker registration failed", error);
      });
  });
}

