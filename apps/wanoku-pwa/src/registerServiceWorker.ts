export type ServiceWorkerStatus = {
  supported: boolean;
  state: "unsupported" | "dev-skipped" | "registering" | "registered" | "failed";
  message: string;
};

export type ServiceWorkerStatusHandler = (status: ServiceWorkerStatus) => void;

export function registerServiceWorker(onStatus?: ServiceWorkerStatusHandler): void {
  if (!("serviceWorker" in navigator)) {
    const status = {
      supported: false,
      state: "unsupported",
      message: "Service Worker未対応のブラウザです。"
    } satisfies ServiceWorkerStatus;
    onStatus?.(status);
    console.warn("[wanoku-pwa] service worker is not supported in this browser");
    return;
  }

  onStatus?.({
    supported: true,
    state: "registering",
    message: "Service Worker対応ブラウザです。登録準備中です。"
  });

  if (import.meta.env.DEV) {
    const scopeUrl = new URL("./", window.location.href).href;
    onStatus?.({
      supported: true,
      state: "dev-skipped",
      message: "Service Worker対応。開発環境では過剰キャッシュ防止のため登録をスキップします。"
    });
    console.info("[wanoku-pwa] service worker registration skipped in development");
    navigator.serviceWorker
      .getRegistration(scopeUrl)
      .then((registration) => {
        if (!registration) return;
        return registration.unregister().then((removed) => {
          console.info("[wanoku-pwa] stale development service worker unregistered", removed);
        });
      })
      .catch((error: unknown) => {
        console.warn("[wanoku-pwa] stale service worker cleanup failed", error);
      });
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then((registration) => {
        onStatus?.({
          supported: true,
          state: "registered",
          message: `Service Worker登録成功: ${registration.scope}`
        });
        console.info("[wanoku-pwa] service worker registered", registration.scope);
      })
      .catch((error: unknown) => {
        onStatus?.({
          supported: true,
          state: "failed",
          message: "Service Worker登録失敗。consoleを確認してください。"
        });
        console.warn("[wanoku-pwa] service worker registration failed", error);
      });
  });
}
