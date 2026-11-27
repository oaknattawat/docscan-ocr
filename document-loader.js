/**
 * document-loader.js
 * Handles PDF, DOCX, XLSX, PPTX, TXT, CSV, RTF, ODT file loading
 * Provides canvas rendering, text extraction, and structure analysis
 */

const DocumentLoader = (() => {

  // ── CDN endpoints ─────────────────────────────────────────────
  const PDFJS_JS     = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const MAMMOTH_JS   = 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js';
  const XLSX_JS      = 'https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js';
  const JSZIP_JS     = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

  // ── Lazy-load a <script> tag ──────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`ไม่สามารถโหลด library: ${src.split('/').pop()}`));
      document.head.appendChild(s);
    });
  }

  async function ensurePDFJS()   { if (!window.pdfjsLib) { await loadScript(PDFJS_JS); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } }
  async function ensureMammoth() { if (!window.mammoth)   await loadScript(MAMMOTH_JS); }
  async function ensureXLSX()    { if (!window.XLSX)      await loadScript(XLSX_JS);    }
  async function ensureJSZip()   { if (!window.JSZip)     await loadScript(JSZIP_JS);   }

  // ════════════════════════════════════════════════════════════
  // FILE TYPE DETECTOR
  // ════════════════════════════════════════════════════════════
  function detectFileType(file) {
    const name = file.name.toLowerCase();
    const ext  = name.split('.').pop();
    const mime = file.type;

    if (mime.startsWith('image/') || ['jpg','jpeg','png','webp','bmp','gif','tiff','tif'].includes(ext))
      return 'image';
    if (ext === 'pdf' || mime === 'application/pdf')
      return 'pdf';
    if (['docx','doc'].includes(ext) || mime.includes('wordprocessingml') || mime.includes('msword'))
      return 'docx';
    if (['xlsx','xls'].includes(ext) || mime.includes('spreadsheetml') || mime.includes('ms-excel'))
      return 'xlsx';
    if (['pptx','ppt'].includes(ext) || mime.includes('presentationml') || mime.includes('ms-powerpoint'))
      return 'pptx';
    if (ext === 'odt' || mime === 'application/vnd.oasis.opendocument.text')
      return 'odt';
    if (ext === 'ods' || mime === 'application/vnd.oasis.opendocument.spreadsheet')
      return 'ods';
    if (ext === 'odp' || mime === 'application/vnd.oasis.opendocument.presentation')
      return 'odp';
    if (ext === 'txt' || mime === 'text/plain')
      return 'txt';
    if (ext === 'csv' || mime === 'text/csv')
      return 'csv';
    if (ext === 'rtf' || mime === 'application/rtf' || mime === 'text/rtf')
      return 'rtf';
    if (ext === 'md' || ext === 'markdown')
      return 'md';
    return 'unknown';
  }

  // ════════════════════════════════════════════════════════════
  // PDF LOADER
  // ════════════════════════════════════════════════════════════
  async function loadPDF(file, onProgress) {
    await ensurePDFJS();
    onProgress?.(5, 'กำลังโหลด PDF...');
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;
    onProgress?.(20, `พบ ${numPages} หน้า`);

    async function renderPage(pageNum, scale = 2.5) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return canvas;
    }

    async function extractPageText(pageNum) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      if (!content.items.length) return [];

      // Get font styles for sizing info
      const styles = content.styles || {};

      const buckets = {};
      content.items.forEach(item => {
        if (!item.str?.trim()) return;
        const y = Math.round(item.transform[5] / 8) * 8;
        if (!buckets[y]) buckets[y] = [];
        // Font size: use transform scale (transform[0] = scaleX), fallback to height, or style fontSize
        let fontSize = Math.abs(item.transform[0]) || Math.abs(item.height) || 12;
        if (fontSize < 1 && styles[item.fontName]) {
          fontSize = 12; // fallback for embedded fonts without size
        }
        buckets[y].push({ text: item.str, x: item.transform[4], fontSize });
      });
      return Object.keys(buckets).map(Number).sort((a, b) => b - a)
        .map(y => {
          const items = buckets[y].sort((a, b) => a.x - b.x);
          return { text: items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim(), fontSize: Math.max(...items.map(i => i.fontSize)) };
        }).filter(l => l.text.length > 0);
    }

    async function hasEmbeddedText(pageNum = 1) {
      try {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        // Check if any item has non-whitespace text
        const hasText = content.items.some(i => i.str?.trim().length > 0);
        return hasText;
      } catch (err) {
        console.warn('hasEmbeddedText error:', err);
        return true; // assume text exists on error, let user try extraction
      }
    }

    async function extractAllPagesText(onProgress) {
      const allLines = [];
      for (let p = 1; p <= numPages; p++) {
        onProgress?.(Math.round((p / numPages) * 90), `กำลังอ่านหน้า ${p}/${numPages}...`);
        const pageLines = await extractPageText(p);
        if (pageLines.length > 0) {
          allLines.push({ text: `── หน้า ${p} ──`, fontSize: 999 }); // page separator as heading
          allLines.push(...pageLines);
        }
      }
      return allLines;
    }

    return { type: 'pdf', numPages, renderPage, extractPageText, hasEmbeddedText, extractAllPagesText };
  }

  // ════════════════════════════════════════════════════════════
  // DOCX LOADER (mammoth.js)
  // ════════════════════════════════════════════════════════════
  async function loadDOCX(file, onProgress) {
    await ensureMammoth();
    onProgress?.(10, 'กำลังโหลดไฟล์ Word...');
    const arrayBuffer = await file.arrayBuffer();
    onProgress?.(40, 'กำลังแปลงเอกสาร...');
    const result = await mammoth.convertToHtml({ arrayBuffer });
    onProgress?.(80, 'กำลังวิเคราะห์โครงสร้าง...');
    const sections = parseDOCXHTML(result.value);
    onProgress?.(100, 'เสร็จสิ้น');
    return { type: 'docx', sections, rawHtml: result.value };
  }

  function parseDOCXHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const sections = [];
    let cur = null;
    doc.body.childNodes.forEach(node => {
      const tag  = node.tagName?.toLowerCase();
      const text = node.textContent?.trim();
      if (!tag || !text) return;
      if (tag === 'h1') { cur = { type: 'h1', text, children: [] }; sections.push(cur); }
      else if (tag === 'h2') { cur = { type: 'h2', text, children: [] }; sections.push(cur); }
      else if (['h3','h4','h5','h6'].includes(tag)) { cur = { type: 'h3', text, children: [] }; sections.push(cur); }
      else if (tag === 'p' || tag === 'div') {
        if (cur) { const last = cur.children[cur.children.length-1]; if (last?.type==='body') last.text += '\n'+text; else cur.children.push({type:'body',text}); }
        else sections.push({ type:'body', text, children:[] });
      } else if (tag === 'ul' || tag === 'ol') {
        const items = [...node.querySelectorAll('li')].map(li => `  • ${li.textContent.trim()}`).join('\n');
        const block = { type:'body', text:items };
        if (cur) cur.children.push(block); else sections.push({...block, children:[]});
      } else if (tag === 'table') {
        const rows = [...node.querySelectorAll('tr')].map(tr =>
          [...tr.querySelectorAll('td,th')].map(td => td.textContent.trim()).join(' │ '));
        const block = { type:'body', text:'┌─── ตาราง ───\n'+rows.join('\n')+'\n└─────────────' };
        if (cur) cur.children.push(block); else sections.push({...block, children:[]});
      }
    });
    return sections;
  }

  // ════════════════════════════════════════════════════════════
  // XLSX LOADER (SheetJS)
  // ════════════════════════════════════════════════════════════
  async function loadXLSX(file, onProgress) {
    await ensureXLSX();
    onProgress?.(10, 'กำลังโหลดไฟล์ Excel...');
    const arrayBuffer = await file.arrayBuffer();
    onProgress?.(40, 'กำลังอ่านข้อมูล...');
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    onProgress?.(70, 'กำลังแปลงข้อมูล...');

    const sections = [];
    workbook.SheetNames.forEach((sheetName, si) => {
      const sheet = workbook.Sheets[sheetName];
      // Sheet name as heading
      const sheetSection = { type: 'h1', text: `📊 ${sheetName}`, children: [] };

      // Convert to array of arrays
      const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (!aoa.length) { sheetSection.children.push({ type: 'body', text: '(ไม่มีข้อมูล)' }); sections.push(sheetSection); return; }

      // First non-empty row as header
      const headers = aoa[0].map(h => String(h).trim());
      const dataRows = aoa.slice(1).filter(row => row.some(cell => String(cell).trim()));

      if (headers.length > 0 && dataRows.length > 0) {
        // Build table text
        const colWidths = headers.map((h, i) => {
          const maxData = Math.max(...dataRows.map(r => String(r[i] ?? '').length));
          return Math.max(h.length, maxData, 4);
        });

        const pad = (str, w) => String(str ?? '').padEnd(w);
        const sep = '├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
        const topRow = '┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
        const botRow = '└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';
        const headerRow = '│ ' + headers.map((h, i) => pad(h, colWidths[i])).join(' │ ') + ' │';
        const dataRowsStr = dataRows.map(row =>
          '│ ' + colWidths.map((w, i) => pad(row[i] ?? '', w)).join(' │ ') + ' │'
        ).join('\n');

        const tableText = `${topRow}\n${headerRow}\n${sep}\n${dataRowsStr}\n${botRow}`;
        sheetSection.children.push({ type: 'body', text: tableText });

        // Summary
        sheetSection.children.push({ type: 'body', text: `📋 ${dataRows.length} แถว × ${headers.length} คอลัมน์` });
      } else {
        const rawText = aoa.map(row => row.join('\t')).join('\n');
        sheetSection.children.push({ type: 'body', text: rawText });
      }
      sections.push(sheetSection);
    });

    onProgress?.(100, 'เสร็จสิ้น');
    return { type: 'xlsx', sections, sheetNames: workbook.SheetNames };
  }

  // ════════════════════════════════════════════════════════════
  // PPTX LOADER (JSZip + XML parse)
  // ════════════════════════════════════════════════════════════
  async function loadPPTX(file, onProgress) {
    await ensureJSZip();
    onProgress?.(10, 'กำลังโหลดไฟล์ PowerPoint...');
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    onProgress?.(30, 'กำลังอ่านสไลด์...');

    // Find slide files
    const slideFiles = Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)[0]);
        const nb = parseInt(b.match(/\d+/)[0]);
        return na - nb;
      });

    // Find slide relationships for layout/titles
    const sections = [];

    for (let i = 0; i < slideFiles.length; i++) {
      const slideXml = await zip.files[slideFiles[i]].async('string');
      onProgress?.(30 + Math.round((i / slideFiles.length) * 60), `กำลังอ่านสไลด์ ${i+1}/${slideFiles.length}...`);

      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(slideXml, 'application/xml');

      // Extract text runs grouped by shapes
      const shapes = xmlDoc.querySelectorAll('sp');
      let titleText = '';
      let bodyTexts = [];

      shapes.forEach(sp => {
        const phEl = sp.querySelector('ph');
        const phType = phEl?.getAttribute('type') || '';
        const isTitle = phType === 'title' || phType === 'ctrTitle';

        const tElements = sp.querySelectorAll('t');
        const text = [...tElements].map(t => t.textContent).join('').trim();
        if (!text) return;

        if (isTitle) titleText = text;
        else bodyTexts.push(text);
      });

      // Also grab text from non-ph shapes (content placeholders)
      if (!titleText && !bodyTexts.length) {
        const allT = xmlDoc.querySelectorAll('t');
        const allText = [...allT].map(t => t.textContent.trim()).filter(Boolean);
        if (allText.length) {
          titleText  = allText[0];
          bodyTexts  = allText.slice(1);
        }
      }

      const slideSection = {
        type: 'h1',
        text: `🖼️ สไลด์ ${i + 1}${titleText ? ': ' + titleText : ''}`,
        children: []
      };
      if (bodyTexts.length) {
        slideSection.children.push({ type: 'body', text: bodyTexts.join('\n') });
      }
      sections.push(slideSection);
    }

    onProgress?.(100, 'เสร็จสิ้น');
    return { type: 'pptx', sections, slideCount: slideFiles.length };
  }

  // ════════════════════════════════════════════════════════════
  // ODT / ODS / ODP LOADER (JSZip + content.xml)
  // ════════════════════════════════════════════════════════════
  async function loadODT(file, fileType, onProgress) {
    await ensureJSZip();
    onProgress?.(10, 'กำลังโหลดไฟล์ OpenDocument...');
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    onProgress?.(40, 'กำลังอ่าน content.xml...');

    const contentXml = await zip.files['content.xml']?.async('string');
    if (!contentXml) throw new Error('ไม่พบ content.xml ในไฟล์นี้');

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(contentXml, 'application/xml');
    onProgress?.(70, 'กำลังวิเคราะห์โครงสร้าง...');

    const sections = [];
    let cur = null;

    // ODT: text:h and text:p elements
    const body = xmlDoc.querySelector('body') || xmlDoc.querySelector('text');
    if (!body) throw new Error('ไม่พบเนื้อหาในไฟล์ OpenDocument');

    const traverse = (node) => {
      const localName = node.localName;
      const text = node.textContent?.trim();

      if (!text) {
        node.childNodes.forEach(traverse);
        return;
      }

      if (localName === 'h') {
        const level = parseInt(node.getAttribute('text:outline-level') || node.getAttribute('outline-level') || '2');
        const type = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
        cur = { type, text, children: [] };
        sections.push(cur);
      } else if (localName === 'p') {
        if (cur) {
          const last = cur.children[cur.children.length - 1];
          if (last?.type === 'body') last.text += '\n' + text;
          else cur.children.push({ type: 'body', text });
        } else {
          sections.push({ type: 'body', text, children: [] });
        }
      } else if (localName === 'table') {
        const rows = [...node.querySelectorAll('table-row')].map(row =>
          [...row.querySelectorAll('table-cell')].map(cell => cell.textContent.trim()).join(' │ ')
        );
        const block = { type: 'body', text: '┌─── ตาราง ───\n' + rows.join('\n') + '\n└─────────────' };
        if (cur) cur.children.push(block);
        else sections.push({ ...block, children: [] });
      } else {
        node.childNodes.forEach(traverse);
      }
    };

    body.childNodes.forEach(traverse);
    onProgress?.(100, 'เสร็จสิ้น');
    return { type: fileType, sections };
  }

  // ════════════════════════════════════════════════════════════
  // TXT LOADER
  // ════════════════════════════════════════════════════════════
  async function loadTXT(file, onProgress) {
    onProgress?.(10, 'กำลังโหลดไฟล์ข้อความ...');
    const text = await readAsText(file);
    onProgress?.(60, 'กำลังวิเคราะห์โครงสร้าง...');
    const sections = structurePlainText(text);
    onProgress?.(100, 'เสร็จสิ้น');
    return { type: 'txt', sections };
  }

  function structurePlainText(text) {
    const lines = text.split('\n');
    const sections = [];
    let cur = null;

    lines.forEach(rawLine => {
      const line = rawLine.trimEnd();
      if (!line.trim()) return;

      // Detect markdown-style headings
      const h1Match = line.match(/^#{1}\s+(.+)/);
      const h2Match = line.match(/^#{2}\s+(.+)/);
      const h3Match = line.match(/^#{3,}\s+(.+)/);
      // ALL CAPS short line = heading
      const isCapsHeading = line.trim() === line.trim().toUpperCase() && line.trim().length <= 60 && /[A-Za-zก-์]/.test(line);
      // Underlined heading (=== or ---)
      const nextIsUnderline = false; // simplified

      let type = 'body';
      let headText = line.trim();

      if (h1Match)       { type = 'h1'; headText = h1Match[1]; }
      else if (h2Match)  { type = 'h2'; headText = h2Match[1]; }
      else if (h3Match)  { type = 'h3'; headText = h3Match[1]; }
      else if (isCapsHeading && line.trim().length > 2) { type = 'h2'; }

      if (type !== 'body') {
        cur = { type, text: headText, children: [] };
        sections.push(cur);
      } else {
        if (cur) {
          const last = cur.children[cur.children.length - 1];
          if (last?.type === 'body') last.text += '\n' + line.trim();
          else cur.children.push({ type: 'body', text: line.trim() });
        } else {
          sections.push({ type: 'body', text: line.trim(), children: [] });
        }
      }
    });
    return sections;
  }

  // ════════════════════════════════════════════════════════════
  // CSV LOADER
  // ════════════════════════════════════════════════════════════
  async function loadCSV(file, onProgress) {
    onProgress?.(10, 'กำลังโหลดไฟล์ CSV...');
    const text = await readAsText(file);
    onProgress?.(40, 'กำลังแปลงข้อมูล...');

    const rows = parseCSV(text);
    if (!rows.length) return { type: 'csv', sections: [{ type: 'body', text: '(ไม่มีข้อมูล)', children: [] }] };

    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(c => c.trim()));
    const colWidths = headers.map((h, i) => {
      const maxData = Math.max(...dataRows.map(r => (r[i] ?? '').length), 4);
      return Math.max(h.length, maxData);
    });

    const pad  = (str, w) => String(str ?? '').padEnd(w);
    const topRow = '┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
    const sep    = '├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
    const botRow = '└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';
    const hRow   = '│ ' + headers.map((h, i) => pad(h, colWidths[i])).join(' │ ') + ' │';
    const dRows  = dataRows.map(row => '│ ' + colWidths.map((w, i) => pad(row[i], w)).join(' │ ') + ' │').join('\n');

    const tableText = `${topRow}\n${hRow}\n${sep}\n${dRows}\n${botRow}`;
    const sections = [
      { type: 'h1', text: `📊 ${file.name}`, children: [
        { type: 'body', text: tableText },
        { type: 'body', text: `📋 ${dataRows.length} แถว × ${headers.length} คอลัมน์` }
      ]}
    ];

    onProgress?.(100, 'เสร็จสิ้น');
    return { type: 'csv', sections };
  }

  function parseCSV(text) {
    const rows = [];
    let cur = [], field = '', inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i], next = text[i+1];
      if (inQuote) {
        if (ch === '"' && next === '"') { field += '"'; i++; }
        else if (ch === '"') inQuote = false;
        else field += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === ',') { cur.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && next === '\n') i++;
          cur.push(field); field = '';
          if (cur.some(c => c.trim())) rows.push(cur);
          cur = [];
        } else field += ch;
      }
    }
    if (field || cur.length) { cur.push(field); if (cur.some(c => c.trim())) rows.push(cur); }
    return rows;
  }

  // ════════════════════════════════════════════════════════════
  // RTF LOADER (strip markup)
  // ════════════════════════════════════════════════════════════
  async function loadRTF(file, onProgress) {
    onProgress?.(10, 'กำลังโหลดไฟล์ RTF...');
    const text = await readAsText(file);
    onProgress?.(50, 'กำลังแปลงเนื้อหา...');
    const plainText = stripRTF(text);
    const sections = structurePlainText(plainText);
    onProgress?.(100, 'เสร็จสิ้น');
    return { type: 'rtf', sections };
  }

  function stripRTF(rtf) {
    // Remove RTF control words and groups
    let result = rtf
      .replace(/\\par\b/g, '\n')
      .replace(/\\line\b/g, '\n')
      .replace(/\\tab\b/g, '\t')
      .replace(/\\pard\b[^\\]*/g, '')
      .replace(/\\\w+\*?(?:\s|-?\d+)?/g, '')
      .replace(/[{}]/g, '')
      .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
        try { return String.fromCharCode(parseInt(hex, 16)); } catch { return ''; }
      })
      .replace(/\r\n|\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return result;
  }

  // ════════════════════════════════════════════════════════════
  // MARKDOWN LOADER
  // ════════════════════════════════════════════════════════════
  async function loadMarkdown(file, onProgress) {
    onProgress?.(10, 'กำลังโหลดไฟล์ Markdown...');
    const text = await readAsText(file);
    const sections = structurePlainText(text); // already handles # headings
    onProgress?.(100, 'เสร็จสิ้น');
    return { type: 'md', sections };
  }

  // ════════════════════════════════════════════════════════════
  // UTILITY
  // ════════════════════════════════════════════════════════════
  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      // Try UTF-8 first, fallback encoding handled by browser
      reader.readAsText(file, 'UTF-8');
    });
  }

  // ── Build structured sections from PDF text lines ────────────
  function structurePDFLines(lines) {
    if (!lines?.length) return [];

    // Delegate when OCREngine classification rules exist? Keep self-contained + compatible:
    const sizes = lines.map(l => l.fontSize).filter(s => s > 0 && s < 500);
    const med  = percentile(sizes, 50);
    const p75  = percentile(sizes, 75);
    const p90  = percentile(sizes, 90);

    const coverAnchorRe = /^(โดย|ผู้จัดทำ|จัดทำโดย|เสนอ|อาจารย์ที่ปรึกษา)\s*[:\-]?\s*$/;
    const coverDetailRe = /^(นาย|นางสาว|น\.ส\.|นาง|รหัส\s*(?:นักศึกษา|ประจำตัว|นิสิต)|Student\s*ID|รายงาน.{0,8}เป็นส่วนหนึ่งของ)/i;
    let metaStartIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 14); i++) {
      const txt = (lines[i].text || '').trim();
      if (coverAnchorRe.test(txt) || coverDetailRe.test(txt)) {
        metaStartIdx = i;
        break;
      }
    }

    const rawItems = [];
    lines.forEach(({ text, fontSize }, idx) => {
      const t = (text || '').trim();
      if (!t) return;
      const rel = med > 0 ? fontSize / med : 1;
      const isProse =
        t.length > 85 ||
        /^(โดย|ผู้จัดทำ|จัดทำโดย|เสนอ|นาย|นางสาว|น\.ส\.|นาง|รหัส\s*(?:นักศึกษา|ประจำตัว)|Student\s*ID)\b/i.test(t) ||
        /^(รายงาน|ระบบ|เอกสาร|โครงการ|โครงงาน)\s*(?:นี้|นั้น|ดังกล่าว)/.test(t) ||
        /(เป็นส่วนหนึ่งของ|ซึ่งเป็น|โดยจะต้อง|จะต้องมี|สามารถ.{1,35}ได้|ในรัศมีไม่เกิน)/.test(t) ||
        (/^\d+[.)]\s+\S/.test(t) && (t.length > 40 || /(จะต้อง|สามารถ|เพื่อ|โดย|and|or|create|develop)/i.test(t)));

      let type = 'body';
      if (!isProse && t.length <= 75 && /[A-Za-z\u0E01-\u0E2E]/.test(t) && !/^[\u0E30-\u0E3A\u0E45-\u0E4E]/.test(t)) {
        if (rel >= 1.28 && (p90 <= med * 1.05 || fontSize >= p90 * 0.90)) type = 'h1';
        else if (rel >= 1.14 && fontSize >= p75 * 0.92 && !/^\d+[.)]\s/.test(t)) type = 'h2';
        else if (/^(บทที่\s*\d+|ภาคผนวก|สารบัญ|บทคัดย่อ|รายงานการ|ประกาศเรื่อง|CHAPTER\s+\d+|ABSTRACT)/i.test(t)) type = 'h1';
        else if (/^(หัวข้อ|ตอนที่|ส่วนที่|บทนำ|สรุป|โครงการ|โครงงาน|SECTION|Chapter|Options?)\b/i.test(t) || /^\([A-Z][A-Za-z0-9\s\-&,\/\.]{4,}\)$/.test(t)) type = 'h2';
        else if (/^(ระบบ|แอปพลิเคชัน|โปรแกรม|การพัฒนา)/.test(t) && t.length <= 58 && !/[.,;!]$/.test(t)) type = 'h2';
        else if (/^\d+(\.\d+)+\s+\S/.test(t) && t.length <= 55) type = 'h3';
      }

      if (metaStartIdx > 0 && idx < metaStartIdx && type === 'body' && !isProse && t.length >= 4 && t.length <= 75 && !/[.,;!]$/.test(t)) {
        const hasH1 = rawItems.some(r => r.type === 'h1');
        type = hasH1 ? 'h2' : 'h1';
      }
      rawItems.push({ type, text: t });
    });

    const sections = [];
    let cur = null;
    rawItems.forEach(({ type, text }) => {
      if (type !== 'body') {
        cur = { type, text, children: [] };
        sections.push(cur);
      } else if (cur && (cur.type === 'h1' || cur.type === 'h2' || cur.type === 'h3')) {
        const last = cur.children[cur.children.length - 1];
        if (last?.type === 'body') last.text += '\n' + text;
        else cur.children.push({ type: 'body', text });
      } else {
        const prev = sections[sections.length - 1];
        if (prev && prev.type === 'body' && (!prev.children || prev.children.length === 0)) {
          prev.text += '\n' + text;
        } else {
          sections.push({ type: 'body', text, children: [] });
        }
      }
    });
    return sections;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(Math.floor((p / 100) * s.length), s.length - 1)];
  }

  function countWords(sections) {
    let total = 0;
    const walk = s => { total += (s.text||'').trim().split(/\s+/).filter(Boolean).length; (s.children||[]).forEach(walk); };
    sections.forEach(walk);
    return total;
  }

  function countLines(sections) {
    let total = 0;
    const walk = s => { total += (s.text||'').split('\n').length; (s.children||[]).forEach(walk); };
    sections.forEach(walk);
    return total;
  }

  // ── Meta: label & icon per file type ─────────────────────────
  const FILE_META = {
    image: { label: '🖼️ Image',       badge: 'badge-img',  color: 'var(--accent-primary)' },
    pdf:   { label: '📕 PDF',          badge: 'badge-pdf',  color: '#fc8181' },
    docx:  { label: '📘 Word',         badge: 'badge-docx', color: 'var(--accent-green)' },
    xlsx:  { label: '📗 Excel',        badge: 'badge-xlsx', color: '#68d391' },
    pptx:  { label: '📙 PowerPoint',   badge: 'badge-pptx', color: '#f6ad55' },
    odt:   { label: '📄 ODT',          badge: 'badge-odt',  color: 'var(--accent-secondary)' },
    ods:   { label: '📊 ODS',          badge: 'badge-ods',  color: '#68d391' },
    odp:   { label: '🎞️ ODP',          badge: 'badge-odp',  color: '#f6ad55' },
    txt:   { label: '📝 Text',         badge: 'badge-txt',  color: 'var(--text-secondary)' },
    csv:   { label: '📊 CSV',          badge: 'badge-csv',  color: '#68d391' },
    rtf:   { label: '📃 RTF',          badge: 'badge-rtf',  color: 'var(--text-secondary)' },
    md:    { label: '📋 Markdown',     badge: 'badge-md',   color: 'var(--accent-primary)' },
  };

  return {
    detectFileType,
    loadPDF,
    loadDOCX,
    loadXLSX,
    loadPPTX,
    loadODT,
    loadTXT,
    loadCSV,
    loadRTF,
    loadMarkdown,
    structurePlainText,
    structurePDFLines,
    countWords,
    countLines,
    FILE_META,
  };
})();
