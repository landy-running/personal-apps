import { angleDiff } from "@personal/wanoku-core";
import { registerServiceWorker } from "./registerServiceWorker";

import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("wanoku-navi PWA mount element was not found.");
}

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
        <dd>Store互換層は今後追加。IndexedDBは未実装です。</dd>
      </div>
    </dl>
  </section>
`;

registerServiceWorker();

