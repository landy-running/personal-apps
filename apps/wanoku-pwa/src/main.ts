import { angleDiff } from "@personal/wanoku-core";
import { registerServiceWorker } from "./registerServiceWorker";
import {
  WANOKU_DEMO_SETTINGS_KEY,
  createWanokuDemoSettings,
  createWanokuStorageAdapter,
  describeWanokuLoadResult,
  describeWanokuSaveResult,
  isWanokuDemoSettings,
  writeWanokuDemoCorruptJson
} from "./storageDemo";

import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("wanoku-navi PWA mount element was not found.");
}

const browserStorage = getBrowserLocalStorage();
const storageAdapter = createWanokuStorageAdapter(browserStorage);

app.innerHTML = `
  <section class="shell">
    <p class="eyebrow">wanoku-navi PWA foundation</p>
    <h1>湾奥ナビ PWA</h1>
    <p>
      legacy HTMLを置き換えず、Vite + TypeScriptで小さく育てるための最小シェルです。
    </p>
    <dl>
      <div>
        <dt>Sample wind angle diff</dt>
        <dd>${angleDiff(350, 10)}°</dd>
      </div>
      <div>
        <dt>Storage</dt>
        <dd>demo key: ${WANOKU_DEMO_SETTINGS_KEY}</dd>
      </div>
    </dl>
    <section class="demo-card" aria-labelledby="storage-demo-heading">
      <h2 id="storage-demo-heading">保存デモ</h2>
      <p>
        PWA側の保存表示準備です。legacyのwanoku Storeキー群には接続していません。
      </p>
      <div class="actions">
        <button type="button" data-action="save">設定を保存</button>
        <button type="button" data-action="load">読込確認</button>
        <button type="button" data-action="corrupt">破損JSONを注入して検知</button>
      </div>
      <pre id="storage-result" aria-live="polite">未実行。IndexedDBは未実装です。</pre>
    </section>
  </section>
`;

const output = document.querySelector<HTMLPreElement>("#storage-result");

function updateOutput(message: string): void {
  if (output) output.textContent = message;
}

document.querySelector<HTMLButtonElement>("[data-action='save']")?.addEventListener("click", () => {
  const prepared = storageAdapter.prepareJson(createWanokuDemoSettings());
  if (prepared.ok) {
    console.info("[wanoku-pwa] save size estimate", { key: WANOKU_DEMO_SETTINGS_KEY, bytes: prepared.bytes });
  }

  const result = storageAdapter.saveJson(WANOKU_DEMO_SETTINGS_KEY, createWanokuDemoSettings());
  updateOutput(describeWanokuSaveResult(result));
});

document.querySelector<HTMLButtonElement>("[data-action='load']")?.addEventListener("click", () => {
  const result = storageAdapter.loadJson(WANOKU_DEMO_SETTINGS_KEY, isWanokuDemoSettings);
  updateOutput(describeWanokuLoadResult(result, storageAdapter.mode));
});

document.querySelector<HTMLButtonElement>("[data-action='corrupt']")?.addEventListener("click", () => {
  if (!browserStorage) {
    updateOutput("localStorageへアクセスできないため、破損JSON注入は実行できません。");
    return;
  }

  writeWanokuDemoCorruptJson(browserStorage);
  const result = storageAdapter.loadJson(WANOKU_DEMO_SETTINGS_KEY, isWanokuDemoSettings);
  updateOutput(describeWanokuLoadResult(result, storageAdapter.mode));
});

registerServiceWorker();

function getBrowserLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn("[wanoku-pwa] localStorage is unavailable", error);
    return undefined;
  }
}
