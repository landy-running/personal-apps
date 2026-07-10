import { averagePaceSecondsPerKilometer, formatPace } from "@personal/runos-core";
import { calculatePaceDemo, describePaceDemoResult } from "./paceDemo";
import { registerServiceWorker } from "./registerServiceWorker";
import {
  RUNOS_DEMO_SETTINGS_KEY,
  createRunosDemoSettings,
  createRunosStorageAdapter,
  describeRunosLoadResult,
  describeRunosSaveResult,
  isRunosDemoSettings,
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
        <dd>demo key: ${RUNOS_DEMO_SETTINGS_KEY}</dd>
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
        <button type="button" data-action="corrupt">破損JSONを注入して検知</button>
      </div>
      <pre id="storage-result" aria-live="polite">未実行。IndexedDBは未実装です。</pre>
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
const paceOutput = document.querySelector<HTMLPreElement>("#pace-result");
const paceDistanceInput = document.querySelector<HTMLInputElement>("#pace-distance");
const paceMinutesInput = document.querySelector<HTMLInputElement>("#pace-minutes");
const paceSecondsInput = document.querySelector<HTMLInputElement>("#pace-seconds");
const serviceWorkerStatus = document.querySelector<HTMLElement>("#sw-status");

function updateOutput(message: string): void {
  if (output) output.textContent = message;
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

document.querySelector<HTMLButtonElement>("[data-action='corrupt']")?.addEventListener("click", () => {
  if (!browserStorage) {
    updateOutput("localStorageへアクセスできないため、破損JSON注入は実行できません。");
    return;
  }

  writeRunosDemoCorruptJson(browserStorage);
  const result = storageAdapter.loadJson(RUNOS_DEMO_SETTINGS_KEY, isRunosDemoSettings);
  updateOutput(describeRunosLoadResult(result, storageAdapter.mode));
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
