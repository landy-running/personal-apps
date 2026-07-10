import { angleDiff } from "@personal/wanoku-core";
import { registerServiceWorker } from "./registerServiceWorker";
import {
  WANOKU_DEMO_CATCH_LOGS_KEY,
  WANOKU_DEMO_SETTINGS_KEY,
  addWanokuCatchLog,
  createWanokuDemoBackupFileName,
  createWanokuDemoBackupText,
  createWanokuDemoSettings,
  createWanokuIndexedDbAdapter,
  createWanokuStorageAdapter,
  deleteWanokuCatchLog,
  describeWanokuIndexedDbBackupExportResult,
  describeWanokuIndexedDbLoadResult,
  describeWanokuIndexedDbRestoreResult,
  describeWanokuIndexedDbSaveResult,
  describeWanokuLoadResult,
  describeWanokuRestoreResult,
  describeWanokuSaveResult,
  exportWanokuIndexedDbDemoBackupText,
  getWanokuCatchLogsOrEmpty,
  isWanokuDemoSettings,
  loadWanokuDemoFromIndexedDb,
  loadWanokuDemoBackupData,
  restoreWanokuIndexedDbDemoBackupText,
  restoreWanokuDemoBackupText,
  saveWanokuDemoToIndexedDb,
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
const indexedDbAdapter = createWanokuIndexedDbAdapter();
const todayIso = new Date().toISOString().slice(0, 10);

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
        <dd>demo keys: ${WANOKU_DEMO_SETTINGS_KEY}, ${WANOKU_DEMO_CATCH_LOGS_KEY}</dd>
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
      <pre id="storage-result" aria-live="polite">localStorage demoは未実行です。IndexedDBは下のopt-in demoから試せます。</pre>
      <h3>IndexedDB opt-in demo</h3>
      <p>
        既定保存先は変更せず、現在のdemo settings / catchLogsをIndexedDBへ手動コピーして確認します。
      </p>
      <div class="actions">
        <button type="button" data-action="idb-save">IndexedDBへ保存</button>
        <button type="button" data-action="idb-load">IndexedDBから読込</button>
        <button type="button" data-action="idb-export-backup">IndexedDBバックアップ書き出し</button>
        <label class="file-button">
          IndexedDBバックアップ読み込み
          <input id="idb-backup-import" class="backup-file-input" type="file" accept="application/json,.json" />
        </label>
      </div>
      <pre id="idb-result" aria-live="polite">未実行。保存先: IndexedDB opt-in demo / 件数: 未確認</pre>
    </section>
    <section class="demo-card" aria-labelledby="catch-log-heading">
      <h2 id="catch-log-heading">軽量釣果ログ</h2>
      <p>
        PWA demo keyだけに保存する軽量ログです。潮汐・スコアリング・外部API・legacy Storeキー群には接続していません。
      </p>
      <form id="catch-log-form" class="log-form">
        <div class="field-grid">
          <label>
            日付
            <input id="catch-date" type="date" value="${todayIso}" required />
          </label>
          <label>
            スポット名
            <input id="catch-spot" type="text" value="湾奥" maxlength="80" required />
          </label>
          <label>
            対象魚
            <input id="catch-target" type="text" value="シーバス" maxlength="40" required />
          </label>
          <label>
            結果
            <input id="catch-result" type="text" value="ノーフィッシュ" maxlength="80" required />
          </label>
          <label>
            ルアー
            <input id="catch-lure" type="text" maxlength="80" placeholder="例: ミノー" />
          </label>
        </div>
        <label>
          メモ
          <input id="catch-note" type="text" maxlength="160" placeholder="例: 下げ始めに反応" />
        </label>
        <div class="actions">
          <button type="submit">釣果ログを追加</button>
        </div>
      </form>
      <div id="catch-log-list" class="log-list" aria-live="polite"></div>
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
const indexedDbOutput = document.querySelector<HTMLPreElement>("#idb-result");
const windOutput = document.querySelector<HTMLPreElement>("#wind-result");
const windAngleAInput = document.querySelector<HTMLInputElement>("#wind-angle-a");
const windAngleBInput = document.querySelector<HTMLInputElement>("#wind-angle-b");
const serviceWorkerStatus = document.querySelector<HTMLElement>("#sw-status");
const backupImportInput = document.querySelector<HTMLInputElement>("#backup-import");
const indexedDbBackupImportInput = document.querySelector<HTMLInputElement>("#idb-backup-import");
const catchLogForm = document.querySelector<HTMLFormElement>("#catch-log-form");
const catchLogList = document.querySelector<HTMLDivElement>("#catch-log-list");
const catchDateInput = document.querySelector<HTMLInputElement>("#catch-date");
const catchSpotInput = document.querySelector<HTMLInputElement>("#catch-spot");
const catchTargetInput = document.querySelector<HTMLInputElement>("#catch-target");
const catchResultInput = document.querySelector<HTMLInputElement>("#catch-result");
const catchLureInput = document.querySelector<HTMLInputElement>("#catch-lure");
const catchNoteInput = document.querySelector<HTMLInputElement>("#catch-note");

function updateOutput(message: string): void {
  if (output) output.textContent = message;
}

function updateIndexedDbOutput(message: string): void {
  if (indexedDbOutput) indexedDbOutput.textContent = message;
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

document.querySelector<HTMLButtonElement>("[data-action='idb-save']")?.addEventListener("click", () => {
  saveWanokuDemoToIndexedDb(indexedDbAdapter, storageAdapter)
    .then((result) => {
      console.info("[wanoku-pwa] IndexedDB opt-in save result", result);
      updateIndexedDbOutput(describeWanokuIndexedDbSaveResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[wanoku-pwa] IndexedDB opt-in save failed", error);
      updateIndexedDbOutput("IndexedDBへの保存に失敗しました。consoleを確認してください。");
    });
});

document.querySelector<HTMLButtonElement>("[data-action='idb-load']")?.addEventListener("click", () => {
  loadWanokuDemoFromIndexedDb(indexedDbAdapter)
    .then((result) => {
      console.info("[wanoku-pwa] IndexedDB opt-in load result", result);
      updateIndexedDbOutput(describeWanokuIndexedDbLoadResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[wanoku-pwa] IndexedDB opt-in load failed", error);
      updateIndexedDbOutput("IndexedDBからの読込に失敗しました。consoleを確認してください。");
    });
});

document.querySelector<HTMLButtonElement>("[data-action='idb-export-backup']")?.addEventListener("click", () => {
  exportWanokuIndexedDbDemoBackupText(indexedDbAdapter)
    .then((result) => {
      if (result.status === "exported") {
        downloadTextFile(result.fileName, result.backupText);
      }
      updateIndexedDbOutput(describeWanokuIndexedDbBackupExportResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[wanoku-pwa] IndexedDB backup export failed", error);
      updateIndexedDbOutput("IndexedDBバックアップ書き出しに失敗しました。consoleを確認してください。");
    });
});

indexedDbBackupImportInput?.addEventListener("change", () => {
  const file = indexedDbBackupImportInput.files?.[0];
  if (!file) return;

  file
    .text()
    .then((text) => restoreWanokuIndexedDbDemoBackupText(indexedDbAdapter, text))
    .then((result) => {
      updateIndexedDbOutput(describeWanokuIndexedDbRestoreResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[wanoku-pwa] IndexedDB backup import failed", error);
      updateIndexedDbOutput("IndexedDBバックアップ読み込みに失敗しました。consoleを確認してください。");
    })
    .finally(() => {
      indexedDbBackupImportInput.value = "";
    });
});

document.querySelector<HTMLButtonElement>("[data-action='export-backup']")?.addEventListener("click", () => {
  const result = storageAdapter.loadJson(WANOKU_DEMO_SETTINGS_KEY, isWanokuDemoSettings);
  if (result.status !== "success") {
    updateOutput(`バックアップ書き出し不可: ${describeWanokuLoadResult(result, storageAdapter.mode)}`);
    return;
  }

  const backupText = createWanokuDemoBackupText(loadWanokuDemoBackupData(storageAdapter));
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
      if (result.status === "restored") {
        renderCatchLogs();
      }
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

catchLogForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const result = addWanokuCatchLog(storageAdapter, {
    date: catchDateInput?.value ?? "",
    spotName: catchSpotInput?.value ?? "",
    targetFish: catchTargetInput?.value ?? "",
    result: catchResultInput?.value ?? "",
    lure: catchLureInput?.value ?? "",
    note: catchNoteInput?.value ?? ""
  });

  if (!result.ok) {
    updateOutput(`釣果ログを保存できませんでした: ${result.message}`);
    return;
  }

  updateOutput(`釣果ログを保存しました: ${describeWanokuSaveResult(result.saveResult)}`);
  if (catchNoteInput) catchNoteInput.value = "";
  if (catchLureInput) catchLureInput.value = "";
  renderCatchLogs();
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
renderCatchLogs();

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

function renderCatchLogs(): void {
  if (!catchLogList) return;

  const logs = getWanokuCatchLogsOrEmpty(storageAdapter);
  catchLogList.replaceChildren();

  if (logs.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "釣果ログはまだありません。";
    catchLogList.append(empty);
    return;
  }

  for (const log of logs) {
    const item = document.createElement("article");
    item.className = "log-item";

    const title = document.createElement("h3");
    title.textContent = `${log.date} / ${log.spotName} / ${log.targetFish}`;

    const meta = document.createElement("p");
    meta.textContent = `結果: ${log.result}${log.lure ? ` / ルアー: ${log.lure}` : ""}`;

    const note = document.createElement("p");
    note.textContent = log.note || "メモなし";

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => {
      const result = deleteWanokuCatchLog(storageAdapter, log.id);
      updateOutput(`釣果ログを削除しました: ${describeWanokuSaveResult(result)}`);
      renderCatchLogs();
    });

    item.append(title, meta, note, deleteButton);
    catchLogList.append(item);
  }
}
