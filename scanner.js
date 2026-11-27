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

  const MAX_IMAGE_DIM = 3000;

  // ── Convert Canvas to ImageElement cleanly ────────────────────
  function canvasToImage(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('ไม่สามารถแปลงภาพได้'));
          return;
        }
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = (e) => {
          URL.revokeObjectURL(url);
          reject(e);
        };
        img.src = url;
      }, 'image/jpeg', 0.94);
    });
  }

  // ── Load image from File (EXIF-safe & mobile RAM-safe) ────────
  async function loadImageFile(file) {
    // Prefer createImageBitmap with explicit EXIF orientation handling on mobile
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const sw = bitmap.width;
        const sh = bitmap.height;
        const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(sw, sh));
        const dw = Math.max(1, Math.round(sw * scale));
        const dh = Math.max(1, Math.round(sh * scale));

        const canvas = document.createElement('canvas');
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, dw, dh);
        bitmap.close?.();
        return await canvasToImage(canvas);
      } catch (err) {
        console.warn('createImageBitmap fallback:', err);
      }
    }

    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = async () => {
        URL.revokeObjectURL(url);
        const sw = img.naturalWidth;
        const sh = img.naturalHeight;
        if (Math.max(sw, sh) > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(sw, sh);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(sw * scale));
          canvas.height = Math.max(1, Math.round(sh * scale));
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          try {
            resolve(await canvasToImage(canvas));
          } catch (e) {
            resolve(img);
          }
        } else {
          resolve(img);
        }
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    });
  }

  // ── Rotate ImageElement by ±90 degrees ────────────────────────
  async function rotateImage(imgElement, degrees) {
    const rad = (degrees * Math.PI) / 180;
    const sw = imgElement.naturalWidth || imgElement.width;
    const sh = imgElement.naturalHeight || imgElement.height;
    const swap = Math.abs(degrees) % 180 === 90;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? sh : sw;
    canvas.height = swap ? sw : sh;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(imgElement, -sw / 2, -sh / 2);
    return await canvasToImage(canvas);
  }

  // ── Detect document edges using OpenCV.js ─────────────────────
  function detectDocumentCorners(imgElement, canvasEl) {
    if (!window.cv || !window.cv.imread) {
      console.warn('OpenCV not loaded, using fallback corners');
      return getFullImageCorners(canvasEl);
    }

    let src, gray, blurred, edges, closed, contours, hierarchy, kernel;
    try {
      src = cv.imread(canvasEl);
      gray = new cv.Mat();
      blurred = new cv.Mat();
      edges = new cv.Mat();
      closed = new cv.Mat();
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));

      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      const minArea = src.cols * src.rows * 0.12;
      let bestCorners = null;
      let maxArea = 0;

      // Try two edge sensitivity passes to handle soft paper edges on mobile photos
      const thresholds = [[50, 150], [30, 100]];
      for (const [t1, t2] of thresholds) {
        cv.Canny(blurred, edges, t1, t2);
        cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
        cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        for (let i = 0; i < contours.size(); i++) {
          const cnt = contours.get(i);
          const area = cv.contourArea(cnt);
          if (area > minArea && area > maxArea) {
            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
            if (approx.rows === 4 && cv.isContourConvex(approx)) {
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
          }
          cnt.delete();
        }
        if (bestCorners) break;
      }

      if (bestCorners) {
        return sortCorners(bestCorners);
      }
      return getFullImageCorners(canvasEl);

    } catch (err) {
      console.error('OpenCV detection error:', err);
      return getFullImageCorners(canvasEl);
    } finally {
      try { src?.delete(); gray?.delete(); blurred?.delete(); edges?.delete(); closed?.delete(); contours?.delete(); hierarchy?.delete(); kernel?.delete(); } catch(e){}
    }
  }

  // ── Sort corners cleanly: TL, TR, BR, BL ──────────────────────
  function sortCorners(pts) {
    if (!pts || pts.length !== 4) return pts;
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = bySum[0];
    const br = bySum[3];
    const remaining = [bySum[1], bySum[2]].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    const tr = remaining[0];
    const bl = remaining[1];
    return [tl, tr, br, bl];
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
    const ordered = sortCorners(corners);
    const realCorners = ordered.map(c => ({
      x: c.x * displayScale.x,
      y: c.y * displayScale.y,
    }));

    // Compute output dimensions with mobile canvas memory guard
    const widthTop = Math.hypot(realCorners[1].x - realCorners[0].x, realCorners[1].y - realCorners[0].y);
    const widthBot = Math.hypot(realCorners[2].x - realCorners[3].x, realCorners[2].y - realCorners[3].y);
    const heightLeft = Math.hypot(realCorners[3].x - realCorners[0].x, realCorners[3].y - realCorners[0].y);
    const heightRight = Math.hypot(realCorners[2].x - realCorners[1].x, realCorners[2].y - realCorners[1].y);
    let outW = Math.max(20, Math.round(Math.max(widthTop, widthBot)));
    let outH = Math.max(20, Math.round(Math.max(heightLeft, heightRight)));

    const maxOutDim = 2800;
    if (Math.max(outW, outH) > maxOutDim) {
      const capScale = maxOutDim / Math.max(outW, outH);
      outW = Math.max(20, Math.round(outW * capScale));
      outH = Math.max(20, Math.round(outH * capScale));
    }

    if (!window.cv || !window.cv.getPerspectiveTransform) {
      return warpFallback(srcImgEl, ordered);
    }

    // Temp canvas with original image
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = srcImgEl.naturalWidth;
    tmpCanvas.height = srcImgEl.naturalHeight;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(srcImgEl, 0, 0);

    let src, dst, M, srcPts, dstPts;
    try {
      src = cv.imread(tmpCanvas);
      dst = new cv.Mat();

      srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        realCorners[0].x, realCorners[0].y,
        realCorners[1].x, realCorners[1].y,
        realCorners[2].x, realCorners[2].y,
        realCorners[3].x, realCorners[3].y,
      ]);
      dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, outW, 0, outW, outH, 0, outH,
      ]);

      M = cv.getPerspectiveTransform(srcPts, dstPts);
      cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_CUBIC);

      const outCanvas = document.createElement('canvas');
      outCanvas.width = outW;
      outCanvas.height = outH;
      cv.imshow(outCanvas, dst);
      return outCanvas;

    } catch (err) {
      console.error('Warp error:', err);
      return warpFallback(srcImgEl, ordered);
    } finally {
      try { src?.delete(); dst?.delete(); M?.delete(); srcPts?.delete(); dstPts?.delete(); } catch (e) {}
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
    const minX = Math.max(0, Math.min(...xs));
    const maxX = Math.min(srcImgEl.naturalWidth, Math.max(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxY = Math.min(srcImgEl.naturalHeight, Math.max(...ys));
    const sw = Math.max(20, maxX - minX);
    const sh = Math.max(20, maxY - minY);

    const scale = Math.min(1, 2800 / Math.max(sw, sh));
    const outCanvas = document.createElement('canvas');
    outCanvas.width = Math.max(20, Math.round(sw * scale));
    outCanvas.height = Math.max(20, Math.round(sh * scale));
    const ctx = outCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcImgEl, minX, minY, sw, sh, 0, 0, outCanvas.width, outCanvas.height);
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
    rotateImage,
    detectDocumentCorners,
    setupCanvas,
    warpPerspective,
    drawOverlay,
    setupDraggable,
    getDisplayScale: () => displayScale,
  };
})();
