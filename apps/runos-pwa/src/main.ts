import { averagePaceSecondsPerKilometer, formatPace } from "@personal/runos-core";
import { registerServiceWorker } from "./registerServiceWorker";

import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("RunOS PWA mount element was not found.");
}

const samplePace = averagePaceSecondsPerKilometer(10, 45 * 60);

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
        <dd>localStorage互換層は今後追加。IndexedDBは未実装です。</dd>
      </div>
    </dl>
  </section>
`;

registerServiceWorker();

