import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "../../..");
const sourceHtml = join(repoRoot, "runos", "RunOS v100 apex.html");
const publicDir = join(repoRoot, "apps", "runos-legacy-pwa", "public");
const outputDir = join(repoRoot, "dist", "runos-legacy-pwa");

const headInjection = `  <link rel="manifest" href="./manifest.webmanifest">
  <meta name="theme-color" content="#0b0e15">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="RunOS">
  <link rel="apple-touch-icon" href="./icons/icon.svg">
`;

const serviceWorkerInjection = `  <script>
    (() => {
      if (!("serviceWorker" in navigator)) return;
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js", { scope: "./" })
          .then((registration) => {
            console.info("[runos-legacy-pwa] Service Worker registered", registration.scope);
          })
          .catch((error) => {
            console.warn("[runos-legacy-pwa] Service Worker registration failed", error);
          });
      });
    })();
  </script>
`;

async function copyPublicFiles() {
  await mkdir(join(outputDir, "icons"), { recursive: true });
  await copyFile(join(publicDir, "manifest.webmanifest"), join(outputDir, "manifest.webmanifest"));
  await copyFile(join(publicDir, "sw.js"), join(outputDir, "sw.js"));
  await copyFile(join(publicDir, "icons", "icon.svg"), join(outputDir, "icons", "icon.svg"));
}

function injectPwaShell(html) {
  let output = html;

  if (!output.includes('rel="manifest"')) {
    output = output.replace("</head>", `${headInjection}</head>`);
  }

  if (!output.includes("[runos-legacy-pwa] Service Worker registered")) {
    output = output.replace("</body>", `${serviceWorkerInjection}</body>`);
  }

  return output;
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const source = await readFile(sourceHtml, "utf8");
const output = injectPwaShell(source);

await writeFile(join(outputDir, "index.html"), output, "utf8");
await copyPublicFiles();

console.log(`[runos-legacy-pwa] copied ${sourceHtml}`);
console.log(`[runos-legacy-pwa] wrote ${join(outputDir, "index.html")}`);
