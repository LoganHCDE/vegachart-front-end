/**
 * Browser-side R plotting via webR (WASM). Loaded dynamically from index.html.
 * Pin CDN build for stable behavior — see https://docs.r-wasm.org/webr/latest/downloading.html
 */
const WEBR_MJS = 'https://webr.r-wasm.org/v0.4.2/webr.mjs';

const FALLBACK_PKGS = [
  'ggplot2',
  'dplyr',
  'readr',
  'tidyr',
  'tibble',
  'purrr',
  'stringr',
  'forcats',
];

let webrModulePromise = null;
let webRInitPromise = null;
let packagesPromise = null;
/** Whether `tidyverse` meta-package failed and fallback CRAN wasm packages were installed instead. */
let installedViaFallback = false;

async function loadWebrModule() {
  if (!webrModulePromise) webrModulePromise = import(WEBR_MJS);
  return webrModulePromise;
}

export function resolveCanvasBgHex(imgBgChoice) {
  switch (imgBgChoice) {
    case 'transparent':
      return '#0a0a0a';
    case 'white':
      return '#f3f3f3';
    case 'blue':
      return '#0b1220';
    case 'default':
    default:
      return '#0a0a0a';
  }
}

function collectOutputMessages(output) {
  if (!Array.isArray(output)) return { text: '', hasError: false };
  const lines = [];
  let hasError = false;
  for (const item of output) {
    const t = item?.type;
    if (t === 'stderr' && typeof item.data === 'string') lines.push(item.data);
    if (t === 'message' && typeof item.data === 'string') lines.push(item.data);
    if (t === 'warning' && typeof item.data === 'string') lines.push(item.data);
    if (t === 'error') hasError = true;
  }
  return { text: lines.join('\n').trim(), hasError };
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode chart as PNG'))),
      'image/png'
    );
  });
}

/**
 * @param {(msg: string) => void} [onStatus]
 */
async function ensureWebR(onStatus) {
  if (!webRInitPromise) {
    webRInitPromise = (async () => {
      onStatus?.('Loading R runtime…');
      const { WebR } = await loadWebrModule();
      const webR = new WebR();
      await webR.init();
      return webR;
    })();
  }
  return webRInitPromise;
}

/**
 * Install tidyverse (or core packages if meta-package fails).
 * @param {(msg: string) => void} [onStatus]
 */
async function ensureTidyversePackages(webR, onStatus) {
  if (!packagesPromise) {
    packagesPromise = (async () => {
      onStatus?.('Installing tidyverse (first run may take a while)…');
      try {
        await webR.installPackages(['tidyverse']);
        installedViaFallback = false;
      } catch (e1) {
        console.warn('[webR] tidyverse install failed, installing core packages:', e1);
        onStatus?.('Installing core tidyverse packages…');
        try {
          await webR.installPackages(FALLBACK_PKGS);
          installedViaFallback = true;
        } catch (e2) {
          packagesPromise = null;
          throw e2;
        }
      }
    })();
  }
  await packagesPromise;
}

/**
 * Kick off webR.init() + package install in the background without UI hooks.
 * Uses the same promises as {@link runRCapture}; safe to call multiple times.
 */
export async function warmUpWebR() {
  try {
    const webR = await ensureWebR();
    await ensureTidyversePackages(webR);
  } catch (e) {
    console.warn('[webR] warmUpWebR failed:', e);
  }
}

/** Loads ggplot2 + core tidyverse wasm packages when meta-package `tidyverse` is unavailable. */
function libraryPreludeLine() {
  if (installedViaFallback) {
    return (
      'suppressPackageStartupMessages({' +
      ' library(ggplot2); library(dplyr); library(readr); library(tidyr); library(tibble);' +
      ' library(purrr); library(stringr); library(forcats)' +
      ' })'
    );
  }
  return 'suppressPackageStartupMessages(library(tidyverse))';
}

/**
 * Run user R code with optional CSV → df, capture ggplot/base plots.
 * @param {object} opts
 * @param {string} opts.code
 * @param {string | null} [opts.csvText]
 * @param {string} [opts.imageBgChoice]
 * @param {(msg: string) => void} [opts.onStatus]
 */
export async function runRCapture({ code, csvText, imageBgChoice, onStatus }) {
  const webR = await ensureWebR(onStatus);
  await ensureTidyversePackages(webR, onStatus);

  onStatus?.('Rendering chart…');

  if (csvText) {
    const enc = new TextEncoder();
    await webR.FS.writeFile('/home/web_user/vc_upload.csv', enc.encode(csvText));
  }

  const preludeParts = [libraryPreludeLine()];
  if (csvText) {
    preludeParts.push(
      'df <- readr::read_csv("/home/web_user/vc_upload.csv", show_col_types = FALSE)'
    );
  }
  const prelude = preludeParts.join('\n');
  const fullCode = `${prelude}\n\n${code}`;

  const mod = await loadWebrModule();
  const ShelterCtor = webR.Shelter ?? mod.Shelter;
  const shelter = await new ShelterCtor();
  const bg = resolveCanvasBgHex(imageBgChoice || 'default');
  const captureW = 960;
  const captureH = 720;

  try {
    const capture = await shelter.captureR(fullCode, {
      captureGraphics: {
        width: captureW,
        height: captureH,
        bg,
      },
    });

    const { text: stderrText, hasError: outputHasError } = collectOutputMessages(capture.output);

    const images = capture.images || [];
    const plotBitmap = images.length ? images[images.length - 1] : null;

    if (!plotBitmap) {
      const hint = stderrText || 'No graphics output was produced.';
      throw new Error(
        outputHasError ? hint || 'R reported an error while executing your code.' : hint
      );
    }

    const canvas = document.createElement('canvas');
    canvas.width = plotBitmap.width;
    canvas.height = plotBitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(plotBitmap, 0, 0);

    try {
      plotBitmap.close();
    } catch (_) {
      /* ignore */
    }

    for (let i = 0; i < images.length - 1; i++) {
      try {
        images[i].close();
      } catch (_) {
        /* ignore */
      }
    }

    const blob = await canvasToPngBlob(canvas);

    return {
      ok: true,
      canvas,
      blob,
      stderrText,
      outputHasError,
    };
  } finally {
    try {
      shelter.purge();
    } catch (_) {
      /* ignore */
    }
  }
}
