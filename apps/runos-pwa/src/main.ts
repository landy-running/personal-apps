import { averagePaceSecondsPerKilometer, formatPace } from "@personal/runos-core";
import { calculatePaceDemo, describePaceDemoResult } from "./paceDemo";
import { registerServiceWorker } from "./registerServiceWorker";
import {
  RUNOS_DEMO_SETTINGS_KEY,
  RUNOS_DEMO_RUN_LOGS_KEY,
  addRunosRunLog,
  createRunosDemoBackupFileName,
  createRunosDemoBackupText,
  createRunosDemoSettings,
  createRunosIndexedDbAdapter,
  createRunosStorageAdapter,
  deleteRunosRunLog,
  describeRunosIndexedDbBackupExportResult,
  describeRunosIndexedDbLoadResult,
  describeRunosIndexedDbRestoreResult,
  describeRunosIndexedDbSaveResult,
  describeRunosLoadResult,
  describeRunosRestoreResult,
  describeRunosSaveResult,
  exportRunosIndexedDbDemoBackupText,
  getRunosRunLogsOrEmpty,
  isRunosDemoSettings,
  loadRunosDemoFromIndexedDb,
  loadRunosDemoBackupData,
  restoreRunosIndexedDbDemoBackupText,
  restoreRunosDemoBackupText,
  saveRunosDemoToIndexedDb,
  writeRunosDemoCorruptJson
} from "./storageDemo";

import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("RunOS PWA mount element was not found.");
}

const samplePace = averagePaceSecondsPerKilometer(10, 45 * 60);
const browserStorage = getBrowserLocalStorage();
const storageAdapter = createRunosStorageAdapter(browserStorage);
const indexedDbAdapter = createRunosIndexedDbAdapter();
const todayIso = new Date().toISOString().slice(0, 10);

app.innerHTML = `
  <section class="shell">
    <p class="eyebrow">RunOS PWA foundation</p>
    <h1>RunOS PWA</h1>
    <p>
      legacy HTMLを置き換えず、Vite + TypeScriptで小さく育てるための最小シェルです。
    </p>
    <dl>
      <div>
        <dt>Sample pace</dt>
        <dd>${formatPace(samplePace)}</dd>
      </div>
      <div>
        <dt>Storage</dt>
        <dd>demo keys: ${RUNOS_DEMO_SETTINGS_KEY}, ${RUNOS_DEMO_RUN_LOGS_KEY}</dd>
      </div>
      <div>
        <dt>Service Worker</dt>
        <dd id="sw-status">確認中...</dd>
      </div>
    </dl>
    <section class="demo-card" aria-labelledby="storage-demo-heading">
      <h2 id="storage-demo-heading">保存デモ</h2>
      <p>
        PWA側の保存表示準備です。legacyの <code>meridian.v1</code> には接続していません。
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
        既定保存先は変更せず、現在のdemo settings / runLogsをIndexedDBへ手動コピーして確認します。
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
    <section class="demo-card" aria-labelledby="run-log-heading">
      <h2 id="run-log-heading">軽量ラン記録</h2>
      <p>
        PWA demo keyだけに保存する軽量ログです。FIT解析やlegacyの <code>meridian.v1</code> には接続していません。
      </p>
      <form id="run-log-form" class="log-form">
        <div class="field-grid">
          <label>
            日付
            <input id="run-date" type="date" value="${todayIso}" required />
          </label>
          <label>
            距離 km
            <input id="run-distance" type="number" min="0.01" step="0.01" value="5" inputmode="decimal" required />
          </label>
          <label>
            時間 分
            <input id="run-minutes" type="number" min="0" step="1" value="30" inputmode="numeric" required />
          </label>
          <label>
            時間 秒
            <input id="run-seconds" type="number" min="0" step="1" value="0" inputmode="numeric" required />
          </label>
          <label>
            痛み 0-10 任意
            <input id="run-pain" type="number" min="0" max="10" step="1" inputmode="numeric" />
          </label>
        </div>
        <label>
          メモ
          <input id="run-note" type="text" maxlength="120" placeholder="例: easy jog" />
        </label>
        <div class="actions">
          <button type="submit">ラン記録を追加</button>
        </div>
      </form>
      <div id="run-log-list" class="log-list" aria-live="polite"></div>
    </section>
    <section class="demo-card" aria-labelledby="pace-demo-heading">
      <h2 id="pace-demo-heading">ペース計算デモ</h2>
      <p>
        <code>runos-core</code> のpace utilityだけを使った確認デモです。RunOS実データには接続していません。
      </p>
      <div class="field-grid">
        <label>
          距離 km
          <input id="pace-distance" type="number" min="0.01" step="0.01" value="10" inputmode="decimal" />
        </label>
        <label>
          時間 分
          <input id="pace-minutes" type="number" min="0" step="1" value="45" inputmode="numeric" />
        </label>
        <label>
          時間 秒
          <input id="pace-seconds" type="number" min="0" step="1" value="0" inputmode="numeric" />
        </label>
      </div>
      <pre id="pace-result" aria-live="polite">平均ペース: ${formatPace(samplePace)}</pre>
    </section>
  </section>
`;

const output = document.querySelector<HTMLPreElement>("#storage-result");
const indexedDbOutput = document.querySelector<HTMLPreElement>("#idb-result");
const paceOutput = document.querySelector<HTMLPreElement>("#pace-result");
const paceDistanceInput = document.querySelector<HTMLInputElement>("#pace-distance");
const paceMinutesInput = document.querySelector<HTMLInputElement>("#pace-minutes");
const paceSecondsInput = document.querySelector<HTMLInputElement>("#pace-seconds");
const serviceWorkerStatus = document.querySelector<HTMLElement>("#sw-status");
const backupImportInput = document.querySelector<HTMLInputElement>("#backup-import");
const indexedDbBackupImportInput = document.querySelector<HTMLInputElement>("#idb-backup-import");
const runLogForm = document.querySelector<HTMLFormElement>("#run-log-form");
const runLogList = document.querySelector<HTMLDivElement>("#run-log-list");
const runDateInput = document.querySelector<HTMLInputElement>("#run-date");
const runDistanceInput = document.querySelector<HTMLInputElement>("#run-distance");
const runMinutesInput = document.querySelector<HTMLInputElement>("#run-minutes");
const runSecondsInput = document.querySelector<HTMLInputElement>("#run-seconds");
const runPainInput = document.querySelector<HTMLInputElement>("#run-pain");
const runNoteInput = document.querySelector<HTMLInputElement>("#run-note");

function updateOutput(message: string): void {
  if (output) output.textContent = message;
}

function updateIndexedDbOutput(message: string): void {
  if (indexedDbOutput) indexedDbOutput.textContent = message;
}

document.querySelector<HTMLButtonElement>("[data-action='save']")?.addEventListener("click", () => {
  const prepared = storageAdapter.prepareJson(createRunosDemoSettings());
  if (prepared.ok) {
    console.info("[runos-pwa] save size estimate", { key: RUNOS_DEMO_SETTINGS_KEY, bytes: prepared.bytes });
  }

  const result = storageAdapter.saveJson(RUNOS_DEMO_SETTINGS_KEY, createRunosDemoSettings());
  updateOutput(describeRunosSaveResult(result));
});

document.querySelector<HTMLButtonElement>("[data-action='load']")?.addEventListener("click", () => {
  const result = storageAdapter.loadJson(RUNOS_DEMO_SETTINGS_KEY, isRunosDemoSettings);
  updateOutput(describeRunosLoadResult(result, storageAdapter.mode));
});

document.querySelector<HTMLButtonElement>("[data-action='idb-save']")?.addEventListener("click", () => {
  saveRunosDemoToIndexedDb(indexedDbAdapter, storageAdapter)
    .then((result) => {
      console.info("[runos-pwa] IndexedDB opt-in save result", result);
      updateIndexedDbOutput(describeRunosIndexedDbSaveResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[runos-pwa] IndexedDB opt-in save failed", error);
      updateIndexedDbOutput("IndexedDBへの保存に失敗しました。consoleを確認してください。");
    });
});

document.querySelector<HTMLButtonElement>("[data-action='idb-load']")?.addEventListener("click", () => {
  loadRunosDemoFromIndexedDb(indexedDbAdapter)
    .then((result) => {
      console.info("[runos-pwa] IndexedDB opt-in load result", result);
      updateIndexedDbOutput(describeRunosIndexedDbLoadResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[runos-pwa] IndexedDB opt-in load failed", error);
      updateIndexedDbOutput("IndexedDBからの読込に失敗しました。consoleを確認してください。");
    });
});

document.querySelector<HTMLButtonElement>("[data-action='idb-export-backup']")?.addEventListener("click", () => {
  exportRunosIndexedDbDemoBackupText(indexedDbAdapter)
    .then((result) => {
      if (result.status === "exported") {
        downloadTextFile(result.fileName, result.backupText);
      }
      updateIndexedDbOutput(describeRunosIndexedDbBackupExportResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[runos-pwa] IndexedDB backup export failed", error);
      updateIndexedDbOutput("IndexedDBバックアップ書き出しに失敗しました。consoleを確認してください。");
    });
});

indexedDbBackupImportInput?.addEventListener("change", () => {
  const file = indexedDbBackupImportInput.files?.[0];
  if (!file) return;

  file
    .text()
    .then((text) => restoreRunosIndexedDbDemoBackupText(indexedDbAdapter, text))
    .then((result) => {
      updateIndexedDbOutput(describeRunosIndexedDbRestoreResult(result));
    })
    .catch((error: unknown) => {
      console.warn("[runos-pwa] IndexedDB backup import failed", error);
      updateIndexedDbOutput("IndexedDBバックアップ読み込みに失敗しました。consoleを確認してください。");
    })
    .finally(() => {
      indexedDbBackupImportInput.value = "";
    });
});

document.querySelector<HTMLButtonElement>("[data-action='export-backup']")?.addEventListener("click", () => {
  const result = storageAdapter.loadJson(RUNOS_DEMO_SETTINGS_KEY, isRunosDemoSettings);
  if (result.status !== "success") {
    updateOutput(`バックアップ書き出し不可: ${describeRunosLoadResult(result, storageAdapter.mode)}`);
    return;
  }

  const backupText = createRunosDemoBackupText(loadRunosDemoBackupData(storageAdapter));
  const fileName = createRunosDemoBackupFileName();
  downloadTextFile(fileName, backupText);
  updateOutput(`バックアップを書き出しました: ${fileName}`);
});

backupImportInput?.addEventListener("change", () => {
  const file = backupImportInput.files?.[0];
  if (!file) return;

  file
    .text()
    .then((text) => {
      const result = restoreRunosDemoBackupText(storageAdapter, text);
      updateOutput(describeRunosRestoreResult(result));
      if (result.status === "restored") {
        renderRunLogs();
      }
    })
    .catch((error: unknown) => {
      console.warn("[runos-pwa] backup import failed", error);
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

  writeRunosDemoCorruptJson(browserStorage);
  const result = storageAdapter.loadJson(RUNOS_DEMO_SETTINGS_KEY, isRunosDemoSettings);
  updateOutput(describeRunosLoadResult(result, storageAdapter.mode));
});

runLogForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const durationSec = Number(runMinutesInput?.value) * 60 + Number(runSecondsInput?.value);
  const painValue = runPainInput?.value.trim();
  const result = addRunosRunLog(storageAdapter, {
    date: runDateInput?.value ?? "",
    distanceKm: Number(runDistanceInput?.value),
    durationSec,
    note: runNoteInput?.value ?? "",
    painLevel: painValue ? Number(painValue) : undefined
  });

  if (!result.ok) {
    updateOutput(`ラン記録を保存できませんでした: ${result.message}`);
    return;
  }

  updateOutput(`ラン記録を保存しました: ${describeRunosSaveResult(result.saveResult)}`);
  if (runNoteInput) runNoteInput.value = "";
  if (runPainInput) runPainInput.value = "";
  renderRunLogs();
});

function updatePaceDemo(): void {
  const result = calculatePaceDemo({
    distanceKilometers: Number(paceDistanceInput?.value),
    elapsedMinutes: Number(paceMinutesInput?.value),
    elapsedSeconds: Number(paceSecondsInput?.value)
  });

  if (paceOutput) {
    paceOutput.textContent = describePaceDemoResult(result);
  }
}

paceDistanceInput?.addEventListener("input", updatePaceDemo);
paceMinutesInput?.addEventListener("input", updatePaceDemo);
paceSecondsInput?.addEventListener("input", updatePaceDemo);
updatePaceDemo();
renderRunLogs();

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
    console.warn("[runos-pwa] localStorage is unavailable", error);
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

function renderRunLogs(): void {
  if (!runLogList) return;

  const logs = getRunosRunLogsOrEmpty(storageAdapter);
  runLogList.replaceChildren();

  if (logs.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "ラン記録はまだありません。";
    runLogList.append(empty);
    return;
  }

  for (const log of logs) {
    const item = document.createElement("article");
    item.className = "log-item";

    const title = document.createElement("h3");
    title.textContent = `${log.date} / ${log.distanceKm}km / ${formatPace(log.avgPace)}`;

    const meta = document.createElement("p");
    meta.textContent = `時間: ${log.durationSec}秒${log.painLevel === undefined ? "" : ` / 痛み: ${log.painLevel}`}`;

    const note = document.createElement("p");
    note.textContent = log.note || "メモなし";

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => {
      const result = deleteRunosRunLog(storageAdapter, log.id);
      updateOutput(`ラン記録を削除しました: ${describeRunosSaveResult(result)}`);
      renderRunLogs();
    });

    item.append(title, meta, note, deleteButton);
    runLogList.append(item);
  }
}
