/**
 * scanner.js — Document edge detection & perspective correction
 * Uses OpenCV.js for contour detection and warp transform
 */

const Scanner = (() => {
  // State
  let originalImage = null;
  let detectedCorners = null;
  let userCorners = null;
  let overlayCanvas = null;
  let displayCanvas = null;
  let isDragging = false;
  let dragIndex = -1;
  let displayScale = { x: 1, y: 1 };

  // ── Load image from File ──────────────────────────────────────
  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ── Detect document edges using OpenCV.js ─────────────────────
  function detectDocumentCorners(imgElement, canvasEl) {
    if (!window.cv || !window.cv.imread) {
      console.warn('OpenCV not loaded, using fallback corners');
      return getFullImageCorners(canvasEl);
    }

    let src, gray, blurred, edges, contours, hierarchy;
    try {
      src = cv.imread(canvasEl);
      gray = new cv.Mat();
      blurred = new cv.Mat();
      edges = new cv.Mat();
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();

      // Convert to gray
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      // Gaussian blur
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      // Canny edge detection
      cv.Canny(blurred, edges, 75, 200);

      // Dilate edges slightly
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(edges, edges, kernel);
      kernel.delete();

      // Find contours
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let bestCorners = null;
      let maxArea = 0;

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        const peri = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

        if (approx.rows === 4 && area > maxArea && area > (src.cols * src.rows * 0.05)) {
          maxArea = area;
          bestCorners = [];
          for (let j = 0; j < 4; j++) {
            bestCorners.push({
              x: approx.data32S[j * 2],
              y: approx.data32S[j * 2 + 1]
            });
          }
        }
        approx.delete();
        cnt.delete();
      }

      src.delete(); gray.delete(); blurred.delete(); edges.delete();
      contours.delete(); hierarchy.delete();

      if (bestCorners) {
        return sortCorners(bestCorners);
      }
      return getFullImageCorners(canvasEl);

    } catch (err) {
      console.error('OpenCV detection error:', err);
      try { src.delete(); gray.delete(); blurred.delete(); edges.delete(); contours.delete(); hierarchy.delete(); } catch(e){}
      return getFullImageCorners(canvasEl);
    }
  }

  // ── Sort corners: TL, TR, BR, BL ─────────────────────────────
  function sortCorners(pts) {
    const center = {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    };
    const tl = pts.filter(p => p.x < center.x && p.y < center.y);
    const tr = pts.filter(p => p.x >= center.x && p.y < center.y);
    const br = pts.filter(p => p.x >= center.x && p.y >= center.y);
    const bl = pts.filter(p => p.x < center.x && p.y >= center.y);
    const pick = (arr, fallback) => arr.length ? arr[0] : fallback;
    const w = pts.reduce((m, p) => Math.max(m, p.x), 0);
    const h = pts.reduce((m, p) => Math.max(m, p.y), 0);
    return [
      pick(tl, { x: 0, y: 0 }),
      pick(tr, { x: w, y: 0 }),
      pick(br, { x: w, y: h }),
      pick(bl, { x: 0, y: h }),
    ];
  }

  // ── Fallback: full image corners ──────────────────────────────
  function getFullImageCorners(canvasEl) {
    const w = canvasEl.width;
    const h = canvasEl.height;
    const pad = Math.min(w, h) * 0.03;
    return [
      { x: pad, y: pad },
      { x: w - pad, y: pad },
      { x: w - pad, y: h - pad },
      { x: pad, y: h - pad },
    ];
  }

  // ── Draw image to canvas and detect ───────────────────────────
  function setupCanvas(imgElement, canvas) {
    const MAX_W = canvas.parentElement?.clientWidth || 600;
    const MAX_H = 460;
    let sw = imgElement.naturalWidth;
    let sh = imgElement.naturalHeight;
    const scale = Math.min(MAX_W / sw, MAX_H / sh, 1);
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    displayScale = { x: imgElement.naturalWidth / canvas.width, y: imgElement.naturalHeight / canvas.height };

    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
  }

  // ── Perspective warp using homography ─────────────────────────
  function warpPerspective(srcImgEl, corners) {
    if (!window.cv || !window.cv.getPerspectiveTransform) {
      return warpFallback(srcImgEl, corners);
    }

    const realCorners = corners.map(c => ({
      x: c.x * displayScale.x,
      y: c.y * displayScale.y,
    }));

    // Compute output dimensions
    const widthTop = Math.hypot(realCorners[1].x - realCorners[0].x, realCorners[1].y - realCorners[0].y);
    const widthBot = Math.hypot(realCorners[2].x - realCorners[3].x, realCorners[2].y - realCorners[3].y);
    const heightLeft = Math.hypot(realCorners[3].x - realCorners[0].x, realCorners[3].y - realCorners[0].y);
    const heightRight = Math.hypot(realCorners[2].x - realCorners[1].x, realCorners[2].y - realCorners[1].y);
    const outW = Math.round(Math.max(widthTop, widthBot));
    const outH = Math.round(Math.max(heightLeft, heightRight));

    // Temp canvas with original image
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = srcImgEl.naturalWidth;
    tmpCanvas.height = srcImgEl.naturalHeight;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(srcImgEl, 0, 0);

    let src, dst, M;
    try {
      src = cv.imread(tmpCanvas);
      dst = new cv.Mat();

      const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        realCorners[0].x, realCorners[0].y,
        realCorners[1].x, realCorners[1].y,
        realCorners[2].x, realCorners[2].y,
        realCorners[3].x, realCorners[3].y,
      ]);
      const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, outW, 0, outW, outH, 0, outH,
      ]);

      M = cv.getPerspectiveTransform(srcPts, dstPts);
      cv.warpPerspective(src, dst, M, new cv.Size(outW, outH));

      const outCanvas = document.createElement('canvas');
      outCanvas.width = outW;
      outCanvas.height = outH;
      cv.imshow(outCanvas, dst);

      src.delete(); dst.delete(); M.delete(); srcPts.delete(); dstPts.delete();
      return outCanvas;

    } catch (err) {
      console.error('Warp error:', err);
      try { src.delete(); dst.delete(); M.delete(); } catch (e) {}
      return warpFallback(srcImgEl, corners);
    }
  }

  // ── Fallback warp (simple crop using bounding box) ────────────
  function warpFallback(srcImgEl, corners) {
    const realCorners = corners.map(c => ({
      x: c.x * displayScale.x,
      y: c.y * displayScale.y,
    }));
    const xs = realCorners.map(c => c.x);
    const ys = realCorners.map(c => c.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const ctx = outCanvas.getContext('2d');
    ctx.drawImage(srcImgEl, minX, minY, w, h, 0, 0, w, h);
    return outCanvas;
  }

  // ── Draw overlay (polygon + corner handles) ───────────────────
  function drawOverlay(canvas, corners, activeIndex = -1) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!corners || corners.length < 4) return;

    // Semi polygon fill
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach((c, i) => { if (i > 0) ctx.lineTo(c.x, c.y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(99, 179, 237, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(99, 179, 237, 0.85)';
    ctx.lineWidth = Math.max(2, canvas.width * 0.004);
    ctx.setLineDash([6, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Corners (scale radius proportionally so handles stay crisp & touch-friendly)
    const baseR = Math.max(10, Math.min(16, canvas.width * 0.022));
    const labels = ['TL', 'TR', 'BR', 'BL'];
    corners.forEach((c, i) => {
      const isActive = i === activeIndex;
      const r = isActive ? baseR * 1.35 : baseR;

      if (isActive) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(99, 179, 237, 0.28)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#38bdf8' : 'rgba(99, 179, 237, 0.92)';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = 'white';
      ctx.font = `bold ${Math.max(8, Math.round(r * 0.75))}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labels[i], c.x, c.y);
    });
  }

  // ── Setup draggable corner handles ────────────────────────────
  function setupDraggable(canvas, corners, onUpdate) {
    if (canvas._dragCleanup) {
      canvas._dragCleanup();
    }

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      return {
        x: (touch.clientX - rect.left) * (canvas.width / rect.width),
        y: (touch.clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    const findNearest = (pos, isTouch) => {
      const threshold = isTouch
        ? Math.max(44, canvas.width * 0.09)
        : Math.max(25, canvas.width * 0.045);
      let closest = -1, minDist = threshold;
      corners.forEach((c, i) => {
        const d = Math.hypot(c.x - pos.x, c.y - pos.y);
        if (d < minDist) { minDist = d; closest = i; }
      });
      return closest;
    };

    const down = (e) => {
      const isTouch = e.type.startsWith('touch');
      const pos = getPos(e);
      dragIndex = findNearest(pos, isTouch);
      if (dragIndex >= 0) {
        isDragging = true;
        e.preventDefault();
        drawOverlay(canvas, corners, dragIndex);
      }
    };

    const move = (e) => {
      if (!isDragging || dragIndex < 0) return;
      e.preventDefault();
      const pos = getPos(e);
      corners[dragIndex] = {
        x: Math.max(0, Math.min(canvas.width, pos.x)),
        y: Math.max(0, Math.min(canvas.height, pos.y)),
      };
      onUpdate(corners, dragIndex);
    };

    const up = () => {
      if (isDragging) {
        isDragging = false;
        dragIndex = -1;
        drawOverlay(canvas, corners, -1);
      }
    };

    canvas.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('touchstart', down, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', up);
    canvas.addEventListener('touchcancel', up);

    canvas._dragCleanup = () => {
      canvas.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      canvas.removeEventListener('touchstart', down);
      canvas.removeEventListener('touchmove', move);
      canvas.removeEventListener('touchend', up);
      canvas.removeEventListener('touchcancel', up);
    };
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    loadImageFile,
    detectDocumentCorners,
    setupCanvas,
    warpPerspective,
    drawOverlay,
    setupDraggable,
    getDisplayScale: () => displayScale,
  };
})();
