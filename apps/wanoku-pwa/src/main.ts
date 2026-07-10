import { angleDiff } from "@personal/wanoku-core";
import { registerServiceWorker } from "./registerServiceWorker";
import {
  WANOKU_DEMO_SETTINGS_KEY,
  createWanokuDemoBackupFileName,
  createWanokuDemoBackupText,
  createWanokuDemoSettings,
  createWanokuStorageAdapter,
  describeWanokuLoadResult,
  describeWanokuRestoreResult,
  describeWanokuSaveResult,
  isWanokuDemoSettings,
  restoreWanokuDemoBackupText,
  writeWanokuDemoCorruptJson
} from "./storageDemo";
import { calculateWindDemo, describeWindDemoResult } from "./windDemo";

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
      <div>
        <dt>Service Worker</dt>
        <dd id="sw-status">確認中...</dd>
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
        <button type="button" data-action="export-backup">バックアップ書き出し</button>
        <label class="file-button">
          バックアップ読み込み
          <input id="backup-import" class="backup-file-input" type="file" accept="application/json,.json" />
        </label>
        <button type="button" data-action="corrupt">破損JSONを注入して検知</button>
      </div>
      <pre id="storage-result" aria-live="polite">未実行。IndexedDBは未実装です。</pre>
    </section>
    <section class="demo-card" aria-labelledby="wind-demo-heading">
      <h2 id="wind-demo-heading">風向差デモ</h2>
      <p>
        <code>wanoku-core</code> の <code>angleDiff</code> だけを使った確認デモです。潮汐・スコアリングには接続していません。
      </p>
      <div class="field-grid">
        <label>
          角度A / スポット向き
          <input id="wind-angle-a" type="number" step="1" value="350" inputmode="numeric" />
        </label>
        <label>
          角度B / 風向
          <input id="wind-angle-b" type="number" step="1" value="10" inputmode="numeric" />
        </label>
      </div>
      <pre id="wind-result" aria-live="polite">風向差: ${angleDiff(350, 10)}°</pre>
    </section>
  </section>
`;

const output = document.querySelector<HTMLPreElement>("#storage-result");
const windOutput = document.querySelector<HTMLPreElement>("#wind-result");
const windAngleAInput = document.querySelector<HTMLInputElement>("#wind-angle-a");
const windAngleBInput = document.querySelector<HTMLInputElement>("#wind-angle-b");
const serviceWorkerStatus = document.querySelector<HTMLElement>("#sw-status");
const backupImportInput = document.querySelector<HTMLInputElement>("#backup-import");

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

document.querySelector<HTMLButtonElement>("[data-action='export-backup']")?.addEventListener("click", () => {
  const result = storageAdapter.loadJson(WANOKU_DEMO_SETTINGS_KEY, isWanokuDemoSettings);
  if (result.status !== "success") {
    updateOutput(`バックアップ書き出し不可: ${describeWanokuLoadResult(result, storageAdapter.mode)}`);
    return;
  }

  const backupText = createWanokuDemoBackupText(result.value);
  const fileName = createWanokuDemoBackupFileName();
  downloadTextFile(fileName, backupText);
  updateOutput(`バックアップを書き出しました: ${fileName}`);
});

backupImportInput?.addEventListener("change", () => {
  const file = backupImportInput.files?.[0];
  if (!file) return;

  file
    .text()
    .then((text) => {
      const result = restoreWanokuDemoBackupText(storageAdapter, text);
      updateOutput(describeWanokuRestoreResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[wanoku-pwa] backup import failed", error);
      updateOutput("バックアップ読み込みに失敗しました。consoleを確認してください。");
    })
    .finally(() => {
      backupImportInput.value = "";
    });
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

function updateWindDemo(): void {
  const result = calculateWindDemo(Number(windAngleAInput?.value), Number(windAngleBInput?.value));

  if (windOutput) {
    windOutput.textContent = describeWindDemoResult(result);
  }
}

windAngleAInput?.addEventListener("input", updateWindDemo);
windAngleBInput?.addEventListener("input", updateWindDemo);
updateWindDemo();

registerServiceWorker((status) => {
  if (serviceWorkerStatus) {
    serviceWorkerStatus.textContent = status.message;
    serviceWorkerStatus.dataset.state = status.state;
  }
});

function getBrowserLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn("[wanoku-pwa] localStorage is unavailable", error);
    return undefined;
  }
}

function downloadTextFile(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
