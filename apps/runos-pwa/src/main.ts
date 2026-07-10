import { averagePaceSecondsPerKilometer, formatPace } from "@personal/runos-core";
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
  </section>
`;

const output = document.querySelector<HTMLPreElement>("#storage-result");

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

registerServiceWorker();

function getBrowserLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn("[runos-pwa] localStorage is unavailable", error);
    return undefined;
  }
}
