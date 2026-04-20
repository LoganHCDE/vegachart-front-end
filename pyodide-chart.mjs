/**
 * Browser-side Python plotting via Pyodide (WASM). Loaded dynamically from index.html.
 * Pin CDN build — https://pyodide.org/en/stable/usage/downloading-and-deploying.html
 */
const PYODIDE_VERSION = '0.27.7';
const PYODIDE_MJS = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`;

const CORE_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy'];

let pyodideModulePromise = null;
let pyodideInitPromise = null;
let packagesPromise = null;

async function loadPyodideModule() {
  if (!pyodideModulePromise) pyodideModulePromise = import(PYODIDE_MJS);
  return pyodideModulePromise;
}

/**
 * @param {string} name
 */
function safeBasename(name) {
  if (!name || typeof name !== 'string') return 'your_data.csv';
  const base = name.replace(/^.*[/\\]/, '').replace(/\0/g, '');
  return base || 'your_data.csv';
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
async function ensurePyodide(onStatus) {
  if (!pyodideInitPromise) {
    pyodideInitPromise = (async () => {
      onStatus?.('Loading Python runtime…');
      const { loadPyodide } = await loadPyodideModule();
      const pyodide = await loadPyodide({
        indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
      });
      return pyodide;
    })();
  }
  return pyodideInitPromise;
}

/**
 * Load matplotlib stack + seaborn (via micropip).
 * @param {*} pyodide
 * @param {(msg: string) => void} [onStatus]
 */
async function ensurePythonPlotPackages(pyodide, onStatus) {
  if (!packagesPromise) {
    packagesPromise = (async () => {
      onStatus?.('Loading NumPy, Pandas, Matplotlib, SciPy (first run may take a while)…');
      await pyodide.loadPackage('micropip');
      await pyodide.loadPackage(CORE_PACKAGES);
      onStatus?.('Installing Seaborn…');
      await pyodide.runPythonAsync(`
import micropip
await micropip.install(['seaborn'])
`);
    })();
    packagesPromise = packagesPromise.catch((e) => {
      packagesPromise = null;
      throw e;
    });
  }
  await packagesPromise;
}

/**
 * Kick off Pyodide init + packages in the background.
 */
export async function warmUpPyodide() {
  try {
    const pyodide = await ensurePyodide();
    await ensurePythonPlotPackages(pyodide);
  } catch (e) {
    console.warn('[Pyodide] warmUpPyodide failed:', e);
  }
}

const VC_PNG_PATH = '/vc_chart.png';

/**
 * Run user Python (Seaborn/matplotlib) code; optional CSV written to MEMFS for pd.read_csv.
 * Prepends Agg backend; appends PNG capture (replaces plt.show()).
 *
 * @param {object} opts
 * @param {string} opts.code
 * @param {string | null} [opts.csvText]
 * @param {string} [opts.suggestedFilename] basename for MEMFS upload (matches generated read_csv)
 * @param {(msg: string) => void} [opts.onStatus]
 */
export async function runPythonCapture({
  code,
  csvText,
  suggestedFilename,
  onStatus,
}) {
  const pyodide = await ensurePyodide(onStatus);
  await ensurePythonPlotPackages(pyodide, onStatus);

  const basename = safeBasename(suggestedFilename || 'your_data.csv');
  const cwd = '/home/pyodide';
  const uploadPath = `${cwd}/${basename}`;

  if (csvText) {
    const enc = new TextEncoder();
    try {
      pyodide.FS.unlink(uploadPath);
    } catch (_) {
      /* ignore */
    }
    pyodide.FS.writeFile(uploadPath, enc.encode(csvText));
  }

  try {
    pyodide.FS.unlink(VC_PNG_PATH);
  } catch (_) {
    /* ignore */
  }

  const stderrLines = [];

  const prelude = `import matplotlib\nmatplotlib.use("AGG")\n`;
  const body = String(code || '').replace(/\bplt\.show\s*\(\s*\)/g, '# plt.show()');
  const postlude = `
import io
import matplotlib.pyplot as plt
_buf = io.BytesIO()
_fig = plt.gcf()
_fig.savefig(_buf, format='png', bbox_inches='tight', facecolor=_fig.get_facecolor())
with open('${VC_PNG_PATH}', 'wb') as _vc_f:
    _vc_f.write(_buf.getvalue())
`;

  const fullCode = `${prelude}${body}\n${postlude}`;

  onStatus?.('Rendering chart…');

  try {
    pyodide.setStderr({
      batched: (s) => {
        if (typeof s === 'string' && s) stderrLines.push(s);
      },
    });
    await pyodide.runPythonAsync(fullCode);
  } catch (e) {
    const pyErr = e && e.message ? String(e.message) : String(e);
    const errText = [stderrLines.join('\n').trim(), pyErr].filter(Boolean).join('\n\n');
    throw new Error(errText || 'Python reported an error while executing your code.');
  } finally {
    try {
      pyodide.setStderr(undefined);
    } catch (_) {
      /* ignore */
    }
  }

  let pngData;
  try {
    pngData = pyodide.FS.readFile(VC_PNG_PATH);
  } catch (_) {
    const hint = stderrLines.join('\n').trim() || 'No PNG output was produced.';
    throw new Error(hint);
  }

  const blob = new Blob([pngData], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);

  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bmp, 0, 0);
  try {
    bmp.close();
  } catch (_) {
    /* ignore */
  }

  const outBlob = await canvasToPngBlob(canvas);
  const stderrText = stderrLines.join('\n').trim();

  return {
    ok: true,
    canvas,
    blob: outBlob,
    stderrText,
    outputHasError: false,
  };
}
