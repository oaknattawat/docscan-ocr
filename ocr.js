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

    // Only rotate if skew is meaningful (>= 0.7°) and clearly sharper than 0°
    if (Math.abs(bestAngle) < 0.7 || bestScore < zeroScore * 1.12) {
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
   * Light preprocessing: deskew + upscale + white padding + gentle shadow balance & crisp sharpening.
   * Preserves colored banners, highlighters, and fine Thai diacritics.
   */
  function preprocessLight(source) {
    const rawCanvas = getSourceCanvas(source);
    if (!rawCanvas) return source;
    const srcCanvas = autoDeskewCanvas(rawCanvas);

    const outCanvas = scaleAndPadCanvas(srcCanvas, 2200, 3000, 24);
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
   * Document preprocessing: deskew + grayscale + contrast normalize + soft background whitening
   * Keeps anti-aliased grayscale strokes intact for Tesseract LSTM (avoids harsh 0/255 damage).
   */
  function preprocessDocument(source) {
    const rawCanvas = getSourceCanvas(source);
    if (!rawCanvas) return source;
    const srcCanvas = autoDeskewCanvas(rawCanvas);

    const procCanvas = scaleAndPadCanvas(srcCanvas, 2000, 3000, 24);
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

    // Contrast stretch (0.5% - 99.5%)
    let minVal = -1;
    let maxVal = 255;
    const totalPixels = w * h;
    let cumSum = 0;
    for (let i = 0; i < 256; i++) {
      cumSum += histogram[i];
      if (minVal === -1 && cumSum >= totalPixels * 0.005) minVal = i;
      if (cumSum >= totalPixels * 0.995) { maxVal = i; break; }
    }
    if (minVal === -1) minVal = 0;
    const range = maxVal - minVal || 1;
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, Math.round(((gray[i] - minVal) * 255) / range)));
    }

    // Integral image for local mean background estimation
    const blockSize = Math.min(91, Math.max(41, (Math.round(w / 35) | 1)));
    const halfBlock = Math.floor(blockSize / 2);
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
      }
    }

    // Soft background whitening: push shadow/paper to 255, preserve smooth dark strokes
    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - halfBlock);
      const y2 = Math.min(h - 1, y + halfBlock);
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - halfBlock);
        const x2 = Math.min(w - 1, x + halfBlock);
        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum = integral[(y2 + 1) * (w + 1) + (x2 + 1)]
                  - integral[y1 * (w + 1) + (x2 + 1)]
                  - integral[(y2 + 1) * (w + 1) + x1]
                  + integral[y1 * (w + 1) + x1];
        const localMean = sum / count;

        const g = gray[y * w + x];
        let val;
        if (g < 65) {
          val = g;
        } else if (g >= localMean - 8 && g > 130) {
          val = 255;
        } else {
          // Smoothly darken ink relative to local background
          const thresh = Math.max(localMean - 8, 80);
          val = Math.max(0, Math.min(255, Math.round((g / thresh) * 210)));
        }

        const pi = (y * w + x) * 4;
        data[pi] = data[pi + 1] = data[pi + 2] = val;
        data[pi + 3] = 255;
      }
    }

    sharpenImageData(imageData, 0.35, 10);
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
    if (conf < 22) return true;

    const alnumMatches = t.match(/[\u0E00-\u0E7FA-Za-z0-9]/g) || [];
    if (alnumMatches.length === 0) return true;

    // Filter short lines with low confidence or mostly garbage symbols
    const symbolRatio = 1 - (alnumMatches.length / t.length);
    if (t.length <= 6 && conf < 40 && symbolRatio > 0.35) return true;
    if (symbolRatio > 0.65 && conf < 55) return true;

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

          const seg = {
            text,
            bbox: { x0, y0, x1, y1 },
            confidence: avgConf,
            fontSize: Math.max(y1 - y0, lineH),
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

  function structureText(ocrData) {
    const blocks = ocrData?._blocks;
    if (blocks && blocks.length > 0) {
      return structureFromBlocks(blocks);
    }

    if (!ocrData || !ocrData.lines || ocrData.lines.length === 0) {
      return fallbackStructure(ocrData?.text || '');
    }

    const lines = ocrData.lines;
    const fontSizes = lines.map(l => estimateFontSize(l)).filter(s => s > 0);
    const medianSize = percentile(fontSizes, 50);
    const p75 = percentile(fontSizes, 75);
    const p90 = percentile(fontSizes, 90);

    const sections = [];
    let currentSection = null;

    lines.forEach((line) => {
      const text = line.text?.trim();
      if (!text || text.length < 2) return;

      const fontSize = estimateFontSize(line);
      const confidence = line.confidence || 0;
      const type = classifyLine(text, fontSize, medianSize, p75, p90, confidence);

      if (type === 'h1' || type === 'h2' || type === 'h3') {
        currentSection = { type, text, confidence, children: [] };
        sections.push(currentSection);
      } else {
        if (currentSection) {
          currentSection.children.push({ type: 'body', text, confidence });
        } else {
          sections.push({ type: 'body', text, confidence, children: [] });
        }
      }
    });

    return mergeBodyLines(sections);
  }

  /**
   * Structure text while keeping each visual block/card grouped together.
   */
  function structureFromBlocks(blocks) {
    const allLines = blocks.flatMap(b => b.lines);
    const fontSizes = allLines.map(l => estimateFontSize(l)).filter(s => s > 0);
    const medianSize = percentile(fontSizes, 50);
    const p75 = percentile(fontSizes, 75);
    const p90 = percentile(fontSizes, 90);

    const sections = [];

    blocks.forEach(block => {
      const lines = block.lines;
      if (!lines.length) return;

      let currentSection = null;

      lines.forEach((line, idx) => {
        const text = line.text?.trim();
        if (!text || text.length < 2) return;

        const fontSize = estimateFontSize(line);
        const confidence = line.confidence || 0;
        let type = classifyLine(text, fontSize, medianSize, p75, p90, confidence);

        // Inside a multi-line card/box, promote a short non-bullet first line to heading
        if (
          idx === 0 &&
          type === 'body' &&
          lines.length > 1 &&
          text.length <= 45 &&
          !/^[•\-▪▸►\*]/.test(text) &&
          !/^\d+[\.)\]]\s/.test(text)
        ) {
          type = 'h2';
        }

        if (type === 'h1' || type === 'h2' || type === 'h3') {
          currentSection = { type, text, confidence, children: [] };
          sections.push(currentSection);
        } else {
          if (currentSection) {
            currentSection.children.push({ type: 'body', text, confidence });
          } else {
            // Orphan body block
            currentSection = { type: 'body', text, confidence, children: [] };
            sections.push(currentSection);
          }
        }
      });
    });

    return mergeBodyLines(sections);
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

  function classifyLine(text, fontSize, medianSize, p75, p90, confidence) {
    const thaiHeadingPatterns = [
      /^(หัวข้อ|บทที่|ตอนที่|ส่วนที่|บทนำ|สรุป|ข้อที่|ข้อ\s*\d)/,
      /^(ชื่อ|ที่อยู่|วันที่|เรื่อง|เรียน|ถึง|จาก|ผู้ส่ง|ลงชื่อ)/,
      /^(ประกาศ|คำสั่ง|ระเบียบ|แบบ|รายงาน|รายละเอียด)/,
      /^(หลักการ|ลักษณะ|ประเภท|องค์ประกอบ|วิธี|ความหมาย|เพิ่มเติม)/,
    ];
    const engHeadingPatterns = [
      /^(SECTION|CHAPTER|PART|ARTICLE|CLAUSE|SCHEDULE|ANNEX)/i,
      /^(Name|Address|Date|Subject|To|From|Re:|Dear|Signed)/i,
      /^(Summary|Introduction|Conclusion|Overview|Objective)/i,
      /^\d+[\.)\]]\s+[A-ZÀ-Ö\u0E00-\u0E7F]/,
    ];

    const isAllCaps = text === text.toUpperCase() && /[A-Z]/.test(text) && text.length > 3;
    const isShort = text.length <= 60;
    const hasThaiHeading = thaiHeadingPatterns.some(r => r.test(text));
    const hasEngHeading = engHeadingPatterns.some(r => r.test(text));
    const relSize = medianSize > 0 ? fontSize / medianSize : 1;

    if ((fontSize >= p90 * 0.95 || relSize >= 1.55) && isShort) return 'h1';
    if ((fontSize >= p75 * 0.95 || relSize >= 1.25) && isShort) return 'h2';
    if (hasThaiHeading || hasEngHeading) return 'h2';
    if (isAllCaps && isShort) return 'h2';
    if (/^\d+[\.)\]]\s/.test(text) && isShort && relSize >= 1.05) return 'h3';
    if (/^[•\-▪▸►\*]\s/.test(text)) return 'bullet';
    return 'body';
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
    const sections = [];
    let currentSection = null;

    lines.forEach(line => {
      const isHeading =
        (line.length <= 60 && /^[A-ZÀ-Ö\u0E00-\u0E7F]/.test(line) && !/[.,:;]$/.test(line)) ||
        /^(หัวข้อ|บทที่|ตอนที่|SECTION|CHAPTER|Part)/i.test(line) ||
        (line === line.toUpperCase() && line.length > 3 && /[A-Z]/.test(line));

      if (isHeading) {
        currentSection = { type: 'h2', text: line, confidence: 0, children: [] };
        sections.push(currentSection);
      } else {
        if (currentSection) {
          const last = currentSection.children[currentSection.children.length - 1];
          if (last && last.type === 'body') last.text += '\n' + line;
          else currentSection.children.push({ type: 'body', text: line });
        } else {
          sections.push({ type: 'body', text: line, confidence: 0, children: [] });
        }
      }
    });
    return sections;
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

  const AI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

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
      '2. Preserve original Thai spelling, tone marks, vowels, numbers, and English words exactly. Do NOT summarize, translate, or paraphrase.',
      '3. Keep multi-column layouts, mind-map cards, or boxed sections grouped logically: each card/section heading followed by its own body lines inside children.',
      '4. Ignore purely decorative doodles/icons without text.',
      '5. Return valid JSON matching the schema: {"sections":[{"type":"h1"|"h2"|"h3"|"body","text":"...","children":[{"type":"body","text":"..."}]}]}.',
      '   - Use "h1" for main document/title headings, "h2" for card/box subheadings, "h3" for smaller subheadings, and "body" for content lines (join multiple lines in a section with \\n).',
    ].join('\n');
  }

  function normalizeAISections(rawSections) {
    if (!Array.isArray(rawSections)) return [];
    const normalized = [];
    rawSections.forEach((sec) => {
      if (!sec || typeof sec !== 'object') return;
      const text = String(sec.text || '').trim();
      const type = ['h1', 'h2', 'h3', 'body'].includes(sec.type) ? sec.type : 'body';
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
    return normalized;
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

    const requestBody = {
      contents: [
        {
          parts: [
            { text: buildAIOCRPrompt(lang) },
            { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
          ],
        },
      ],
      generationConfig: {
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
      },
    };

    let lastError = null;
    for (let i = 0; i < AI_MODELS.length; i++) {
      const model = AI_MODELS[i];
      onProgress?.(35 + i * 15, `กำลังส่งให้ AI (${model}) อ่านข้อความ...`);

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey,
        },
        body: JSON.stringify(requestBody),
      });

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

      if (res.status === 404 && i < AI_MODELS.length - 1) {
        lastError = new Error(errMsg);
        continue;
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new Error(`Gemini API Key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้งาน (${errMsg})`);
      }
      if (res.status === 429) {
        throw new Error('ใช้งานเกินโควต้าฟรีชั่วคราว กรุณารอสักครู่แล้วลองใหม่');
      }
      throw new Error(`AI OCR ล้มเหลว: ${errMsg}`);
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
