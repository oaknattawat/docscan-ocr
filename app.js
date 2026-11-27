/**
 * app.js — Main application orchestrator
 * State machine: idle → loaded → detected → cropped → ocr → done
 */

(async function AppMain() {
  // ════════════════════════════════════════════════════════════
  // DOM REFERENCES
  // ════════════════════════════════════════════════════════════
  const $ = (id) => document.getElementById(id);

  const uploadZone       = $('upload-zone');
  const fileInput        = $('file-input');
  const cameraInput      = $('camera-input');
  const cameraBtn        = $('camera-btn');
  const cameraModal      = $('camera-modal');
  const cameraVideo      = $('camera-video');
  const captureBtn       = $('capture-btn');
  const closeCameraBtn   = $('close-camera');
  const originalCanvas   = $('original-canvas');
  const overlayCanvas    = $('overlay-canvas');
  const croppedCanvas    = $('cropped-canvas');
  const detectBtn        = $('detect-btn');
  const cropBtn          = $('crop-btn');
  const resetBtn         = $('reset-btn');
  const ocrBtn           = $('ocr-btn');
  const copyBtn          = $('copy-btn');
  const downloadBtn      = $('download-btn');
  const clearResultBtn   = $('clear-result-btn');
  const progressWrap     = $('progress-wrap');
  const progressBar      = $('progress-bar');
  const progressLabel    = $('progress-label-text');
  const progressPct      = $('progress-pct');
  const statusDot        = $('status-dot');
  const statusText       = $('status-text');
  const resultBody       = $('result-body');
  const toastContainer   = $('toast-container');
  const ocrCard          = $('ocr-card');
  const originalPlaceholder = $('original-placeholder');
  const croppedPlaceholder  = $('cropped-placeholder');
  const langBtns         = document.querySelectorAll('.lang-btn');
  const ocrModeBtns      = document.querySelectorAll('.ocr-mode-btn');
  const ocrModeDesc      = $('ocr-mode-desc');
  const confidenceBadge  = $('confidence-badge');
  const wordCountEl      = $('word-count');
  const lineCountEl      = $('line-count');
  // PDF / DOCX UI refs
  const imageTools       = $('image-tools');
  const imageHint        = $('image-hint');
  const pdfNav           = $('pdf-nav');
  const docxPanel        = $('docx-panel');
  const filetypeBadge    = $('filetype-badge');
  const pdfPrevBtn       = $('pdf-prev');
  const pdfNextBtn       = $('pdf-next');
  const pdfCurrentPageEl = $('pdf-current-page');
  const pdfTotalPagesEl  = $('pdf-total-pages');
  const pdfExtractBtn    = $('pdf-extract-btn');
  const pdfOcrBtn        = $('pdf-ocr-btn');
  const docxExtractBtn   = $('docx-extract-btn');

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let state = 'idle'; // idle | loaded | detected | cropped | ocr | done
  let fileMode = 'image'; // 'image' | 'pdf' | 'docx'
  let loadedImage = null;
  let currentCorners = null;
  let croppedCanvasData = null;
  let structuredSections = null;
  let ocrWorkerReady = false;
  let selectedLang = 'tha+eng';
  let cameraStream = null;
  // PDF-specific
  let pdfDoc = null;        // DocumentLoader PDF object
  let pdfCurrentPage = 1;
  let pdfTotalPages = 1;

  // ════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════
  function setStatus(type, text) {
    statusDot.className = `status-dot ${type}`;
    statusText.textContent = text;
  }

  function showToast(message, type = 'info', duration = 3500) {
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function setProgress(pct, label) {
    progressWrap.classList.add('visible');
    if (pct !== null) {
      progressBar.style.width = pct + '%';
      progressPct.textContent = pct + '%';
    }
    if (label) progressLabel.textContent = label;
  }

  function hideProgress() {
    progressWrap.classList.remove('visible');
    progressBar.style.width = '0%';
  }

  function updateButtons() {
    const isImage = fileMode === 'image';
    const isPdf   = fileMode === 'pdf';
    // Image mode buttons
    detectBtn.disabled = isImage ? (state === 'idle') : true;
    cropBtn.disabled   = isImage ? (state !== 'detected' && state !== 'cropped') : true;
    // OCR button: image (cropped/done) or pdf-ocr
    ocrBtn.disabled    = isImage ? (state !== 'cropped' && state !== 'done')
                       : isPdf   ? (state === 'idle')
                       : true; // docx uses its own button
    copyBtn.disabled     = (state !== 'done');
    downloadBtn.disabled = (state !== 'done');
    resetBtn.disabled    = (state === 'idle');
    // PDF nav
    if (isPdf && pdfDoc) {
      pdfPrevBtn.disabled = pdfCurrentPage <= 1;
      pdfNextBtn.disabled = pdfCurrentPage >= pdfTotalPages;
    }
  }

  function showCanvas(canvasId, placeholderId) {
    $(canvasId).style.display = 'block';
    $(placeholderId).style.display = 'none';
  }

  function hideCanvas(canvasId, placeholderId) {
    $(canvasId).style.display = 'none';
    $(placeholderId).style.display = 'flex';
  }

  // ════════════════════════════════════════════════════════════
  // LANGUAGE & OCR MODE TOGGLE
  // ════════════════════════════════════════════════════════════
  langBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      langBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLang = btn.dataset.lang;
      OCREngine.setLang(selectedLang);
      showToast(`เปลี่ยนภาษา: ${btn.textContent}`, 'info', 2000);
    });
  });

  ocrModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      ocrModeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      OCREngine.setMode(mode);
      if (ocrModeDesc && OCREngine.MODE_CONFIG[mode]) {
        ocrModeDesc.textContent = OCREngine.MODE_CONFIG[mode].desc;
      }
      showToast(`โหมด OCR: ${btn.textContent}`, 'info', 2000);
    });
  });

  // ════════════════════════════════════════════════════════════
  // FILE UPLOAD
  // ════════════════════════════════════════════════════════════
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  // ════════════════════════════════════════════════════════════
  // UI MODE SWITCHER
  // ════════════════════════════════════════════════════════════
  function setMode(mode) {
    fileMode = mode;
    // Show/hide tool panels
    const isImage  = mode === 'image';
    const isPDF    = mode === 'pdf';
    const isDirect = !isImage && !isPDF; // all doc types that go straight to extract

    imageTools.style.display  = isImage  ? 'flex'  : 'none';
    imageHint.style.display   = isImage  ? 'block' : 'none';
    pdfNav.style.display      = isPDF    ? 'block' : 'none';
    docxPanel.style.display   = isDirect ? 'block' : 'none';

    // Update dynamic DOCX panel labels for each file type
    const panelInfo = {
      docx: { icon: '📘', title: 'Word Document (.docx)',      desc: 'ดึงข้อความและโครงสร้างได้โดยตรง',      btn: '📘 ดึงข้อความ' },
      xlsx: { icon: '📗', title: 'Excel Spreadsheet (.xlsx)',   desc: 'อ่านข้อมูลทุก Sheet พร้อมการจัดรูปตาราง',  btn: '📗 ดึงข้อมูล Excel' },
      pptx: { icon: '📙', title: 'PowerPoint (.pptx)',          desc: 'อ่านข้อความจากทุกสไลด์พร้อมหัวข้อแต่ละหน้า',  btn: '📙 ดึงสไลด์ทั้งหมด' },
      odt:  { icon: '📄', title: 'OpenDocument Text (.odt)',    desc: 'ไฟล์เอกสารมาตรฐานเปิด LibreOffice/OpenOffice', btn: '📄 ดึงข้อความ' },
      ods:  { icon: '📊', title: 'OpenDocument Spreadsheet (.ods)', desc: 'ตารางข้อมูลมาตรฐานเปิด', btn: '📊 ดึงข้อมูล' },
      odp:  { icon: '🎬', title: 'OpenDocument Presentation (.odp)', desc: 'บทนำเสนอมาตรฐานเปิด', btn: '🎬 ดึงสไลด์' },
      txt:  { icon: '📝', title: 'Plain Text (.txt)',            desc: 'อ่านและวิเคราะห์โครงสร้างหัวข้ออัตโนมัติ',    btn: '📝 ดึงข้อความ' },
      csv:  { icon: '📊', title: 'CSV Spreadsheet (.csv)',       desc: 'แปลงข้อมูลเป็นตารางการแสดงผล',      btn: '📊 ดึงข้อมูล' },
      rtf:  { icon: '📃', title: 'Rich Text Format (.rtf)',      desc: 'แปลงและอ่านไฟล์ RTF',                   btn: '📃 ดึงข้อความ' },
      md:   { icon: '📋', title: 'Markdown (.md)',               desc: 'อ่าน # หัวข้อและโครงสร้างจาก Markdown',         btn: '📋 ดึงข้อความ' },
    };
    if (isDirect && panelInfo[mode]) {
      const p = panelInfo[mode];
      const iconEl = docxPanel.querySelector('.file-info-icon');
      if (iconEl) iconEl.textContent = p.icon;
      const titleEl = $('docx-panel-title');
      const descEl  = $('docx-panel-desc');
      if (titleEl) titleEl.textContent = p.title;
      if (descEl)  descEl.textContent  = p.desc;
      docxExtractBtn.textContent = p.btn;
    }

    // File type badge
    const meta = DocumentLoader.FILE_META[mode] || DocumentLoader.FILE_META['txt'];
    filetypeBadge.style.display = 'inline-flex';
    filetypeBadge.className = `filetype-badge ${meta.badge}`;
    filetypeBadge.textContent = meta.label;

    // Step 2 title
    const titles = {
      image: 'ตรวจจับ &amp; ตัดเอกสาร',
      pdf:   'ดูตัวอย่าง PDF',
    };
    $('step2-title').innerHTML = titles[mode] || `ดูตัวอย่างไฟล์`;
  }

  // ════════════════════════════════════════════════════════════
  // FILE UPLOAD — ROUTING BY TYPE
  // ════════════════════════════════════════════════════════════
  async function handleFile(file) {
    const fileType = DocumentLoader.detectFileType(file);
    if (fileType === 'image')  await handleImageFile(file);
    else if (fileType === 'pdf') await handlePDF(file);
    else if (fileType === 'unknown') showToast('ไม่รองรับประเภทไฟล์นี้', 'error');
    else await handleDirectExtract(file, fileType);
  }

  async function handleImageFile(file) {
    setMode('image');
    setStatus('loading', 'กำลังโหลดภาพ...');
    try {
      loadedImage = await Scanner.loadImageFile(file);
      await displayOriginal(loadedImage);
      state = 'loaded';
      updateButtons();
      setStatus('ready', 'โหลดภาพสำเร็จ — กด "ตรวจจับขอบ" หรือปรับจุดเอง');
      showToast('โหลดภาพสำเร็จ ✨', 'success', 2500);
    } catch (err) {
      setStatus('error', 'โหลดภาพล้มเหลว');
      showToast('ไม่สามารถโหลดภาพได้: ' + err.message, 'error');
    }
  }

  // ════════════════════════════════════════════════════════════
  // PDF HANDLER
  // ════════════════════════════════════════════════════════════
  async function handlePDF(file) {
    setMode('pdf');
    pdfDoc = null;
    pdfCurrentPage = 1;
    setStatus('loading', 'กำลังโหลด PDF...');
    setProgress(5, 'กำลังโหลด PDF...');

    try {
      pdfDoc = await DocumentLoader.loadPDF(file, (pct, label) => setProgress(pct, label));
      pdfTotalPages = pdfDoc.numPages;
      pdfTotalPagesEl.textContent = pdfTotalPages;
      pdfCurrentPageEl.textContent = 1;

      // Check embedded text on page 1
      const hasText = await pdfDoc.hasEmbeddedText(1);
      if (!hasText) {
        showToast('PDF นี้ดูเหมือนเป็นไฟล์สแกน — แนะนำให้ใช้ OCR หรือลองกด "ดึงข้อความ"', 'info', 4000);
      }
      // Always enable extract — let user try; extraction will show empty if truly no text
      pdfExtractBtn.disabled = false;
      pdfExtractBtn.title = '';

      await renderPDFPage(1);
      state = 'loaded';
      updateButtons();
      hideProgress();
      setStatus('ready', `โหลด PDF สำเร็จ — ${pdfTotalPages} หน้า | เลือก "ดึงข้อความ" หรือ "OCR"`);
      showToast(`โหลด PDF สำเร็จ — ${pdfTotalPages} หน้า 📕`, 'success');
    } catch (err) {
      console.error(err);
      hideProgress();
      setStatus('error', 'โหลด PDF ล้มเหลว');
      showToast('ไม่สามารถโหลด PDF ได้: ' + err.message, 'error', 5000);
    }
  }

  async function renderPDFPage(pageNum) {
    if (!pdfDoc) return;
    const canvas = await pdfDoc.renderPage(pageNum, 2.5);
    const ctx = originalCanvas.getContext('2d');
    const MAX_W = originalCanvas.parentElement?.clientWidth || 600;
    const scale = Math.min(MAX_W / canvas.width, 460 / canvas.height, 1);
    originalCanvas.width  = Math.round(canvas.width  * scale);
    originalCanvas.height = Math.round(canvas.height * scale);
    ctx.drawImage(canvas, 0, 0, originalCanvas.width, originalCanvas.height);
    originalCanvas.style.display = 'block';
    originalPlaceholder.style.display = 'none';
    overlayCanvas.style.display = 'none';
    // Store rendered canvas for OCR use
    croppedCanvasData = canvas;
    pdfCurrentPage = pageNum;
    pdfCurrentPageEl.textContent = pageNum;
    updateButtons();
  }

  // PDF Page navigation
  pdfPrevBtn.addEventListener('click', async () => {
    if (pdfCurrentPage > 1) {
      setStatus('loading', 'กำลังโหลดหน้า...');
      await renderPDFPage(pdfCurrentPage - 1);
      setStatus('ready', `หน้า ${pdfCurrentPage} / ${pdfTotalPages}`);
    }
  });

  pdfNextBtn.addEventListener('click', async () => {
    if (pdfCurrentPage < pdfTotalPages) {
      setStatus('loading', 'กำลังโหลดหน้า...');
      await renderPDFPage(pdfCurrentPage + 1);
      setStatus('ready', `หน้า ${pdfCurrentPage} / ${pdfTotalPages}`);
    }
  });

  // Extract embedded PDF text
  pdfExtractBtn.addEventListener('click', async () => {
    if (!pdfDoc) return;
    pdfExtractBtn.disabled = true;
    setStatus('loading', 'กำลังดึงข้อความ...');
    setProgress(20, 'กำลังดึงข้อความจาก PDF...');
    showSkeleton();

    try {
      const lines = await pdfDoc.extractPageText(pdfCurrentPage);
      setProgress(70, 'กำลังจัดโครงสร้าง...');

      if (!lines || lines.length === 0) {
        // No text found — suggest OCR
        hideProgress();
        resultBody.innerHTML = `
          <div class="result-empty">
            <span class="em-icon">📄</span>
            <p>ไม่พบข้อความฝังในหน้านี้<br><small style="color:var(--text-secondary)">ลองกดปุ่ม "🤖 OCR (ภาพสแกน)" แทน สำหรับ PDF ที่สแกนมา</small></p>
          </div>`;
        setStatus('ready', 'ไม่พบข้อความฝัง — ลองใช้ OCR แทน');
        showToast('ไม่พบข้อความดิจิทัลในหน้านี้ — ลองใช้ OCR', 'info', 4000);
        pdfExtractBtn.disabled = false;
        return;
      }

      structuredSections = DocumentLoader.structurePDFLines(lines);
      OCREngine.renderToDOM(structuredSections, resultBody);

      const words = DocumentLoader.countWords(structuredSections);
      const linesCount = DocumentLoader.countLines(structuredSections);
      wordCountEl.textContent = words.toLocaleString();
      lineCountEl.textContent = linesCount.toLocaleString();
      confidenceBadge.textContent = '📄 ข้อความดิจิทัล';
      confidenceBadge.className = 'confidence-badge confidence-high';

      state = 'done';
      updateButtons();
      hideProgress();
      setStatus('ready', `ดึงข้อความสำเร็จ — ${words} คำ ใน ${linesCount} บรรทัด`);
      showToast('ดึงข้อความสำเร็จ 🎉', 'success');
      $('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      hideProgress();
      setStatus('error', 'ดึงข้อความล้มเหลว');
      showToast('เกิดข้อผิดพลาด: ' + err.message, 'error');
    } finally {
      pdfExtractBtn.disabled = false;
    }
  });

  // OCR on current PDF page
  pdfOcrBtn.addEventListener('click', async () => {
    if (!croppedCanvasData) return;
    state = 'cropped'; // allow OCR
    fileMode = 'image'; // temporarily treat as image for OCR flow
    await runOCR();
    fileMode = 'pdf';
    updateButtons();
  });

  // ════════════════════════════════════════════════════════════
  // DIRECT EXTRACT HANDLER (DOCX, XLSX, PPTX, ODT, TXT, CSV, RTF, MD)
  // ════════════════════════════════════════════════════════════
  let _pendingDirectResult = null;
  let _pendingFileType = null;

  async function handleDirectExtract(file, fileType) {
    setMode(fileType);
    const meta = DocumentLoader.FILE_META[fileType] || DocumentLoader.FILE_META['txt'];
    setStatus('loading', `กำลังโหลด ${meta.label}...`);
    setProgress(5, `กำลังเตรียมการ...`);
    originalCanvas.style.display = 'none';
    originalPlaceholder.style.display = 'flex';
    overlayCanvas.style.display = 'none';
    originalPlaceholder.innerHTML = `
      <span class="ph-icon">${meta.label.split(' ')[0]}</span>
      <span style="text-align:center">${file.name}<br><small style="color:var(--text-muted)">${meta.label}</small></span>`;

    try {
      let result;
      const prog = (pct, label) => setProgress(pct, label);

      if (fileType === 'docx')      result = await DocumentLoader.loadDOCX(file, prog);
      else if (fileType === 'xlsx') result = await DocumentLoader.loadXLSX(file, prog);
      else if (fileType === 'pptx') result = await DocumentLoader.loadPPTX(file, prog);
      else if (fileType === 'odt' || fileType === 'ods' || fileType === 'odp')
                                    result = await DocumentLoader.loadODT(file, fileType, prog);
      else if (fileType === 'txt')  result = await DocumentLoader.loadTXT(file, prog);
      else if (fileType === 'csv')  result = await DocumentLoader.loadCSV(file, prog);
      else if (fileType === 'rtf')  result = await DocumentLoader.loadRTF(file, prog);
      else if (fileType === 'md')   result = await DocumentLoader.loadMarkdown(file, prog);
      else throw new Error('ไม่รองรับประเภทไฟล์นี้');

      _pendingDirectResult = result;
      _pendingFileType = fileType;
      state = 'loaded';
      updateButtons();
      hideProgress();
      setStatus('ready', `โหลดสำเร็จ — กดปุ่มด้านล่างเพื่อดึงข้อความ`);
      showToast(`โหลด ${meta.label} สำเร็จ ✨`, 'success');
    } catch (err) {
      hideProgress();
      setStatus('error', `โหลดไฟล์ล้มเหลว`);
      showToast(`ไม่สามารถโหลดไฟล์ได้: ${err.message}`, 'error', 5000);
    }
  }

  docxExtractBtn.addEventListener('click', () => {
    if (!_pendingDirectResult) return;
    const { sections } = _pendingDirectResult;
    const meta = DocumentLoader.FILE_META[_pendingFileType] || DocumentLoader.FILE_META['txt'];
    structuredSections = sections;
    OCREngine.renderToDOM(structuredSections, resultBody);

    const words = DocumentLoader.countWords(structuredSections);
    const linesCount = DocumentLoader.countLines(structuredSections);
    wordCountEl.textContent = words.toLocaleString();
    lineCountEl.textContent = linesCount.toLocaleString();
    confidenceBadge.textContent = `${meta.label}`;
    confidenceBadge.className = 'confidence-badge confidence-high';

    state = 'done';
    updateButtons();
    setStatus('ready', `ดึงข้อความสำเร็จ — ${words} คำ ใน ${linesCount} บรรทัด`);
    showToast(`ดึงข้อความจาก ${meta.label} สำเร็จ 🎉`, 'success');
    $('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function showSkeleton() {
    resultBody.innerHTML = `
      <div style="padding:20px">
        <div class="skeleton wide"></div>
        <div class="skeleton medium" style="margin-top:14px"></div>
        <div class="skeleton wide"></div>
        <div class="skeleton short" style="margin-top:14px"></div>
        <div class="skeleton wide"></div>
        <div class="skeleton medium"></div>
      </div>`;
  }


  async function displayOriginal(img) {
    // Reset overlay
    overlayCanvas.width = 0;
    overlayCanvas.height = 0;
    overlayCanvas.style.display = 'none';

    // Draw image to canvas
    Scanner.setupCanvas(img, originalCanvas);
    originalCanvas.style.display = 'block';
    originalPlaceholder.style.display = 'none';

    // Position overlay canvas exactly on top
    syncOverlay();
    currentCorners = null;
    croppedCanvasData = null;
  }

  function syncOverlay() {
    const r = originalCanvas.getBoundingClientRect();
    const p = originalCanvas.parentElement.getBoundingClientRect();
    overlayCanvas.width  = originalCanvas.width;
    overlayCanvas.height = originalCanvas.height;
    overlayCanvas.style.position = 'absolute';
    overlayCanvas.style.left   = (r.left - p.left) + 'px';
    overlayCanvas.style.top    = (r.top  - p.top)  + 'px';
    overlayCanvas.style.width  = r.width  + 'px';
    overlayCanvas.style.height = r.height + 'px';
    overlayCanvas.style.display = 'block';
    overlayCanvas.style.pointerEvents = 'all';
  }

  // ════════════════════════════════════════════════════════════
  // CAMERA
  // ════════════════════════════════════════════════════════════
  cameraBtn.addEventListener('click', openCamera);
  closeCameraBtn.addEventListener('click', closeCamera);
  captureBtn.addEventListener('click', capturePhoto);
  if (cameraInput) {
    cameraInput.addEventListener('change', (e) => {
      if (e.target.files[0]) {
        handleFile(e.target.files[0]);
        cameraInput.value = '';
      }
    });
  }

  async function openCamera() {
    // On mobile HTTP LAN or unsupported browsers, navigator.mediaDevices is unavailable;
    // fall back to native OS camera input (<input capture="environment">).
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (cameraInput) {
        cameraInput.click();
      } else {
        showToast('เบราว์เซอร์ไม่รองรับการเปิดกล้องโดยตรง กรุณาอัปโหลดภาพแทน', 'error');
      }
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      cameraVideo.srcObject = cameraStream;
      cameraModal.classList.add('open');
    } catch (err) {
      // Fallback to native camera picker on mobile/insecure context
      if (cameraInput && (!window.isSecureContext || err.name === 'NotAllowedError' || err.name === 'NotSupportedError')) {
        cameraInput.click();
      } else {
        showToast('ไม่สามารถเข้าถึงกล้องได้: ' + err.message, 'error');
      }
    }
  }

  function closeCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    cameraModal.classList.remove('open');
  }

  function capturePhoto() {
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width  = cameraVideo.videoWidth;
    tmpCanvas.height = cameraVideo.videoHeight;
    tmpCanvas.getContext('2d').drawImage(cameraVideo, 0, 0);
    tmpCanvas.toBlob(async (blob) => {
      closeCamera();
      await handleFile(new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.95);
  }

  // ════════════════════════════════════════════════════════════
  // DETECT DOCUMENT EDGES
  // ════════════════════════════════════════════════════════════
  detectBtn.addEventListener('click', detectEdges);

  async function detectEdges() {
    if (!loadedImage) return;
    setStatus('loading', 'กำลังตรวจจับขอบเอกสาร...');
    detectBtn.disabled = true;

    // Small delay to let UI update
    await new Promise(r => setTimeout(r, 50));

    try {
      currentCorners = Scanner.detectDocumentCorners(loadedImage, originalCanvas);
      syncOverlay();
      Scanner.drawOverlay(overlayCanvas, currentCorners);
      setupCornerDrag();
      state = 'detected';
      updateButtons();
      setStatus('ready', 'ตรวจพบขอบเอกสาร — ลากจุดเพื่อปรับ หรือกด "ตัดเอกสาร"');
      showToast('ตรวจพบขอบเอกสาร 🎯', 'success');
    } catch (err) {
      setStatus('error', 'ตรวจจับล้มเหลว');
      showToast('เกิดข้อผิดพลาด: ' + err.message, 'error');
    } finally {
      detectBtn.disabled = false;
      updateButtons();
    }
  }

  function setupCornerDrag() {
    Scanner.setupDraggable(overlayCanvas, currentCorners, (updated, activeIndex) => {
      currentCorners = updated;
      Scanner.drawOverlay(overlayCanvas, currentCorners, activeIndex);
    });
  }

  // ════════════════════════════════════════════════════════════
  // CROP / WARP
  // ════════════════════════════════════════════════════════════
  cropBtn.addEventListener('click', cropDocument);

  async function cropDocument() {
    if (!loadedImage || !currentCorners) return;
    setStatus('loading', 'กำลังตัดเอกสาร...');
    cropBtn.disabled = true;

    await new Promise(r => setTimeout(r, 50));

    try {
      const result = Scanner.warpPerspective(loadedImage, currentCorners);
      croppedCanvasData = result;

      // Display in cropped canvas
      const ctx = croppedCanvas.getContext('2d');
      const MAX_W = croppedCanvas.parentElement?.clientWidth || 600;
      const scale = Math.min(MAX_W / result.width, 460 / result.height, 1);
      croppedCanvas.width  = Math.round(result.width  * scale);
      croppedCanvas.height = Math.round(result.height * scale);
      ctx.drawImage(result, 0, 0, croppedCanvas.width, croppedCanvas.height);

      showCanvas('cropped-canvas', 'cropped-placeholder');
      state = 'cropped';
      updateButtons();
      setStatus('ready', 'ตัดเอกสารสำเร็จ — กด "เริ่ม OCR" เพื่ออ่านข้อความ');
      showToast('ตัดเอกสารสำเร็จ ✂️', 'success');
      ocrCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      setStatus('error', 'ตัดเอกสารล้มเหลว');
      showToast('เกิดข้อผิดพลาด: ' + err.message, 'error');
    } finally {
      cropBtn.disabled = false;
      updateButtons();
    }
  }

  // ════════════════════════════════════════════════════════════
  // OCR
  // ════════════════════════════════════════════════════════════
  ocrBtn.addEventListener('click', runOCR);

  async function runOCR() {
    const source = croppedCanvasData || originalCanvas;
    if (!source) return;

    setStatus('loading', 'กำลังเตรียม OCR engine...');
    ocrBtn.disabled = true;
    setProgress(5, 'กำลังเตรียม OCR engine...');

    // Render skeleton while loading
    showSkeleton();

    try {
      const progressCb = (pct, label) => {
        if (pct !== null) setProgress(pct, label || 'กำลังอ่านข้อความ ' + pct + '%...');
        else setProgress(null, label || 'กำลังประมวลผล...');
      };

      await OCREngine.init(selectedLang, progressCb);

      setProgress(10, 'กำลังวิเคราะห์ภาพ...');
      setStatus('loading', 'กำลังอ่านข้อความ...');

      const ocrData = await OCREngine.recognize(source, progressCb);

      setProgress(95, 'กำลังจัดโครงสร้างข้อความ...');

      // Structure text
      structuredSections = OCREngine.structureText(ocrData);

      // Render result
      OCREngine.renderToDOM(structuredSections, resultBody);

      // Update stats (use Intl.Segmenter for accurate Thai word counting when supported)
      const allText = ocrData.text || '';
      let words = 0;
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter('th', { granularity: 'word' });
        for (const item of seg.segment(allText)) {
          if (item.isWordLike) words++;
        }
      } else {
        words = allText.trim().split(/\s+/).filter(Boolean).length;
      }
      const linesCount = (ocrData.lines || []).length;
      const avgConf = Math.round(ocrData.confidence || 0);
      const modeLabel = OCREngine.MODE_CONFIG[ocrData._ocrMode]?.label || '';

      wordCountEl.textContent = words.toLocaleString();
      lineCountEl.textContent = linesCount.toLocaleString();

      confidenceBadge.textContent = `ความแม่นยำ ${avgConf}%${modeLabel ? ' · ' + modeLabel : ''}`;
      confidenceBadge.className = `confidence-badge ${avgConf >= 80 ? 'confidence-high' : avgConf >= 60 ? 'confidence-mid' : 'confidence-low'}`;

      state = 'done';
      updateButtons();
      hideProgress();
      setStatus('ready', `OCR เสร็จสิ้น (${modeLabel || 'auto'}) — พบ ${words} คำ ใน ${linesCount} บรรทัด`);
      showToast('อ่านข้อความสำเร็จ 🎉', 'success');

      // Scroll to result
      $('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
      console.error('OCR error:', err);
      resultBody.innerHTML = `
        <div class="result-empty">
          <span class="em-icon">⚠️</span>
          <p>เกิดข้อผิดพลาดในการ OCR<br><small style="color:var(--accent-red)">${err.message}</small></p>
        </div>`;
      setStatus('error', 'OCR ล้มเหลว');
      showToast('OCR ล้มเหลว: ' + err.message, 'error', 5000);
      hideProgress();
    } finally {
      ocrBtn.disabled = false;
      updateButtons();
    }
  }

  // ════════════════════════════════════════════════════════════
  // COPY / DOWNLOAD
  // ════════════════════════════════════════════════════════════
  copyBtn.addEventListener('click', async () => {
    if (!structuredSections) return;
    const text = OCREngine.toPlainText(structuredSections);
    try {
      await navigator.clipboard.writeText(text);
      showToast('คัดลอกข้อความแล้ว 📋', 'success');
    } catch {
      showToast('ไม่สามารถคัดลอกได้ กรุณาคัดลอกด้วยตนเอง', 'error');
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!structuredSections) return;
    const text = OCREngine.toPlainText(structuredSections);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ocr_result.txt';
    a.click();
    URL.revokeObjectURL(url);
    showToast('ดาวน์โหลดไฟล์แล้ว ⬇️', 'success');
  });

  clearResultBtn.addEventListener('click', () => {
    structuredSections = null;
    resultBody.innerHTML = `
      <div class="result-empty">
        <span class="em-icon">📄</span>
        <p>ผลลัพธ์ OCR จะแสดงที่นี่<br>หลังจากกด "เริ่ม OCR"</p>
      </div>`;
    wordCountEl.textContent = '—';
    lineCountEl.textContent = '—';
    confidenceBadge.textContent = '';
    confidenceBadge.className = 'confidence-badge';
    if (state === 'done') {
      state = fileMode === 'image' ? (croppedCanvasData ? 'cropped' : 'loaded') : 'loaded';
      updateButtons();
    }
    showToast('ล้างผลลัพธ์แล้ว', 'info', 2000);
  });

  // ════════════════════════════════════════════════════════════
  // RESET
  // ════════════════════════════════════════════════════════════
  resetBtn.addEventListener('click', resetAll);

  function resetAll() {
    loadedImage = null;
    currentCorners = null;
    croppedCanvasData = null;
    structuredSections = null;
    pdfDoc = null;
    pdfCurrentPage = 1;
    pdfTotalPages = 1;
    _pendingDirectResult = null;
    _pendingFileType = null;
    state = 'idle';
    setMode('image');
    filetypeBadge.style.display = 'none';

    // Clear canvases
    const ctxO = originalCanvas.getContext('2d');
    ctxO.clearRect(0, 0, originalCanvas.width, originalCanvas.height);
    originalCanvas.width = 0;
    hideCanvas('original-canvas', 'original-placeholder');

    const ctxC = croppedCanvas.getContext('2d');
    ctxC.clearRect(0, 0, croppedCanvas.width, croppedCanvas.height);
    croppedCanvas.width = 0;
    hideCanvas('cropped-canvas', 'cropped-placeholder');

    const ctxOv = overlayCanvas.getContext('2d');
    ctxOv.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCanvas.style.display = 'none';

    // Clear result
    resultBody.innerHTML = `
      <div class="result-empty">
        <span class="em-icon">📄</span>
        <p>ผลลัพธ์ OCR จะแสดงที่นี่<br>หลังจากกด "เริ่ม OCR"</p>
      </div>`;
    wordCountEl.textContent = '—';
    lineCountEl.textContent = '—';
    confidenceBadge.textContent = '';
    confidenceBadge.className = 'confidence-badge';

    fileInput.value = '';
    hideProgress();
    setStatus('', 'รอภาพเอกสาร...');
    updateButtons();
    showToast('รีเซ็ตเรียบร้อย', 'info', 2000);
  }

  // ════════════════════════════════════════════════════════════
  // RESIZE HANDLER (keep overlay in sync)
  // ════════════════════════════════════════════════════════════
  const handleLayoutSync = () => {
    if (state !== 'idle' && loadedImage) {
      requestAnimationFrame(() => {
        syncOverlay();
        if (currentCorners) Scanner.drawOverlay(overlayCanvas, currentCorners);
      });
    }
  };
  window.addEventListener('resize', handleLayoutSync);
  window.addEventListener('orientationchange', () => setTimeout(handleLayoutSync, 150));

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════
  updateButtons();
  setStatus('', 'รอภาพเอกสาร...');
  hideProgress();

  // Pre-warm: start loading OpenCV in background (non-blocking)
  if (window.cv && window.cv.getBuildInformation) {
    setStatus('ready', 'OpenCV พร้อมใช้งาน');
  }

})();
