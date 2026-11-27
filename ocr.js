/**
 * ocr.js — OCR engine + text structure analysis
 * Uses Tesseract.js for text recognition (Thai + English)
 * Supports multiple OCR modes for different document types
 * Includes smart preprocessing, Thai spacing repair, and spatial XY-Cut block clustering
 */

const OCREngine = (() => {
  let worker = null;
  let isReady = false;
  let currentLang = 'tha+eng';
  let currentMode = 'auto'; // auto | document | photo | sparse
  let activeProgressCb = null;

  // ══════════════════════════════════════════════════════════════
  // OCR MODE CONFIGS
  // ══════════════════════════════════════════════════════════════
  const MODE_CONFIG = {
    auto: {
      label: '🔄 อัตโนมัติ',
      desc: '🔄 ระบบจะเลือกโหมดที่เหมาะสมอัตโนมัติ',
    },
    document: {
      label: '📄 เอกสาร',
      desc: '📄 เหมาะกับเอกสารพิมพ์ตัวอักษรชัดเจน (ขาวดำ/สแกน)',
      psm: '3',
      preprocess: 'document',
    },
    photo: {
      label: '📸 ภาพถ่าย',
      desc: '📸 เหมาะกับภาพถ่าย/Mind Map/สีสัน/ลายมือ — รักษาสีและรายละเอียด',
      psm: '3',
      preprocess: 'light',
    },
    sparse: {
      label: '🔍 กระจาย',
      desc: '🔍 เหมาะกับข้อความกระจาย ป้าย นามบัตร ใบเสร็จ',
      psm: '11',
      preprocess: 'light',
    },
  };

  // ══════════════════════════════════════════════════════════════
  // IMAGE PREPROCESSING
  // ══════════════════════════════════════════════════════════════

  function getSourceCanvas(source) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (source instanceof HTMLCanvasElement) {
      canvas.width = source.width;
      canvas.height = source.height;
      ctx.drawImage(source, 0, 0);
    } else if (source instanceof HTMLImageElement) {
      canvas.width = source.naturalWidth || source.width;
      canvas.height = source.naturalHeight || source.height;
      ctx.drawImage(source, 0, 0);
    } else {
      return null;
    }
    return canvas;
  }

  /**
   * Scale image so small text becomes readable for Tesseract (target ~2000-2400px wide)
   * and add a clean white border padding so edge text isn't clipped.
   */
  function scaleAndPadCanvas(srcCanvas, minWidth = 2200, maxDim = 3200, pad = 24) {
    const sw = srcCanvas.width;
    const sh = srcCanvas.height;

    let scale = 1;
    if (sw < minWidth) {
      scale = Math.min(minWidth / sw, 3);
    }
    // Prevent exceeding maxDim in either dimension
    const maxCurrent = Math.max(sw * scale, sh * scale);
    if (maxCurrent > maxDim) {
      scale = maxDim / Math.max(sw, sh);
    }

    const drawW = Math.max(1, Math.round(sw * scale));
    const drawH = Math.max(1, Math.round(sh * scale));

    const outCanvas = document.createElement('canvas');
    outCanvas.width = drawW + pad * 2;
    outCanvas.height = drawH + pad * 2;

    const outCtx = outCanvas.getContext('2d');
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(srcCanvas, pad, pad, drawW, drawH);

    return outCanvas;
  }

  /**
   * Unsharp mask sharpening on RGBA ImageData (crisp text edges for mobile photos).
   * Only boosts pixels with real edge contrast (> threshold) so flat paper stays clean.
   */
  function sharpenImageData(imageData, amount = 0.45, threshold = 8) {
    const { width: w, height: h, data } = imageData;
    if (w < 3 || h < 3) return;
    const orig = new Uint8Array(data);

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const center = orig[idx + c];
          const avg = (
            orig[idx - 4 + c] +
            orig[idx + 4 + c] +
            orig[idx - w * 4 + c] +
            orig[idx + w * 4 + c]
          ) * 0.25;
          const diff = center - avg;
          if (Math.abs(diff) > threshold) {
            data[idx + c] = Math.max(0, Math.min(255, Math.round(center + diff * amount)));
          }
        }
      }
    }
  }

  /**
   * Fast projection-profile auto-deskew (-8° to +8°) for tilted handheld mobile photos.
   * Only rotates when there is a clear horizontal text-line peak beating 0°.
   */
  function autoDeskewCanvas(srcCanvas) {
    const sw = srcCanvas.width;
    const sh = srcCanvas.height;
    if (sw < 120 || sh < 120) return srcCanvas;

    const sampleMax = 360;
    const scale = Math.min(1, sampleMax / Math.max(sw, sh));
    const w = Math.max(40, Math.round(sw * scale));
    const h = Math.max(40, Math.round(sh * scale));

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tCtx = tmp.getContext('2d');
    tCtx.drawImage(srcCanvas, 0, 0, w, h);
    const px = tCtx.getImageData(0, 0, w, h).data;

    // Build horizontal edge-energy map (sensitive to text strokes regardless of paper tint)
    const energy = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const gPrev = 0.3 * px[i - 4] + 0.59 * px[i - 3] + 0.11 * px[i - 2];
        const gNext = 0.3 * px[i + 4] + 0.59 * px[i + 5] + 0.11 * px[i + 6];
        const diff = Math.abs(gNext - gPrev);
        energy[y * w + x] = diff > 14 ? diff : 0;
      }
    }

    const scoreAngle = (deg) => {
      const rad = (deg * Math.PI) / 180;
      const sin = Math.sin(rad);
      const cos = Math.cos(rad);
      const cx = w * 0.5;
      const cy = h * 0.5;
      const proj = new Float64Array(h);

      for (let y = 2; y < h - 2; y += 2) {
        for (let x = 2; x < w - 2; x += 2) {
          const val = energy[y * w + x];
          if (val === 0) continue;
          const ry = Math.round((x - cx) * sin + (y - cy) * cos + cy);
          if (ry >= 0 && ry < h) proj[ry] += val;
        }
      }

      let score = 0;
      for (let y = 1; y < h; y++) {
        const d = proj[y] - proj[y - 1];
        score += d * d;
      }
      return score;
    };

    const zeroScore = scoreAngle(0);
    if (zeroScore <= 0) return srcCanvas;

    let bestAngle = 0;
    let bestScore = zeroScore;
    for (let a = -8; a <= 8.01; a += 0.8) {
      if (Math.abs(a) < 0.1) continue;
      const s = scoreAngle(a);
      if (s > bestScore) {
        bestScore = s;
        bestAngle = a;
      }
    }

    // Refine around best coarse angle
    const centerA = bestAngle;
    for (let a = centerA - 0.6; a <= centerA + 0.61; a += 0.2) {
      const s = scoreAngle(a);
      if (s > bestScore) {
        bestScore = s;
        bestAngle = a;
      }
    }

    // Only rotate if skew is meaningful (>= 1.5°) and clearly sharper than 0° (avoids blurring 1px Thai tone marks)
    if (Math.abs(bestAngle) < 1.5 || bestScore < zeroScore * 1.25) {
      return srcCanvas;
    }

    const rad = (-bestAngle * Math.PI) / 180;
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const oCtx = out.getContext('2d');
    oCtx.fillStyle = '#ffffff';
    oCtx.fillRect(0, 0, sw, sh);
    oCtx.translate(sw / 2, sh / 2);
    oCtx.rotate(rad);
    oCtx.drawImage(srcCanvas, -sw / 2, -sh / 2);
    return out;
  }

  /**
   * Trim uniform dark margins/letterboxing (e.g. black pillarboxes around a photographed/cropped page)
   * when the interior actually contains a bright document sheet. Avoids wasting upscale resolution
   * on black borders and prevents dark borders from skewing paper brightness estimation.
   */
  function trimDarkMargins(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (w < 80 || h < 80) return canvas;

    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, w, h).data;

    // Sample interior luminance (center 60% box) to confirm bright paper exists
    let brightCount = 0;
    let totalSample = 0;
    const ix0 = Math.floor(w * 0.15), ix1 = Math.ceil(w * 0.85);
    const iy0 = Math.floor(h * 0.15), iy1 = Math.ceil(h * 0.85);
    const stepX = Math.max(2, Math.floor((ix1 - ix0) / 40));
    const stepY = Math.max(2, Math.floor((iy1 - iy0) / 40));
    for (let y = iy0; y < iy1; y += stepY) {
      for (let x = ix0; x < ix1; x += stepX) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum >= 165) brightCount++;
        totalSample++;
      }
    }
    if (!totalSample || brightCount / totalSample < 0.18) return canvas;

    const isDarkRow = (y) => {
      let dark = 0, cnt = 0;
      const s = Math.max(2, Math.floor(w / 60));
      for (let x = 0; x < w; x += s) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 55) dark++;
        cnt++;
      }
      return cnt > 0 && dark / cnt >= 0.96;
    };

    const isDarkCol = (x) => {
      let dark = 0, cnt = 0;
      const s = Math.max(2, Math.floor(h / 60));
      for (let y = 0; y < h; y += s) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 55) dark++;
        cnt++;
      }
      return cnt > 0 && dark / cnt >= 0.96;
    };

    let top = 0, bottom = h - 1, left = 0, right = w - 1;
    while (top < h * 0.4 && isDarkRow(top)) top++;
    while (bottom > h * 0.6 && isDarkRow(bottom)) bottom--;
    while (left < w * 0.4 && isDarkCol(left)) left++;
    while (right > w * 0.6 && isDarkCol(right)) right--;

    // Keep small clean padding if we trimmed meaningfully
    const pad = 8;
    const tx0 = Math.max(0, left - pad);
    const ty0 = Math.max(0, top - pad);
    const tx1 = Math.min(w, right + 1 + pad);
    const ty1 = Math.min(h, bottom + 1 + pad);
    const nw = tx1 - tx0;
    const nh = ty1 - ty0;

    if (nw >= 80 && nh >= 80 && (w - nw >= 24 || h - nh >= 24)) {
      const cropped = document.createElement('canvas');
      cropped.width = nw;
      cropped.height = nh;
      cropped.getContext('2d').drawImage(canvas, tx0, ty0, nw, nh, 0, 0, nw, nh);
      return cropped;
    }
    return canvas;
  }

  /**
   * Light preprocessing: trim black margins + deskew + upscale + white padding + shadow balance & sharpening.
   * Preserves colored banners, highlighters, and fine Thai diacritics.
   */
  function preprocessLight(source) {
    const rawCanvas = getSourceCanvas(source);
    if (!rawCanvas) return source;
    const trimmed = trimDarkMargins(rawCanvas);
    const srcCanvas = autoDeskewCanvas(trimmed);

    const outCanvas = scaleAndPadCanvas(srcCanvas, 2200, 3200, 24);
    const outCtx = outCanvas.getContext('2d');
    const w = outCanvas.width;
    const h = outCanvas.height;

    const imageData = outCtx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // Coarse 24x24 grid background brightness estimate (lifts mobile camera shadows without washing out colors)
    const gridN = 24;
    const cellW = Math.max(1, Math.ceil(w / gridN));
    const cellH = Math.max(1, Math.ceil(h / gridN));
    const bgGrid = new Float64Array(gridN * gridN);
    let globalMaxBg = 0;

    for (let gy = 0; gy < gridN; gy++) {
      for (let gx = 0; gx < gridN; gx++) {
        const xStart = gx * cellW;
        const yStart = gy * cellH;
        const xEnd = Math.min(w, xStart + cellW);
        const yEnd = Math.min(h, yStart + cellH);
        let maxLum = 0;
        const step = Math.max(2, Math.floor(Math.min(cellW, cellH) / 6));
        for (let y = yStart; y < yEnd; y += step) {
          for (let x = xStart; x < xEnd; x += step) {
            const idx = (y * w + x) * 4;
            const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            if (lum > maxLum) maxLum = lum;
          }
        }
        bgGrid[gy * gridN + gx] = maxLum;
        if (maxLum > globalMaxBg) globalMaxBg = maxLum;
      }
    }

    const targetBg = Math.min(250, Math.max(210, globalMaxBg));
    const contrast = 1.18;
    const midpoint = 128;

    for (let y = 0; y < h; y++) {
      const gyF = Math.min(gridN - 1.001, (y / h) * gridN);
      const gy0 = Math.floor(gyF);
      const gy1 = Math.min(gridN - 1, gy0 + 1);
      const fy = gyF - gy0;

      for (let x = 0; x < w; x++) {
        const gxF = Math.min(gridN - 1.001, (x / w) * gridN);
        const gx0 = Math.floor(gxF);
        const gx1 = Math.min(gridN - 1, gx0 + 1);
        const fx = gxF - gx0;

        const b00 = bgGrid[gy0 * gridN + gx0];
        const b10 = bgGrid[gy0 * gridN + gx1];
        const b01 = bgGrid[gy1 * gridN + gx0];
        const b11 = bgGrid[gy1 * gridN + gx1];
        const localBg = (b00 * (1 - fx) + b10 * fx) * (1 - fy) + (b01 * (1 - fx) + b11 * fx) * fy;

        const gain = localBg >= 105 ? Math.min(1.65, targetBg / localBg) : 1;
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const normalized = data[i + c] * gain;
          data[i + c] = Math.max(0, Math.min(255, Math.round((normalized - midpoint) * contrast + midpoint)));
        }
      }
    }

    sharpenImageData(imageData, 0.4, 8);
    outCtx.putImageData(imageData, 0, 0);
    return outCanvas;
  }

  /**
   * Document preprocessing: trim dark margins + deskew + grayscale + paper-white division + contrast curve.
   * Uses local bright-paper estimation (NOT local mean!) so thin Thai tone marks (่ ้ ๊ ๋ ิ ี) are never erased.
   */
  function preprocessDocument(source) {
    const rawCanvas = getSourceCanvas(source);
    if (!rawCanvas) return source;
    const trimmed = trimDarkMargins(rawCanvas);
    const srcCanvas = autoDeskewCanvas(trimmed);

    const procCanvas = scaleAndPadCanvas(srcCanvas, 2200, 3200, 24);
    const procCtx = procCanvas.getContext('2d');
    const w = procCanvas.width;
    const h = procCanvas.height;

    const imageData = procCtx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // Grayscale + histogram
    const gray = new Uint8Array(w * h);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) {
      const pi = i * 4;
      const g = Math.round(0.299 * data[pi] + 0.587 * data[pi + 1] + 0.114 * data[pi + 2]);
      gray[i] = g;
      histogram[g]++;
    }

    // Auto-invert genuine dark-mode UI screenshots (majority dark background + sparse light text),
    // while NOT inverting bright paper sitting on dark borders.
    const totalPixels = w * h;
    let darkCheckSum = 0;
    let medianGray = 255;
    for (let i = 0; i < 256; i++) {
      darkCheckSum += histogram[i];
      if (darkCheckSum >= totalPixels * 0.5) {
        medianGray = i;
        break;
      }
    }
    let brightPixels = 0;
    for (let i = 175; i < 256; i++) brightPixels += histogram[i];
    const brightRatio = brightPixels / totalPixels;

    if (medianGray < 105 && brightRatio < 0.28) {
      histogram.fill(0);
      for (let i = 0; i < gray.length; i++) {
        const inv = 255 - gray[i];
        gray[i] = inv;
        histogram[inv]++;
      }
    }

    // Gentle highlight-preserving contrast stretch (0.2% - 99.5%)
    let minVal = -1;
    let maxVal = 255;
    let cumSum = 0;
    for (let i = 0; i < 256; i++) {
      cumSum += histogram[i];
      if (minVal === -1 && cumSum >= totalPixels * 0.002) minVal = i;
      if (cumSum >= totalPixels * 0.995) { maxVal = i; break; }
    }
    if (minVal === -1) minVal = 0;
    // Cap minVal so sparse cover pages (<0.2% ink) never stretch paper grain into dark ink
    minVal = Math.min(minVal, Math.min(75, Math.round(maxVal * 0.35)));
    const range = Math.max(40, maxVal - minVal);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, Math.round(((gray[i] - minVal) * 255) / range)));
    }

    // Coarse 28x28 grid of local PAPER WHITE (90th percentile in each cell) so dark ink never pulls down threshold
    const gridN = 28;
    const cellW = Math.max(1, Math.ceil(w / gridN));
    const cellH = Math.max(1, Math.ceil(h / gridN));
    const paperGrid = new Float64Array(gridN * gridN);
    const brightSamples = [];

    for (let gy = 0; gy < gridN; gy++) {
      for (let gx = 0; gx < gridN; gx++) {
        const xStart = gx * cellW;
        const yStart = gy * cellH;
        const xEnd = Math.min(w, xStart + cellW);
        const yEnd = Math.min(h, yStart + cellH);
        const vals = [];
        const stepX = Math.max(2, Math.floor((xEnd - xStart) / 8));
        const stepY = Math.max(2, Math.floor((yEnd - yStart) / 8));
        for (let y = yStart; y < yEnd; y += stepY) {
          for (let x = xStart; x < xEnd; x += stepX) {
            vals.push(gray[y * w + x]);
          }
        }
        vals.sort((a, b) => a - b);
        const p90 = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.90))] : 255;
        paperGrid[gy * gridN + gx] = p90;
        if (p90 >= 150) brightSamples.push(p90);
      }
    }

    // Fallback paper white if any cell fell completely on a dark desk corner
    brightSamples.sort((a, b) => a - b);
    const globalPaperBg = brightSamples.length
      ? brightSamples[Math.floor(brightSamples.length * 0.5)]
      : 245;

    for (let i = 0; i < paperGrid.length; i++) {
      if (paperGrid[i] < 110) paperGrid[i] = globalPaperBg;
    }

    // Divide by local paper white -> normalize shadows, keep ALL thin Thai strokes & tone marks intact
    for (let y = 0; y < h; y++) {
      const gyF = Math.min(gridN - 1.001, (y / h) * gridN);
      const gy0 = Math.floor(gyF);
      const gy1 = Math.min(gridN - 1, gy0 + 1);
      const fy = gyF - gy0;

      for (let x = 0; x < w; x++) {
        const gxF = Math.min(gridN - 1.001, (x / w) * gridN);
        const gx0 = Math.floor(gxF);
        const gx1 = Math.min(gridN - 1, gx0 + 1);
        const fx = gxF - gx0;

        const b00 = paperGrid[gy0 * gridN + gx0];
        const b10 = paperGrid[gy0 * gridN + gx1];
        const b01 = paperGrid[gy1 * gridN + gx0];
        const b11 = paperGrid[gy1 * gridN + gx1];
        const localBg = Math.max(110, (b00 * (1 - fx) + b10 * fx) * (1 - fy) + (b01 * (1 - fx) + b11 * fx) * fy);

        const g = gray[y * w + x];
        const rel = Math.min(255, (g / localBg) * 255);

        let val;
        if (rel >= 232) {
          val = 255;
        } else if (rel <= 35) {
          val = 0;
        } else {
          // Gentle ink-darkening curve preserving anti-aliased thin marks (rel 35..231 -> 0..235)
          val = Math.max(0, Math.min(240, Math.round(Math.pow((rel - 35) / 197, 1.3) * 238)));
        }

        const pi = (y * w + x) * 4;
        data[pi] = data[pi + 1] = data[pi + 2] = val;
        data[pi + 3] = 255;
      }
    }

    sharpenImageData(imageData, 0.3, 10);
    procCtx.putImageData(imageData, 0, 0);
    return procCanvas;
  }

  /**
   * Auto-detect: analyze image color saturation to pick between photo and document mode.
   * Ignores subtle warm indoor paper tint on mobile B&W document photos.
   */
  function autoDetectMode(source) {
    const canvas = getSourceCanvas(source);
    if (!canvas) return 'photo';

    const w = Math.min(canvas.width, 400);
    const h = Math.min(canvas.height, 400);
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = w;
    sampleCanvas.height = h;
    const sCtx = sampleCanvas.getContext('2d');
    sCtx.drawImage(canvas, 0, 0, w, h);

    const data = sCtx.getImageData(0, 0, w, h).data;
    let totalSat = 0;
    let vividPixels = 0;
    let sampled = 0;

    for (let i = 0; i < data.length; i += 16) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max > 40 ? (max - min) / max : 0;
      totalSat += sat;
      if (sat > 0.28) vividPixels++;
      sampled++;
    }

    const avgSat = sampled ? totalSat / sampled : 0;
    const vividRatio = sampled ? vividPixels / sampled : 0;

    if (vividRatio > 0.05 || avgSat > 0.14) {
      return 'photo';
    }
    return 'document';
  }

  function preprocessImage(source, mode) {
    const resolvedMode = mode === 'auto' ? autoDetectMode(source) : mode;
    const config = MODE_CONFIG[resolvedMode] || MODE_CONFIG.photo;
    const canvas = config.preprocess === 'document'
      ? preprocessDocument(source)
      : preprocessLight(source);
    return { canvas, mode: resolvedMode };
  }

  // ══════════════════════════════════════════════════════════════
  // TESSERACT WORKER
  // ══════════════════════════════════════════════════════════════

  async function init(lang = 'tha+eng', onProgress) {
    activeProgressCb = onProgress || null;
    // Reuse existing worker if language hasn't changed
    if (worker && isReady && currentLang === lang) {
      return true;
    }
    if (worker) {
      await worker.terminate();
      worker = null;
      isReady = false;
    }
    currentLang = lang;
    try {
      worker = await Tesseract.createWorker(lang, 1, {
        logger: (m) => {
          if (!activeProgressCb) return;
          if (m.status === 'recognizing text') {
            activeProgressCb(10 + Math.round(m.progress * 82), `กำลังอ่านข้อความ ${Math.round(m.progress * 100)}%...`);
          } else if (m.status) {
            activeProgressCb(null, m.status);
          }
        },
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
      });
      isReady = true;
      return true;
    } catch (err) {
      console.error('Tesseract init error:', err);
      throw err;
    }
  }

  async function applyModeParams(mode) {
    if (!worker) return;
    const config = MODE_CONFIG[mode] || MODE_CONFIG.photo;
    const psm = config.psm || '3';

    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      preserve_interword_spaces: '0',
      user_defined_dpi: '300',
    });
  }

  // ══════════════════════════════════════════════════════════════
  // THAI SPACING & LINE RECONSTRUCTION
  // ══════════════════════════════════════════════════════════════

  const isThaiChar = (ch) => /[\u0E00-\u0E7F]/.test(ch);
  // Characters that can NEVER start a Thai word after a space
  const isThaiNonStarter = (ch) => /[\u0E30-\u0E3A\u0E45-\u0E4E]/.test(ch);
  // Leading vowels that can NEVER end a Thai word before a space
  const isThaiLeadingVowel = (ch) => /[\u0E40-\u0E44]/.test(ch);

  /**
   * Safe orthographic Thai spacing repair:
   * Removes impossible spaces inside Thai syllables without merging separate phrases.
   */
  function fixThaiSpaces(text) {
    if (!text) return '';

    // Check if Tesseract inserted spaces between individual Thai characters
    // Measure on raw text BEFORE merging combining marks/leading vowels
    const rawThaiTokens = text.match(/[\u0E00-\u0E7F]+/g) || [];
    const rawSingleCount = rawThaiTokens.filter(t => t.length === 1).length;
    const isCharSplit = rawThaiTokens.length >= 4 && (rawSingleCount / rawThaiTokens.length) >= 0.45;

    let out = text
      // Remove spaces before Thai combining marks, trailing vowels, tone marks, maiyamok
      .replace(/([\u0E00-\u0E7F])\s+([\u0E30-\u0E3A\u0E45-\u0E4E])/g, '$1$2')
      // Remove spaces after Thai leading vowels (เ แ โ ใ ไ)
      .replace(/([\u0E40-\u0E44])\s+([\u0E01-\u0E2E])/g, '$1$2');

    if (isCharSplit) {
      // Collapse single space between Thai characters (keep 2+ spaces as phrase break)
      let prev;
      do {
        prev = out;
        out = out.replace(/([\u0E00-\u0E7F]) ([\u0E00-\u0E7F])/g, '$1$2');
      } while (out !== prev);
    }

    return out.replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * Clean internal spaces from a single OCR word token
   */
  function cleanWordToken(wordText) {
    return fixThaiSpaces((wordText || '').trim());
  }

  /**
   * Join an array of spatially adjacent words on one line segment,
   * using pixel gap relative to line height to decide Thai vs normal spacing.
   */
  function joinSegmentWords(words, lineH) {
    let out = '';
    let prevWord = null;
    for (let i = 0; i < words.length; i++) {
      const wt = cleanWordToken(words[i].text);
      if (!wt) continue;

      if (out.length > 0 && prevWord) {
        const gap = (words[i].bbox?.x0 ?? 0) - (prevWord.bbox?.x1 ?? 0);
        const prevCh = out[out.length - 1];
        const currCh = wt[0];

        if (isThaiChar(prevCh) && isThaiChar(currCh)) {
          if (isThaiNonStarter(currCh) || isThaiLeadingVowel(prevCh)) {
            // Never space
          } else if (gap > lineH * 0.45) {
            out += ' ';
          }
        } else {
          const isClosingPunct = /^[.,;:!?)\]\u0E46]/.test(currCh);
          const isOpeningPunct = /^[(\[]$/.test(prevCh);
          if (!isClosingPunct && !isOpeningPunct && gap > lineH * 0.12) {
            out += ' ';
          }
        }
      }
      out += wt;
      prevWord = words[i];
    }
    return fixThaiSpaces(out);
  }

  /**
   * Detect whether a line segment is doodle/drawing noise
   */
  function isNoiseSegment(seg) {
    const t = seg.text.trim();
    if (t.length < 2) return true;

    const conf = seg.confidence ?? 100;
    if (conf > 0 && conf < 22) return true;

    const alnumMatches = t.match(/[\u0E00-\u0E7FA-Za-z0-9]/g) || [];
    if (alnumMatches.length === 0) return true;

    // Filter short lines with low confidence or mostly garbage symbols
    const symbolRatio = 1 - (alnumMatches.length / t.length);
    if (t.length <= 6 && conf > 0 && conf < 50 && symbolRatio > 0.25) return true;
    if (symbolRatio > 0.55 && conf > 0 && conf < 65) return true;
    // High symbol ratio regardless of confidence = noise
    if (symbolRatio > 0.75) return true;

    // Thai syllables can never start with trailing/combining marks
    const startsWithThaiNonStarter = /^[\u0E30-\u0E3A\u0E45-\u0E4E]/.test(t);
    const tokens = t.split(/\s+/).filter(Boolean);
    const avgTokLen = tokens.length ? tokens.reduce((s, tok) => s + tok.length, 0) / tokens.length : t.length;

    if (startsWithThaiNonStarter && t.length <= 28 && (conf < 72 || avgTokLen <= 3.5)) {
      return true;
    }

    // Filter single-char soup: "v - a +", "A a c", token avg length too small
    const singleCharTokens = tokens.filter(tok => tok.length === 1).length;
    if (tokens.length >= 2 && singleCharTokens / tokens.length >= 0.5 && !/^\d+$/.test(tokens[0])) {
      if (conf < 75 || t.length <= 20) return true;
    }

    // Mostly tiny (<=2 char) tokens at low confidence: "od a", "v a +"
    const shortTokens = tokens.filter(tok => tok.length <= 2).length;
    if (tokens.length >= 2 && shortTokens / tokens.length >= 0.65 && conf > 0 && conf < 70 && t.length <= 20) {
      return true;
    }

    // Lines starting or ending with non-word symbol: "~ ยะขับ °", '" A a ๕'
    if (conf > 0 && conf < 65 && t.length <= 20) {
      if (/^[^\u0E00-\u0E7FA-Za-z0-9]/.test(t) || /[^\u0E00-\u0E7FA-Za-z0-9]$/.test(t)) {
        if (symbolRatio > 0.15) return true;
      }
      // Thai digits mixed in with other chars
      if (/[\u0E50-\u0E59]/.test(t) && tokens.length >= 2) return true;
    }

    // Linguistically impossible standalone 2-char Thai: 1 consonant + tone mark/karan with no vowel (e.g. "ข่", "ส่")
    if (/^[\u0E01-\u0E2E][\u0E48-\u0E4C]$/.test(t)) return true;

    // Very short Thai with tone marks = syllable splinter (ข่, ข่ม, ส่, ชิ, ศัณ)
    // Allow meaningful short words
    const shortThaiAllow = /^(โดย|หน้า|สรุป|บทนำ|บทที่|ทำ|ให้|ได้|ไม่|สิ้น|จบ|การ|รูป|หัว|ผล|มี)$/.test(t);
    if (!shortThaiAllow && t.length <= 5 && conf > 0 && conf < 72 && /[\u0E00-\u0E7F]/.test(t)) {
      if (/[\u0E48-\u0E4B]/.test(t)) return true; // contains tone mark (่ ้ ๊ ๋)
      if (t.length <= 3 && conf < 60) return true; // ultra-short at low conf
    }

    // Pure short Latin garbage at low confidence: "od", "vn", "[J"
    if (conf > 0 && conf < 65 && t.length <= 6 && tokens.length <= 2) {
      if (/^[A-Za-z\[\]{}()\s]{1,6}$/.test(t) && !/^(the|and|of|to|is|in|OCR|PDF|ID)$/i.test(t)) return true;
    }

    // Speck: single short token not in allowlist
    if (conf > 0 && conf < 55 && t.length <= 5 && tokens.length === 1 && !/^(โดย|บทนำ|สรุป|หน้า|\d+\.?)$/.test(t)) {
      return true;
    }

    return false;
  }

  /**
   * Collect all lines from OCR data, split any line across wide horizontal gaps
   * (so adjacent Mind Map boxes/columns don't fuse), and repair Thai spacing.
   */
  function extractCleanSegments(data) {
    // Collect raw lines from data.lines or flatten from data.blocks
    let rawLines = data.lines || [];
    if (!rawLines.length && data.blocks?.length) {
      data.blocks.forEach(b => {
        (b.paragraphs || []).forEach(p => {
          (p.lines || []).forEach(l => rawLines.push(l));
        });
      });
    }

    const segments = [];

    rawLines.forEach(line => {
      const bbox = line.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
      const lineH = Math.max(bbox.y1 - bbox.y0, 12);

      // Use word-level boxes when available to split horizontal gaps & repair Thai spacing
      const validWords = (line.words || [])
        .filter(w => {
          const wt = (w.text || '').trim();
          if (!wt) return false;
          // Drop isolated low-confidence punctuation/doodle noise words
          if ((w.confidence ?? 100) < 18 && wt.length <= 2 && !/[\u0E00-\u0E7FA-Za-z0-9]/.test(wt)) {
            return false;
          }
          return true;
        })
        .sort((a, b) => (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0));

      if (validWords.length > 0) {
        // Split into multiple virtual segments whenever horizontal gap exceeds 2.2 * lineH
        let curGroup = [validWords[0]];
        const groups = [curGroup];

        for (let i = 1; i < validWords.length; i++) {
          const prev = validWords[i - 1];
          const curr = validWords[i];
          const gap = (curr.bbox?.x0 ?? 0) - (prev.bbox?.x1 ?? 0);
          if (gap > lineH * 2.2) {
            curGroup = [curr];
            groups.push(curGroup);
          } else {
            curGroup.push(curr);
          }
        }

        groups.forEach(words => {
          const text = joinSegmentWords(words, lineH);
          const x0 = Math.min(...words.map(w => w.bbox?.x0 ?? bbox.x0));
          const y0 = Math.min(...words.map(w => w.bbox?.y0 ?? bbox.y0));
          const x1 = Math.max(...words.map(w => w.bbox?.x1 ?? bbox.x1));
          const y1 = Math.max(...words.map(w => w.bbox?.y1 ?? bbox.y1));
          const avgConf = words.reduce((s, w) => s + (w.confidence ?? line.confidence ?? 0), 0) / words.length;

          // Use percentile of word heights so one tall stray glyph/dot doesn't inflate fontSize into a fake H1
          const wordHeights = words
            .map(w => (w.bbox ? Math.max(8, w.bbox.y1 - w.bbox.y0) : lineH))
            .filter(h => h > 0);
          const coreH = wordHeights.length ? percentile(wordHeights, 65) : lineH;
          const estSize = Math.min(Math.max(y1 - y0, lineH), coreH * 1.25);

          const seg = {
            text,
            bbox: { x0, y0, x1, y1 },
            confidence: avgConf,
            fontSize: estSize || lineH,
          };
          if (!isNoiseSegment(seg)) segments.push(seg);
        });
      } else {
        const text = fixThaiSpaces(line.text || '');
        const seg = {
          text,
          bbox,
          confidence: line.confidence ?? 0,
          fontSize: lineH,
        };
        if (!isNoiseSegment(seg)) segments.push(seg);
      }
    });

    return segments;
  }

  // ══════════════════════════════════════════════════════════════
  // SPATIAL BLOCK CLUSTERING & XY-CUT READING ORDER
  // ══════════════════════════════════════════════════════════════

  /**
   * Group line segments into visual cards/blocks/columns using Union-Find,
   * so vertically stacked lines inside the same column/card stay together.
   */
  function clusterIntoBlocks(segments) {
    if (!segments.length) return [];

    const heights = segments.map(s => s.bbox.y1 - s.bbox.y0).filter(h => h > 0);
    const medianH = percentile(heights, 50) || 20;

    const n = segments.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    for (let i = 0; i < n; i++) {
      const A = segments[i].bbox;
      const hA = Math.max(A.y1 - A.y0, 8);
      for (let j = i + 1; j < n; j++) {
        const B = segments[j].bbox;
        const hB = Math.max(B.y1 - B.y0, 8);
        const refH = Math.max((hA + hB) / 2, medianH * 0.8);

        const hGap = Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1);
        const vGap = Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1);

        // Same visual box/column if horizontally overlapping/close AND vertically adjacent
        if (hGap <= refH * 1.4 && vGap <= refH * 1.8) {
          union(i, j);
        }
      }
    }

    const groupsMap = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!groupsMap.has(root)) groupsMap.set(root, []);
      groupsMap.get(root).push(segments[i]);
    }

    const blocks = [];
    groupsMap.forEach(lines => {
      // Sort lines within each block strictly top-to-bottom, then left-to-right
      lines.sort((a, b) => {
        const dy = a.bbox.y0 - b.bbox.y0;
        const lh = Math.max(a.fontSize, b.fontSize, 10);
        if (Math.abs(dy) < lh * 0.4) return a.bbox.x0 - b.bbox.x0;
        return dy;
      });

      blocks.push({
        lines,
        bbox: {
          x0: Math.min(...lines.map(l => l.bbox.x0)),
          y0: Math.min(...lines.map(l => l.bbox.y0)),
          x1: Math.max(...lines.map(l => l.bbox.x1)),
          y1: Math.max(...lines.map(l => l.bbox.y1)),
        },
      });
    });

    return orderBlocksXYCut(blocks, medianH);
  }

  /**
   * Find widest clear horizontal or vertical whitespace cut across a set of blocks.
   */
  function findBestCut(blocks, axis, minGap) {
    const startKey = axis === 'y' ? 'y0' : 'x0';
    const endKey = axis === 'y' ? 'y1' : 'x1';

    const sorted = [...blocks].sort((a, b) => a.bbox[startKey] - b.bbox[startKey]);
    let maxEnd = sorted[0].bbox[endKey];
    let bestCut = null;

    for (let i = 1; i < sorted.length; i++) {
      const start = sorted[i].bbox[startKey];
      const gap = start - maxEnd;
      if (gap >= minGap && (!bestCut || gap > bestCut.gap)) {
        bestCut = { gap, pos: (maxEnd + start) / 2, axis };
      }
      if (sorted[i].bbox[endKey] > maxEnd) {
        maxEnd = sorted[i].bbox[endKey];
      }
    }
    return bestCut;
  }

  /**
   * Recursive XY-Cut block ordering: reads rows/columns/cards cleanly without mixing columns.
   */
  function orderBlocksXYCut(blocks, medianH) {
    if (blocks.length <= 1) return blocks;

    const hCut = findBestCut(blocks, 'y', medianH * 0.4);
    const vCut = findBestCut(blocks, 'x', medianH * 0.6);

    let chosen = null;
    if (hCut && vCut) {
      // Prefer whichever gutter is wider (with slight bias for clear row cuts across bands)
      chosen = hCut.gap >= vCut.gap * 0.85 ? hCut : vCut;
    } else {
      chosen = hCut || vCut;
    }

    if (chosen) {
      const firstHalf = [];
      const secondHalf = [];
      blocks.forEach(b => {
        const center = chosen.axis === 'y'
          ? (b.bbox.y0 + b.bbox.y1) / 2
          : (b.bbox.x0 + b.bbox.x1) / 2;
        if (center < chosen.pos) firstHalf.push(b);
        else secondHalf.push(b);
      });

      if (firstHalf.length > 0 && secondHalf.length > 0) {
        return [
          ...orderBlocksXYCut(firstHalf, medianH),
          ...orderBlocksXYCut(secondHalf, medianH),
        ];
      }
    }

    // Fallback: top-to-bottom, left-to-right
    return [...blocks].sort((a, b) => {
      if (Math.abs(a.bbox.y0 - b.bbox.y0) < medianH * 1.2) {
        return a.bbox.x0 - b.bbox.x0;
      }
      return a.bbox.y0 - b.bbox.y0;
    });
  }

  // ── Recognize text from canvas/image ─────────────────────────
  async function recognize(imageSource, onProgress) {
    activeProgressCb = onProgress || null;
    if (!worker || !isReady) {
      await init(currentLang, onProgress);
    }

    // Step 1: Preprocess
    onProgress?.(5, 'กำลังวิเคราะห์ภาพ...');
    const { canvas: processed, mode: detectedMode } = preprocessImage(imageSource, currentMode);

    // Step 2: Apply Tesseract parameters
    const modeLabel = MODE_CONFIG[detectedMode]?.label || detectedMode;
    onProgress?.(8, `ใช้โหมด ${modeLabel}...`);
    await applyModeParams(detectedMode);

    // Step 3: Run OCR
    onProgress?.(10, 'กำลังอ่านข้อความ...');
    const result = await worker.recognize(processed);
    const data = result.data;

    // Step 4: Post-process (split gaps, fix Thai spacing, filter noise, cluster blocks)
    const segments = extractCleanSegments(data);
    const orderedBlocks = clusterIntoBlocks(segments);

    data._blocks = orderedBlocks;
    data.lines = orderedBlocks.flatMap(b => b.lines);
    data.text = orderedBlocks
      .map(b => b.lines.map(l => l.text).join('\n'))
      .join('\n\n');
    data._ocrMode = detectedMode;

    return data;
  }

  // ── Terminate worker ──────────────────────────────────────────
  async function terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
      isReady = false;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // TEXT STRUCTURE ANALYSIS
  // ══════════════════════════════════════════════════════════════

  function computeFontStats(lines) {
    const reliable = lines
      .filter(l => (l.text || '').trim().length >= 2 && ((l.confidence ?? 0) === 0 || l.confidence >= 45))
      .map(l => estimateFontSize(l))
      .filter(s => s > 0);
    const fontSizes = reliable.length >= 2
      ? reliable
      : lines.map(l => estimateFontSize(l)).filter(s => s > 0);
    return {
      medianSize: percentile(fontSizes, 50),
      p75: percentile(fontSizes, 75),
      p90: percentile(fontSizes, 90),
    };
  }

  function isValidHeadingCandidate(text, confidence = 0) {
    const t = (text || '').trim();
    if (!t || t.length < 2 || t.length > 90) return false;
    if (confidence > 0 && confidence < 45) return false;
    // Thai combining/trailing marks can never begin a real heading
    if (/^[\u0E30-\u0E3A\u0E45-\u0E4E]/.test(t)) return false;
    // Bullets or decorative symbols
    if (/^[•▪▸►\*\-—–]/.test(t)) return false;
    // Must contain real Thai consonants or Latin letters (not just numbers/percent/symbols)
    if (!/[A-Za-z\u0E01-\u0E2E]/.test(t)) return false;
    return true;
  }

  function isProseOrMetadata(text) {
    const t = (text || '').trim();
    if (!t) return true;
    // Cover-page author / student / academic metadata
    if (/^(โดย|ผู้จัดทำ|จัดทำโดย|เสนอ|เสนอต่อ|อาจารย์ที่ปรึกษา|ที่ปรึกษา)\s*[:\-]?\s*$/.test(t)) return true;
    if (/^(นาย|นางสาว|น\.ส\.|นาง|ดร\.|ผศ\.|รศ\.|ศ\.|Mr\.|Mrs\.|Ms\.|Dr\.)\s*\S/.test(t)) return true;
    if (/^(รหัส\s*(?:นักศึกษา|ประจำตัว|นิสิต)?|เลขประจำตัว|Student\s*ID)\s*[:\-]?\s*[A-Za-z0-9]/i.test(t)) return true;
    if (/^(ภาคเรียนที่|ปีการศึกษา|ประจำปี|พ\.ศ\.|ค\.ศ\.)\s/.test(t)) return true;
    if (/^(รายงาน|ระบบ|เอกสาร|โครงการ|โครงงาน|แบบฟอร์ม|ประกาศ|หัวข้อ|แอป(?:พลิเคชัน)?|โปรแกรม)\s*(?:นี้|นั้น|ดังกล่าว)/.test(t)) return true;
    if (/(เป็นส่วนหนึ่งของ|เสนอต่อ.{1,20}รายวิชา|ซึ่งเป็น|โดยจะต้อง|จะต้องมี|จะต้องสามารถ|สามารถ.{1,35}ได้|เพื่อตรวจสอบ|ในรัศมีไม่เกิน|ตัวเลือกให้เลือก|ตัวเลือกคือให้|ออกมาให้ทดลองใช้|ส่งมาพร้อม)/.test(t)) return true;
    // Numbered prose items (e.g. "1) ทำแอปลงเวลา...", "1) Attendance Tracker: Create an application...")
    if (/^\d+[.)]\s+\S/.test(t)) {
      const rest = t.replace(/^\d+[.)]\s+/, '');
      if (
        rest.length > 36 ||
        /(จะต้อง|สามารถ|เพื่อ|โดยมี|โดยจะ|คือให้|สำหรับ|ทำการ|ก็ได้|นักศึกษา|อาจารย์)/.test(rest) ||
        /:\s+\S+\s+\S+\s+\S+/.test(rest) ||
        /\b(and|or|that|which|where|with|for|create|develop|make|allow|must|will|shall|can|should|is|are|using|whereby)\b/i.test(rest)
      ) {
        return true;
      }
    }
    // Incomplete Thai clause endings typical of wrapped paragraph lines
    if (t.length > 26 && /(และ|หรือ|ที่|ซึ่ง|เพื่อ|โดย|กับ|จาก|ใน|ของ|ให้|จะ|ต้อง|ได้|เป็น|ว่า|มา|ไป|อยู่|ทั้งนี้|สำหรับ|แต่|ถ้า|หาก|เมื่อ)$/.test(t)) {
      return true;
    }
    if (/\.$/.test(t) && t.length > 38 && /\b(is|are|was|were|must|will|shall|can|should|that|which|where|with|and|or)\b/i.test(t)) {
      return true;
    }
    return false;
  }

  /**
   * Detect index where cover-page metadata starts (e.g. "โดย", author name, student ID, "รายงานนี้เป็นส่วนหนึ่งของ").
   * Returns { hasCoverMeta, metaStartIdx } using lines or flattened blocks.
   */
  function findCoverMetaBoundary(items) {
    const coverAnchorRe = /^(โดย|ผู้จัดทำ|จัดทำโดย|เสนอ|เสนอต่อ|อาจารย์ที่ปรึกษา|ที่ปรึกษา)\s*[:\-]?\s*$/;
    const coverDetailRe = /^(นาย|นางสาว|น\.ส\.|นาง|รหัส\s*(?:นักศึกษา|ประจำตัว|นิสิต)|Student\s*ID|รายงาน.{0,8}เป็นส่วนหนึ่งของ)/i;
    for (let i = 0; i < Math.min(items.length, 14); i++) {
      const txt = (items[i]?.text || '').trim();
      if (coverAnchorRe.test(txt) || coverDetailRe.test(txt)) {
        return { hasCoverMeta: i >= 1, metaStartIdx: i };
      }
    }
    return { hasCoverMeta: false, metaStartIdx: -1 };
  }

  function classifyLine(text, fontSize, medianSize, p75, p90, confidence) {
    const t = (text || '').trim();
    if (!t || t.length < 2) return 'body';

    if (confidence > 0 && confidence < 45) return 'body';
    if (/^[•▪▸►\*]\s/.test(t) || /^-\s+\S/.test(t)) return 'bullet';
    if (!isValidHeadingCandidate(t, confidence)) return 'body';
    // Trailing continuation clauses (e.g. wrapped last line "แบ่งเป็นหัวข้อ", "งานได้") must never become headings
    if (/^(แบ่งเป็น|งานได้|และ|หรือ|โดย|แต่|ซึ่ง|เพื่อ|สำหรับ)/.test(t) && t.length <= 45) return 'body';

    const relSize = medianSize > 0 ? fontSize / medianSize : 1;
    const proseOrMeta = isProseOrMetadata(t);

    // 1. Explicit document / chapter / report main titles (h1) — check before generic sentence heuristics
    const h1Patterns = [
      /^(บทที่\s*\d+|ภาคผนวก|สารบัญ|บทคัดย่อ|กิตติกรรมประกาศ|บรรณานุกรม)/,
      /^(รายงานการ|รายงานผล|รายงานประจำ|แบบเสนอโครงการ|แบบเสนอโครงงาน|ประกาศเรื่อง|คำสั่งที่|ระเบียบว่าด้วย)/,
      /^(CHAPTER\s+\d+|PART\s+\d+|ABSTRACT|TABLE OF CONTENTS|APPENDIX)\b/i,
    ];
    if (!proseOrMeta && t.length <= 75 && h1Patterns.some(r => r.test(t))) return 'h1';

    // 2. Explicit labeled topic headers like "Options: Choose only 1 application..." or "หมายเหตุ: ..."
    if (/^(Options?|Instructions?|Directions?|หมายเหตุ|คำชี้แจง|หัวข้อ)\s*:/i.test(t) && t.length <= 95 && !/^\d+[.)]/.test(t)) {
      return 'h2';
    }

    // 3. Font-size based classification
    const isNumbered = /^\d+[.)]\s/.test(t);
    if (!proseOrMeta && !isNumbered && t.length <= 75) {
      if (relSize >= 1.28 && (p90 <= medianSize * 1.05 || fontSize >= p90 * 0.90)) return 'h1';
      if (relSize >= 1.14 && fontSize >= p75 * 0.92) return 'h2';
    }

    // 4. Explicit subheading patterns (h2)
    const thaiSubPatterns = [
      /^(หัวข้อ|ตอนที่|ส่วนที่|บทนำ|บทสรุป|สรุป|ข้อที่|ข้อ\s*\d+\b)/,
      /^(โครงการ|โครงงาน|ชื่อเรื่อง|ชื่องาน|ชื่อระบบ|ชื่อโครงการ|วัตถุประสงค์|ขอบเขต|ประโยชน์|หลักการ|ลักษณะ|ประเภท|องค์ประกอบ|วิธีการ|วิธีดำเนินงาน|ผลที่คาดว่าจะได้รับ|รายละเอียด|หมายเหตุ|ขั้นตอนการ)(?:\s*:|\s|$)/,
    ];
    const engSubPatterns = [
      /^(SECTION|CHAPTER|PART|ARTICLE|CLAUSE|SCHEDULE|ANNEX)\b/i,
      /^(Summary|Introduction|Conclusion|Overview|Objective|Objectives|Background|Methodology|Results|Discussion|Options?|Requirements?|Features?)(?:\s*:|\s|$)/i,
    ];
    if (!proseOrMeta && t.length <= 65 && (thaiSubPatterns.some(r => r.test(t)) || engSubPatterns.some(r => r.test(t)))) {
      return 'h2';
    }

    // Cover-page / section short noun-phrase project title (e.g. "ระบบสำรองค่าคอนฟิกอุปกรณ์เครือข่ายอัตโนมัติ")
    const thaiProjectTitleRe = /^(ระบบ|แอปพลิเคชัน|โปรแกรม|การพัฒนา|การออกแบบ|การศึกษา|คู่มือ|แผนงาน)/;
    if (
      !proseOrMeta &&
      t.length >= 4 &&
      t.length <= 58 &&
      !/[.,;!]$/.test(t) &&
      thaiProjectTitleRe.test(t) &&
      !/(จะ|ต้อง|สามารถ|หรือ|ก็ได้|ไม่เกิน|ทำงาน|ต่อไปนี้)/.test(t)
    ) {
      return 'h2';
    }

    const isAllCaps = t === t.toUpperCase() && /[A-Z]{3,}/.test(t) && t.length <= 55;
    const isParenEngSubtitle = /^\([A-Z][A-Za-z0-9\s\-&,\/\.]{4,}\)$/.test(t) && t.length <= 68;
    if (!proseOrMeta && (isAllCaps || isParenEngSubtitle)) return 'h2';

    // 5. Reject prose/sentences before minor numbered check
    const isSentenceLike = proseOrMeta || t.length > 70 || (/[.,;!]$/.test(t) && t.length > 35);
    if (isSentenceLike) return 'body';

    // 6. Minor numbered headings (h3): multi-level (1.1 Title) or strictly short label (1. บทนำ)
    if (/^\d+(\.\d+)+\s+\S/.test(t) && t.length <= 55 && !/[.,;]$/.test(t)) return 'h3';
    if (/^\d+[.)]\s+\S/.test(t) && t.length <= 36 && !/[.,;]$/.test(t)) return 'h3';

    return 'body';
  }

  /**
   * Apply cover-page pre-pass & pre-body merging across flat classified items { type, text, confidence }.
   */
  function buildSectionsFromClassified(items) {
    // If cover metadata marker ("โดย", author name, student ID, disclaimer) is present,
    // any valid non-prose short lines appearing BEFORE it belong to cover-page titles!
    const { hasCoverMeta, metaStartIdx } = findCoverMetaBoundary(items);
    if (hasCoverMeta) {
      let hasH1BeforeMeta = items.slice(0, metaStartIdx).some(it => it.type === 'h1');
      for (let i = 0; i < metaStartIdx; i++) {
        const it = items[i];
        const t = (it.text || '').trim();
        if (
          it.type === 'body' &&
          isValidHeadingCandidate(t, it.confidence) &&
          !isProseOrMetadata(t) &&
          !/[.,;!]$/.test(t) &&
          t.length >= 4 &&
          t.length <= 75
        ) {
          it.type = hasH1BeforeMeta ? 'h2' : 'h1';
          if (it.type === 'h1') hasH1BeforeMeta = true;
        }
      }
      // Make sure items AT or AFTER metaStartIdx marked as metadata stay body
      for (let i = metaStartIdx; i < items.length; i++) {
        if (isProseOrMetadata(items[i].text)) {
          items[i].type = 'body';
        }
      }
    }

    const sections = [];
    let currentSection = null;
    items.forEach((it) => {
      if (it.type === 'h1' || it.type === 'h2' || it.type === 'h3') {
        currentSection = { type: it.type, text: it.text, confidence: it.confidence || 0, children: [] };
        sections.push(currentSection);
      } else {
        if (currentSection) {
          currentSection.children.push({ type: 'body', text: it.text, confidence: it.confidence || 0 });
        } else {
          sections.push({ type: 'body', text: it.text, confidence: it.confidence || 0, children: [] });
        }
      }
    });
    return postProcessSections(mergeBodyLines(sections));
  }

  function structureText(ocrData) {
    const blocks = ocrData?._blocks;
    if (blocks && blocks.length > 0) {
      return structureFromBlocks(blocks);
    }

    if (!ocrData || !ocrData.lines || ocrData.lines.length === 0) {
      return fallbackStructure(ocrData?.text || '');
    }

    const lines = ocrData.lines;
    const { medianSize, p75, p90 } = computeFontStats(lines);

    const items = [];
    lines.forEach((line) => {
      const text = line.text?.trim();
      if (!text || text.length < 2) return;
      const fontSize = estimateFontSize(line);
      const confidence = line.confidence || 0;
      const type = classifyLine(text, fontSize, medianSize, p75, p90, confidence);
      items.push({ type, text, confidence });
    });

    return buildSectionsFromClassified(items);
  }

  /**
   * Structure text while keeping each visual block/card grouped together.
   */
  function structureFromBlocks(blocks) {
    const allLines = blocks.flatMap(b => b.lines);
    const { medianSize, p75, p90 } = computeFontStats(allLines);

    // Pre-check cover page metadata across all lines in visual reading order
    const flatTrimmed = allLines.map(l => ({ text: (l.text || '').trim(), confidence: l.confidence || 0 }));
    const { hasCoverMeta, metaStartIdx } = findCoverMetaBoundary(flatTrimmed);

    let globalLineIdx = 0;
    let hasH1SoFar = false;
    const sections = [];

    blocks.forEach(block => {
      const lines = block.lines;
      if (!lines.length) return;

      let currentSection = null;
      const blockW = Math.max(1, (block.bbox?.x1 ?? 0) - (block.bbox?.x0 ?? 0));

      lines.forEach((line, idx) => {
        const myGlobalIdx = globalLineIdx++;
        const text = line.text?.trim();
        if (!text || text.length < 2) return;

        const fontSize = estimateFontSize(line);
        const confidence = line.confidence || 0;
        let type = classifyLine(text, fontSize, medianSize, p75, p90, confidence);

        // Cover-page promotion before metadata anchor
        if (
          hasCoverMeta &&
          myGlobalIdx < metaStartIdx &&
          type === 'body' &&
          isValidHeadingCandidate(text, confidence) &&
          !isProseOrMetadata(text) &&
          !/[.,;!]$/.test(text) &&
          text.length >= 4 &&
          text.length <= 75
        ) {
          type = hasH1SoFar ? 'h2' : 'h1';
        }

        // Mind-map / multi-line card: promote short, valid first line above bullets/spaced body lines
        // (Avoid promoting wide wrapped paragraph opening lines or prose clauses)
        if (
          idx === 0 &&
          type === 'body' &&
          lines.length > 1 &&
          !hasCoverMeta &&
          isValidHeadingCandidate(text, confidence) &&
          !isProseOrMetadata(text) &&
          text.length >= 4 &&
          text.length <= 34 &&
          !/^\d+[.)\]]\s/.test(text) &&
          !/[.,;]$/.test(text)
        ) {
          const nextLine = lines[1];
          const nextText = (nextLine?.text || '').trim();
          const nextStartsBullet = /^[•▪▸►\-*]/.test(nextText) || /^\d+[.)]\s/.test(nextText);
          const vGap = (nextLine?.bbox && line.bbox) ? (nextLine.bbox.y0 - line.bbox.y1) : 0;
          const lineH = Math.max(fontSize, 12);
          const lineW = line.bbox ? (line.bbox.x1 - line.bbox.x0) : 0;
          const nextSize = nextLine ? estimateFontSize(nextLine) : fontSize;

          const clearVisualBreak = nextStartsBullet || vGap > lineH * 0.35 || fontSize >= nextSize * 1.1 || (text.length <= 24 && lineW < blockW * 0.85);
          if (clearVisualBreak) {
            type = 'h2';
          }
        }

        if (type === 'h1') hasH1SoFar = true;

        if (type === 'h1' || type === 'h2' || type === 'h3') {
          currentSection = { type, text, confidence, children: [] };
          sections.push(currentSection);
        } else {
          if (currentSection) {
            currentSection.children.push({ type: 'body', text, confidence });
          } else {
            currentSection = { type: 'body', text, confidence, children: [] };
            sections.push(currentSection);
          }
        }
      });
    });

    return postProcessSections(mergeBodyLines(sections));
  }

  function estimateFontSize(line) {
    if (line.fontSize) return line.fontSize;
    if (!line.bbox) return 0;
    return line.bbox.y1 - line.bbox.y0;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((p / 100) * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  // Upgrade lone h2 -> h1 when appropriate, promote top title when no headings were detected,
  // & merge consecutive top-level body blocks
  function postProcessSections(sections) {
    if (!sections || !sections.length) return [];

    let working = sections.map(s => ({ ...s, children: s.children ? [...s.children] : [] }));

    // If we have h2 but no h1 (e.g. a cover page where only "ระบบ..." or title matched h2 and no main h1 existed),
    // promote the very first standalone h2 at index 0 to h1 so the document has a clear primary heading.
    const hasH1 = working.some(s => s.type === 'h1');
    const hasAnyHeading = working.some(s => s.type === 'h1' || s.type === 'h2');

    if (!hasH1 && hasAnyHeading && working[0]?.type === 'h2' && (!working[0].children || working[0].children.length === 0 || working.length <= 4)) {
      // Only promote lone top h2 when it's not a mind-map of equal sibling cards (multiple h2s with children)
      const h2WithChildren = working.filter(s => s.type === 'h2' && s.children && s.children.length > 0).length;
      if (h2WithChildren <= 1 || /^\u0E23\u0E30\u0E1A\u0E1A|^\u0E42\u0E04\u0E23\u0E07|^\u0E23\u0E32\u0E22\u0E07\u0E32\u0E19/.test(working[0].text)) {
        working[0].type = 'h1';
      }
    }

    if (!hasAnyHeading) {
      let h1Done = false;
      let h2Count = 0;
      let sawLongProse = false;
      const endsWithContinuationRe = /(?:และ|หรือ|โดย|ที่|ซึ่ง|เพื่อ|สำหรับ|แต่|กับ|จาก|ใน|ของ|ได้|จะ|ต้อง|เป็น|ให้|ว่า)$/;
      working = working.map((s, idx) => {
        if (s.type !== 'body') return s;
        const txt = (s.text || '').trim();
        const prevTxt = idx > 0 ? (working[idx - 1].text || '').trim() : '';
        const prevEndsWithContinuation = endsWithContinuationRe.test(prevTxt);
        const singleLine = !txt.includes('\n');
        const noEndPunct = !/[.,;:!]$/.test(txt);
        const noChildren = s.children.length === 0;
        const canPromote =
          !sawLongProse &&
          !prevEndsWithContinuation &&
          idx <= 3 &&
          singleLine &&
          noEndPunct &&
          noChildren &&
          txt.length >= 4 &&
          txt.length <= 68 &&
          isValidHeadingCandidate(txt, s.confidence ?? 0) &&
          !isProseOrMetadata(txt) &&
          !/^\d+[.)]\s/.test(txt) &&
          !/^(แบ่งเป็น|งานได้|และ|หรือ|โดย|แต่|ซึ่ง|เพื่อ|สำหรับ)/.test(txt);

        if (txt.includes('\n') || txt.length > 90) {
          sawLongProse = true;
        }

        if (canPromote) {
          if (!h1Done) {
            h1Done = true;
            return { ...s, type: 'h1' };
          }
          if (h2Count < 2) {
            h2Count++;
            return { ...s, type: 'h2' };
          }
        }
        return s;
      });
    }

    // Merge consecutive top-level body blocks so metadata/paragraphs don't repeat "📝 เนื้อหา" badges
    const merged = [];
    for (const sec of working) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.type === 'body' &&
        sec.type === 'body' &&
        (!prev.children || prev.children.length === 0) &&
        (!sec.children || sec.children.length === 0)
      ) {
        prev.text = [prev.text, sec.text].filter(Boolean).join('\n');
      } else {
        merged.push(sec);
      }
    }
    return merged;
  }

  function mergeBodyLines(sections) {
    return sections.map(section => {
      if (section.type === 'body' && section.children && section.children.length > 0) {
        const texts = [section.text, ...section.children.map(c => c.text)];
        return { ...section, text: texts.join('\n'), children: [] };
      }
      if (!section.children || section.children.length === 0) return section;
      const merged = [];
      let buffer = [];
      section.children.forEach(child => {
        if (child.type === 'body') {
          buffer.push(child.text);
        } else {
          if (buffer.length) { merged.push({ type: 'body', text: buffer.join('\n') }); buffer = []; }
          merged.push(child);
        }
      });
      if (buffer.length) merged.push({ type: 'body', text: buffer.join('\n') });
      return { ...section, children: merged };
    });
  }

  function fallbackStructure(rawText) {
    if (!rawText) return [];
    const lines = rawText.split('\n').map(l => fixThaiSpaces(l.trim())).filter(Boolean);
    const items = lines.map(text => ({
      type: classifyLine(text, 0, 0, 0, 0, 0),
      text,
      confidence: 0,
    }));
    return buildSectionsFromClassified(items);
  }

  // ── Render structured output to DOM ───────────────────────────
  function renderToDOM(sections, container) {
    container.innerHTML = '';

    if (!sections || sections.length === 0) {
      container.innerHTML = `
        <div class="result-empty">
          <span class="em-icon">📄</span>
          <p>ไม่พบข้อความในเอกสาร<br>ลองปรับจุดตัดหรือเลือกโหมด/ภาษาอีกครั้ง</p>
        </div>`;
      return;
    }

    sections.forEach((section, idx) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'doc-section';
      wrapper.style.animationDelay = `${idx * 0.05}s`;

      if (section.type === 'h1' || section.type === 'h2' || section.type === 'h3') {
        const labelEl = document.createElement('div');
        labelEl.className = `section-label label-${section.type === 'h1' ? 'heading' : 'subheading'}`;
        labelEl.innerHTML = section.type === 'h1' ? '📋 หัวข้อหลัก' : section.type === 'h2' ? '📌 หัวข้อรอง' : '🔸 หัวข้อย่อย';
        wrapper.appendChild(labelEl);

        const headEl = document.createElement('div');
        headEl.className = `doc-${section.type}`;
        headEl.textContent = section.text;
        wrapper.appendChild(headEl);

        (section.children || []).forEach(child => {
          if (child.type === 'body') {
            const bodyEl = document.createElement('div');
            bodyEl.className = 'doc-body';
            bodyEl.textContent = child.text;
            wrapper.appendChild(bodyEl);
          }
        });

      } else if (section.type === 'body') {
        const labelEl = document.createElement('div');
        labelEl.className = 'section-label label-body';
        labelEl.innerHTML = '📝 เนื้อหา';
        wrapper.appendChild(labelEl);

        const bodyEl = document.createElement('div');
        bodyEl.className = 'doc-body';
        bodyEl.textContent = section.text;
        wrapper.appendChild(bodyEl);

      } else if (section.type === 'bullet') {
        const bodyEl = document.createElement('div');
        bodyEl.className = 'doc-body';
        bodyEl.style.paddingLeft = '24px';
        bodyEl.textContent = section.text;
        wrapper.appendChild(bodyEl);
      }

      container.appendChild(wrapper);
    });
  }

  // ── Get plain text ────────────────────────────────────────────
  function toPlainText(sections) {
    if (!sections) return '';
    let out = '';
    sections.forEach(s => {
      if (s.type === 'h1' || s.type === 'h2' || s.type === 'h3') {
        const prefix = s.type === 'h1' ? '═══' : s.type === 'h2' ? '───' : '---';
        out += `\n${prefix} ${s.text} ${prefix}\n`;
        (s.children || []).forEach(c => { out += c.text + '\n'; });
      } else {
        out += s.text + '\n';
      }
    });
    return out.trim();
  }

  // ══════════════════════════════════════════════════════════════
  // GEMINI AI VISION OCR (HIGH-ACCURACY / HANDWRITING / MIND MAP)
  // ══════════════════════════════════════════════════════════════

  const AI_MODELS = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];

  async function discoverGeminiFlashModels(apiKey) {
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const models = (data.models || [])
        .filter((m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          /gemini/i.test(m.name) &&
          !/embedding|tts|aqa|imagen|veo|audio/i.test(m.name)
        )
        .map((m) => m.name.replace(/^models\//, ''));

      // Prefer flash models, newest version numbers first
      models.sort((a, b) => {
        const aFlash = /flash/i.test(a) ? 1 : 0;
        const bFlash = /flash/i.test(b) ? 1 : 0;
        if (aFlash !== bFlash) return bFlash - aFlash;
        return b.localeCompare(a, undefined, { numeric: true });
      });
      return models;
    } catch (_) {
      return [];
    }
  }

  function imageSourceToJpegBase64(imageSource, maxDim = 2048) {
    const srcCanvas = getSourceCanvas(imageSource);
    if (!srcCanvas) throw new Error('ไม่พบข้อมูลภาพสำหรับส่งวิเคราะห์');

    const sw = srcCanvas.width;
    const sh = srcCanvas.height;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    let targetCanvas = srcCanvas;
    if (scale < 1) {
      targetCanvas = document.createElement('canvas');
      targetCanvas.width = dw;
      targetCanvas.height = dh;
      const ctx = targetCanvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dw, dh);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(srcCanvas, 0, 0, dw, dh);
    }

    const dataUrl = targetCanvas.toDataURL('image/jpeg', 0.92);
    return dataUrl.split(',')[1];
  }

  function buildAIOCRPrompt(lang) {
    const langHint = lang === 'tha'
      ? 'Focus on Thai text.'
      : lang === 'eng'
      ? 'Focus on English text.'
      : 'Read both Thai and English text accurately.';

    return [
      'You are a high-precision OCR transcription engine.',
      langHint,
      'Transcribe ALL readable text from this image faithfully and verbatim.',
      'Rules:',
      '1. Read every heading, label, bullet point, note, table cell, and handwritten annotation accurately.',
      '2. Preserve original Thai spelling, tone marks (่ ้ ๊ ๋), vowels, numbers, and English words exactly. Do NOT summarize, translate, or paraphrase.',
      '3. Keep multi-column layouts, mind-map cards, or boxed sections grouped logically: each card/section heading followed by its own body lines inside children.',
      '4. Ignore purely decorative doodles/icons without text and background shadows.',
      '5. Return valid JSON matching the schema: {"sections":[{"type":"h1"|"h2"|"h3"|"body","text":"...","children":[{"type":"body","text":"..."}]}]}.',
      '   - Use "h1" for primary document titles or main cover-page titles (e.g. "รายงานการปฏิบัติงานเตรียมสหกิจศึกษา", "ระบบสำรองค่าคอนฟิกอุปกรณ์เครือข่ายอัตโนมัติ", mind-map center titles).',
      '   - Use "h2" for secondary subtitles (e.g. "(Automated Network Configuration Backup System)"), section/topic headings (e.g. "Options: Choose only 1 application..."), and mind-map card headings.',
      '   - Use "h3" ONLY for short numbered subheadings (e.g. "1. บทนำ", "2.1 หลักการ").',
      '   - Use "body" for regular sentences, paragraphs, numbered paragraph descriptions (e.g. "1) ทำแอปลงเวลา...", "1) Attendance Tracker: Create..."), and cover-page metadata ("โดย", author names, student IDs, "รายงานนี้เป็นส่วนหนึ่งของ..."). Group consecutive body lines with \\n inside children rather than splitting every wrapped line.',
    ].join('\n');
  }

  function normalizeAISections(rawSections) {
    if (!Array.isArray(rawSections)) return [];
    const normalized = [];
    rawSections.forEach((sec) => {
      if (!sec || typeof sec !== 'object') return;
      const text = String(sec.text || '').trim();
      let type = ['h1', 'h2', 'h3', 'body'].includes(sec.type) ? sec.type : 'body';
      if (
        (type === 'h1' || type === 'h2' || type === 'h3') &&
        (!isValidHeadingCandidate(text, 98) || text.length > 105 || isProseOrMetadata(text))
      ) {
        type = 'body';
      }
      const children = Array.isArray(sec.children)
        ? sec.children
            .map((c) => ({
              type: 'body',
              text: String(c?.text || '').trim(),
              confidence: 98,
            }))
            .filter((c) => c.text.length > 0)
        : [];

      if (!text && children.length === 0) return;

      if (type === 'body' && children.length > 0) {
        const mergedText = [text, ...children.map((c) => c.text)].filter(Boolean).join('\n');
        normalized.push({ type: 'body', text: mergedText, confidence: 98, children: [] });
      } else {
        normalized.push({
          type: text ? type : 'body',
          text: text || children.map((c) => c.text).join('\n'),
          confidence: 98,
          children: text ? children : [],
        });
      }
    });
    return postProcessSections(normalized);
  }

  function parseAISectionsResponse(rawText) {
    if (!rawText) return [];
    let cleaned = rawText.trim();
    // Strip markdown code fences if present
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && Array.isArray(parsed.sections)) {
        return normalizeAISections(parsed.sections);
      }
      if (Array.isArray(parsed)) {
        return normalizeAISections(parsed);
      }
    } catch (_) {
      // Fallback to plain-text structure if model did not emit valid JSON
    }
    return fallbackStructure(rawText);
  }

  async function recognizeWithAI(imageSource, options = {}) {
    const { apiKey, lang = currentLang, onProgress } = options;
    const cleanKey = (apiKey || '').trim();
    if (!cleanKey) {
      throw new Error('กรุณาใส่ Gemini API Key ก่อนใช้งาน AI OCR');
    }

    onProgress?.(15, 'กำลังเตรียมภาพสำหรับ AI...');
    const base64Data = imageSourceToJpegBase64(imageSource, 2048);

    const buildBody = (useSchema = true) => ({
      contents: [
        {
          parts: [
            { text: buildAIOCRPrompt(lang) },
            { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
          ],
        },
      ],
      generationConfig: useSchema
        ? {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                sections: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      type: { type: 'STRING', enum: ['h1', 'h2', 'h3', 'body'] },
                      text: { type: 'STRING' },
                      children: {
                        type: 'ARRAY',
                        items: {
                          type: 'OBJECT',
                          properties: {
                            type: { type: 'STRING', enum: ['body'] },
                            text: { type: 'STRING' },
                          },
                          required: ['type', 'text'],
                        },
                      },
                    },
                    required: ['type', 'text'],
                  },
                },
              },
              required: ['sections'],
            },
          }
        : { temperature: 0.1 },
    });

    const tried = new Set();
    const queue = [...AI_MODELS];
    let discovered = false;
    let lastError = null;
    let overloadRetriedOnce = false;
    let useSchema = true;

    const pushDiscoveredModels = async () => {
      if (discovered) return false;
      discovered = true;
      const liveModels = await discoverGeminiFlashModels(cleanKey);
      const fresh = liveModels.filter((m) => !tried.has(m)).slice(0, 5);
      fresh.forEach((m) => queue.push(m));
      return fresh.length > 0;
    };

    while (queue.length > 0) {
      const model = queue.shift();
      if (!model || tried.has(model)) continue;
      tried.add(model);

      onProgress?.(Math.min(75, 28 + tried.size * 10), `กำลังส่งให้ AI (${model}) อ่านข้อความ...`);

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': cleanKey,
          },
          body: JSON.stringify(buildBody(useSchema)),
        });
      } catch (netErr) {
        lastError = new Error(`การเชื่อมต่อขัดข้อง (${netErr.message || 'network'})`);
        await pushDiscoveredModels();
        continue;
      }

      if (res.ok) {
        onProgress?.(85, 'กำลังจัดโครงสร้างข้อความจาก AI...');
        const payload = await res.json();
        const candidate = payload?.candidates?.[0];
        const rawText = (candidate?.content?.parts || [])
          .map((p) => p.text || '')
          .join('\n')
          .trim();

        if (!rawText) {
          const finishReason = candidate?.finishReason || 'NO_OUTPUT';
          throw new Error(`AI ไม่พบข้อความในภาพ (${finishReason})`);
        }

        const sections = parseAISectionsResponse(rawText);
        const plainText = toPlainText(sections);
        const lineCount = plainText ? plainText.split('\n').filter((l) => l.trim()).length : 0;

        return {
          sections,
          text: plainText,
          lineCount,
          confidence: 98,
          model,
        };
      }

      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        errMsg = errJson?.error?.message || errMsg;
      } catch (_) {}

      const isAuthError =
        res.status === 401 ||
        res.status === 403 ||
        /API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|UNAUTHENTICATED/i.test(errMsg);

      if (isAuthError) {
        throw new Error(`Gemini API Key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้งาน (${errMsg})`);
      }

      const isSchemaError =
        res.status === 400 &&
        /responseSchema|response_schema|JSON mode|structured output/i.test(errMsg);

      if (isSchemaError && useSchema) {
        useSchema = false;
        tried.delete(model);
        queue.unshift(model);
        continue;
      }

      const isModelUnavailable =
        res.status === 404 ||
        /no longer available|not found|not supported for generateContent|deprecated/i.test(errMsg);

      const isOverloaded =
        res.status === 429 ||
        res.status === 503 ||
        /high demand|overloaded|try again later|resource exhausted|quota|unavailable/i.test(errMsg);

      if (isModelUnavailable) {
        lastError = new Error(errMsg);
        const recMatch = errMsg.match(/models\/(gemini-[a-z0-9.\-]+)/i);
        if (recMatch && !tried.has(recMatch[1])) {
          queue.unshift(recMatch[1]);
        }
        if (queue.length === 0) await pushDiscoveredModels();
        continue;
      }

      if (isOverloaded) {
        lastError = new Error('เซิร์ฟเวอร์ AI (Gemini) มีผู้ใช้งานหนาแน่นชั่วคราว กรุณารอสักครู่แล้วลองใหม่ หรือสลับใช้โหมด Tesseract ฟรีได้ทันที');
        onProgress?.(45, `Model ${model} โหลดหนัก กำลังลอง model อื่น...`);
        if (queue.length === 0) {
          const added = await pushDiscoveredModels();
          if (!added && !overloadRetriedOnce) {
            // One final retry on primary flash model after a brief cooldown
            overloadRetriedOnce = true;
            tried.delete(AI_MODELS[0]);
            queue.push(AI_MODELS[0]);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      lastError = new Error(`AI OCR ล้มเหลว: ${errMsg}`);
      if (queue.length === 0) await pushDiscoveredModels();
    }

    throw lastError || new Error('ไม่สามารถเชื่อมต่อ Gemini API ได้');
  }

  return {
    init,
    recognize,
    recognizeWithAI,
    parseAISectionsResponse,
    terminate,
    structureText,
    renderToDOM,
    toPlainText,
    preprocessImage,
    fixThaiSpaces,
    MODE_CONFIG,
    AI_MODELS,
    setLang: (l) => {
      if (currentLang !== l) isReady = false;
      currentLang = l;
    },
    setMode: (m) => { currentMode = m; },
    getMode: () => currentMode,
    isReady: () => isReady,
  };
})();
