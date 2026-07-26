/**
 * VNPT HIS Medical Assistant - Content Script
 * Tự động lắng nghe & bóc tách dữ liệu chính xác từ VNPT HIS
 * (Hỗ trợ định dạng header bệnh nhân: MA_BN | HO_TEN | NGAY_SINH (TUOI) | GIOI_TINH | PHONG | GIUONG)
 * Trích xuất Xét nghiệm Vượt cận + CĐHA (DICOM)
 */

(function () {
  'use strict';

  if (window.__HIS_EXTENSION_LOADED__) return;
  window.__HIS_EXTENSION_LOADED__ = true;

  console.log('🩺 VNPT HIS Medical Assistant Extension initialized.');

  // State quản lý
  const state = {
    isOpen: false,
    activeTab: 'lab', // 'lab' | 'imaging'
    isDemoMode: false, // Mặc định LIVE MODE
    showOnlyAbnormal: false, // Mặc định FALSE để bác sĩ luôn thấy đầy đủ tất cả chỉ số XN
    filterKeyword: '',
    selectedPatient: {
      name: 'Chưa chọn bệnh nhân',
      code: '---',
      age: '--',
      gender: '--',
      room: '--',
      bed: '--'
    },
    labResults: [],
    imagingResults: [],
    hasScannedCurrentPatient: false,
    isScanning: false,
    scanProgress: '',
    debugLogs: ['[System] Tiện ích đã khởi động']
  };

  function logDebug(msg) {
    console.log('[HIS-EXT-DEBUG]', msg);
    if (isTopFrame) {
      state.debugLogs.push(msg);
      if (state.debugLogs.length > 40) state.debugLogs.shift();
      const debugDiv = document.getElementById('his-debug-panel');
      if (debugDiv) {
        debugDiv.innerHTML = state.debugLogs.map(l => `<div style="margin-bottom:2px;">${l}</div>`).join('');
        debugDiv.scrollTop = debugDiv.scrollHeight;
      }
    } else {
      try {
        window.top.postMessage({
          type: 'HIS_EXT_DEBUG_LOG',
          message: msg
        }, '*');
      } catch(e) {}
    }
  }

  function cleanString(str) {
    if (!str) return '';
    return str.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '')
              .replace(/\u00A0/g, ' ')
              .trim();
  }

  function normalizeVietnameseText(str) {
    return cleanString(str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isLikelyQualitativeResult(value) {
    const v = normalizeVietnameseText(value || '');
    return (
      v.includes('duong tinh') ||
      v.includes('am tinh') ||
      v.includes('negative') ||
      v.includes('positive') ||
      v.includes('reactive') ||
      v.includes('non reactive') ||
      v.includes('non-reactive') ||
      v.includes('detected') ||
      v.includes('not detected') ||
      v.includes('khong phat hien')
    );
  }

  // Dữ liệu giả lập Demo (Dùng khi bật Demo Mode)
  const MOCK_PATIENTS_DATABASE = {
    'BN202607-00912': {
      patient: {
        name: 'Nguyễn Văn An',
        code: 'BN202607-00912',
        age: 48,
        gender: 'Nam',
        room: 'Buồng 02',
        bed: 'Giường 05'
      },
      lab: [
        {
          serviceName: 'Công thức máu toàn bộ (Laser counter)',
          indicators: [
            { name: 'Bạch cầu (WBC)', value: '15.6', unit: 'G/L', range: '4.0 - 10.0', status: 'HIGH' },
            { name: 'Hồng cầu (RBC)', value: '4.52', unit: 'T/L', range: '3.8 - 5.3', status: 'NORMAL' },
            { name: 'Huyết sắc tố (HGB)', value: '138', unit: 'g/L', range: '120 - 165', status: 'NORMAL' },
            { name: 'Neutrophil (%)', value: '84.2', unit: '%', range: '40 - 74', status: 'HIGH' },
            { name: 'Tiểu cầu (PLT)', value: '245', unit: 'G/L', range: '150 - 400', status: 'NORMAL' }
          ]
        },
        {
          serviceName: 'Sinh hóa máu: CRP, Men gan, Thận',
          indicators: [
            { name: 'CRP định lượng', value: '48.5', unit: 'mg/L', range: '< 5.0', status: 'HIGH' },
            { name: 'Ure máu', value: '6.2', unit: 'mmol/L', range: '2.5 - 7.5', status: 'NORMAL' },
            { name: 'Creatinin máu', value: '92', unit: 'umol/L', range: '62 - 115', status: 'NORMAL' },
            { name: 'AST (GOT)', value: '38.5', unit: 'U/L', range: '< 37', status: 'HIGH' }
          ]
        }
      ],
      imaging: [
        {
          serviceName: 'Chụp X-quang ngực thẳng [Số hóa 1 phim]',
          serviceCode: 'XQ001',
          date: '24/07/2026 08:30:00',
          doctor: 'BS. Lê Hoàng Nam',
          conclusion: 'Đám mờ rải rác hạ đòn và phế trường bên phải. Theo dõi Viêm phổi tiến triển.',
          dicomUrl: 'https://pacs-demo.vnpt.vn/viewer?id=BN202607-00912-XQ',
          slices: 2
        },
        {
          serviceName: 'Chụp Cắt lớp vi tính lồng ngực (CT-Scanner)',
          serviceCode: 'CT002',
          date: '24/07/2026 10:15:00',
          doctor: 'BS. Trần Minh Tâm',
          conclusion: 'Tổn thương đông đặc thùy giữa phổi phải, kèm tràn dịch màng phổi lượng ít.',
          dicomUrl: 'https://pacs-demo.vnpt.vn/viewer?id=BN202607-00912-CT',
          slices: 16
        }
      ]
    },
    'BN202607-00441': {
      patient: {
        name: 'Phần Thị Mai',
        code: 'BN202607-00441',
        age: 62,
        gender: 'Nữ',
        room: 'Buồng 01',
        bed: 'Giường 02'
      },
      lab: [
        {
          serviceName: 'Men tim & Sinh hóa khẩn cấp',
          indicators: [
            { name: 'Troponin T hs', value: '1450', unit: 'pg/mL', range: '< 14', status: 'HIGH' },
            { name: 'CK-MB', value: '68.2', unit: 'U/L', range: '< 24', status: 'HIGH' },
            { name: 'Glucose máu', value: '9.8', unit: 'mmol/L', range: '3.9 - 6.4', status: 'HIGH' }
          ]
        }
      ],
      imaging: [
        {
          serviceName: 'Siêu âm tim màu qua thành ngực',
          serviceCode: 'SA003',
          date: '24/07/2026 07:45:00',
          doctor: 'BS. Phạm Thị Hoa',
          conclusion: 'Giảm động vùng mỏm và thành trước thất trái. EF = 45%. Tràn dịch màng ngoài tim nhẹ.',
          dicomUrl: 'https://pacs-demo.vnpt.vn/viewer?id=BN202607-00441-SA',
          slices: 6
        }
      ]
    },
    'DEFAULT': {
      patient: {
        name: 'CHÂU THỊ MỸ KHUYÊN',
        code: 'BA2607180160',
        age: 35,
        gender: 'Nữ',
        room: 'Buồng Điều Trị Theo Yêu Cầu A5',
        bed: 'H030 - Giường KH'
      },
      lab: [
        {
          serviceName: 'Công thức máu toàn bộ (Laser counter)',
          indicators: [
            { name: 'Bạch cầu (WBC)', value: '14.8', unit: 'G/L', range: '4.0 - 10.0', status: 'HIGH' },
            { name: 'Hồng cầu (RBC)', value: '4.12', unit: 'T/L', range: '3.8 - 5.3', status: 'NORMAL' },
            { name: 'Neutrophil (%)', value: '82.5', unit: '%', range: '40 - 74', status: 'HIGH' },
            { name: 'Tiểu cầu (PLT)', value: '85', unit: 'G/L', range: '150 - 400', status: 'LOW' }
          ]
        },
        {
          serviceName: 'Sinh hóa máu: Ure, Creatinin, Men gan',
          indicators: [
            { name: 'AST (GOT)', value: '145.2', unit: 'U/L', range: '< 37', status: 'HIGH' },
            { name: 'ALT (GPT)', value: '128.0', unit: 'U/L', range: '< 40', status: 'HIGH' }
          ]
        }
      ],
      imaging: [
        {
          serviceName: 'Chụp X-quang cột sống thắt lưng thẳng nghiêng [số hóa 2 phim]',
          serviceCode: '18.0091.0029',
          date: '23/07/2026 09:07:00',
          doctor: 'Nguyễn Thị Hà Trang',
          conclusion: 'Hiện tại không thấy tổn thương xương cột sống thắt lưng.',
          dicomUrl: 'https://pacs-demo.vnpt.vn/viewer?id=BA2607180160',
          slices: 2
        }
      ]
    }
  };

  const isTopFrame = (window.self === window.top);

  let triggerBtn = null;
  let drawerPanel = null;

  setupNetworkInterceptors();

  function init() {
    loadStateFromStorage(() => {
      if (isTopFrame) {
        createTriggerButton();
        createDrawerPanel();
        setupTopFrameMessageListener();
      }
      bindPatientSelectionListeners();
      extractRealDataFromHIS();
    });
  }

  function setupTopFrameMessageListener() {
    window.addEventListener('message', (event) => {
      if (!event.data) return;

      if (event.data.type === 'HIS_EXT_DEBUG_LOG') {
        logDebug(`[Iframe] ${event.data.message}`);
        return;
      }

      if (event.data.type === 'HIS_EXT_SCANNING_STATE') {
        state.isScanning = event.data.isScanning;
        renderContent();
        return;
      }

      if (event.data.type === 'HIS_EXT_TRIGGER_AUTOSCAN') {
        triggerAutoScanForSelectedPatient(event.data.reason || 'iframe-request');
        return;
      }

      if (event.data.type === 'HIS_EXT_PARSED_DATA') {
        const { patient, labResults, imagingResults } = event.data;
        if (patient && patient.code && patient.code !== '---' && patient.name && patient.name !== 'Chưa chọn bệnh nhân') {
          if (state.selectedPatient.code !== patient.code) {
            state.selectedPatient = patient;
            state.labResults = [];
            state.imagingResults = [];
          } else {
            state.selectedPatient = patient;
          }
        }
        if (labResults && labResults.length > 0) {
          state.labResults = mergeDuplicateLabGroups([...state.labResults, ...labResults]);
        }
        if (imagingResults && imagingResults.length > 0) {
          state.imagingResults = mergeImagingResults(state.imagingResults, imagingResults);
        }
        updatePatientInfoUI();
        renderContent();
      }
    });
  }

  /**
   * Inject Interceptor bắt API XHR của VNPT HIS
   */
  function setupNetworkInterceptors() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('injected-interceptor.js');
        script.onload = () => script.remove();
        (document.head || document.documentElement).appendChild(script);
      }
    } catch (e) {}

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'HIS_XHR_DATA') {
        parseRealXHRResponse(event.data.url, event.data.response);
      }
    });
  }

  function loadStateFromStorage(callback) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['isDemoMode', 'showOnlyAbnormal'], (result) => {
        if (result.isDemoMode !== undefined) state.isDemoMode = result.isDemoMode;
        if (result.showOnlyAbnormal !== undefined) state.showOnlyAbnormal = result.showOnlyAbnormal;
        callback();
      });
    } else {
      callback();
    }
  }

  function createTriggerButton() {
    if (document.getElementById('his-assistant-trigger')) return;

    triggerBtn = document.createElement('div');
    triggerBtn.id = 'his-assistant-trigger';
    triggerBtn.className = 'his-assistant-trigger';
    triggerBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
      <span>Kết quả KCB</span>
      <span class="his-badge-count" id="his-trigger-badge">0</span>
    `;

    triggerBtn.onclick = () => toggleDrawer();
    document.body.appendChild(triggerBtn);
  }

  function isElementVisible(el) {
    if (!el) return false;
    const hasSize = el.offsetWidth > 0 || el.offsetHeight > 0 || (el.getClientRects && el.getClientRects().length > 0);
    const hasText = el.innerText && el.innerText.trim().length > 10;
    return hasSize || hasText;
  }

  function createDrawerPanel() {
    if (document.getElementById('his-assistant-drawer')) return;

    drawerPanel = document.createElement('div');
    drawerPanel.id = 'his-assistant-drawer';
    drawerPanel.className = 'his-drawer-panel';

    drawerPanel.innerHTML = `
      <!-- Header -->
      <div class="his-drawer-header">
        <div class="his-header-top">
          <div class="his-brand">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
            HIS VNPT Assistant
          </div>
          <div class="his-header-controls">
            <button id="his-rescan-btn" class="his-demo-toggle-btn" style="background:#0284c7; color:#fff; border:none;" title="Ép quét lại màn hình hiện tại">
              🔄 Quét lại
            </button>
            <button id="his-demo-toggle" class="his-demo-toggle-btn ${state.isDemoMode ? 'active' : ''}" title="Bật/Tắt chế độ dữ liệu giả lập">
              ${state.isDemoMode ? '⚡ Demo Mode: ON' : '🌐 Live HIS Mode'}
            </button>
            <button id="his-close-drawer" class="his-icon-btn">&times;</button>
          </div>
        </div>

        <!-- Thẻ bệnh nhân -->
        <div class="his-patient-card" id="his-patient-info-card">
          <div class="his-patient-name">
            <span id="his-p-name">Đang quét bệnh nhân...</span>
            <span class="his-patient-tag" id="his-p-code">BN---</span>
          </div>
          <div class="his-patient-meta">
            <span id="his-p-gender-age">-- tuổi | --</span>
            <span id="his-p-room">Buồng --</span>
          </div>
        </div>
      </div>

      <!-- Tabs Chuyển đổi -->
      <div class="his-drawer-tabs">
        <button class="his-tab-btn active" id="his-tab-lab">
          🩸 Xét nghiệm (Vượt cận)
          <span class="his-tab-count" id="his-count-lab">0</span>
        </button>
        <button class="his-tab-btn" id="his-tab-imaging">
          📷 CĐHA / DICOM
          <span class="his-tab-count" id="his-count-imaging">0</span>
        </button>
      </div>

      <!-- Body Content -->
      <div class="his-drawer-body" id="his-drawer-body-content">
      </div>
      <!-- Debug Panel -->
      <div id="his-debug-panel" style="padding: 6px 10px; background: #0f172a; color: #38bdf8; border-top: 1px solid #1e293b; max-height: 100px; overflow-y: auto; font-family: monospace; font-size: 10px; line-height: 1.4;">
        [System Info] Khởi động hệ thống...
      </div>
    `;

    document.body.appendChild(drawerPanel);

    document.getElementById('his-close-drawer').onclick = () => closeDrawer();
    
    document.getElementById('his-rescan-btn').onclick = () => {
      state.labResults = [];
      state.imagingResults = [];
      state.hasScannedCurrentPatient = false;
      const docsToScan = getAllAccessibleDocs();
      docsToScan.forEach(doc => {
        doc.querySelectorAll('*').forEach(el => {
          delete el.__his_sheet_scanned__;
          delete el.__his_autoclicked__;
        });
        autoSwitchToKetQuaTab(doc);
        autoScanAllLabSheets(doc);
      });
      extractRealDataFromHIS(true);
    };

    document.getElementById('his-demo-toggle').onclick = () => {
      state.isDemoMode = !state.isDemoMode;
      const btn = document.getElementById('his-demo-toggle');
      btn.classList.toggle('active', state.isDemoMode);
      btn.innerHTML = state.isDemoMode ? '⚡ Demo Mode: ON' : '🌐 Live HIS Mode';
      loadPatientData(state.selectedPatient.code);
    };

    document.getElementById('his-tab-lab').onclick = () => switchTab('lab');
    document.getElementById('his-tab-imaging').onclick = () => switchTab('imaging');
  }

  function toggleDrawer() {
    state.isOpen = !state.isOpen;
    if (drawerPanel) drawerPanel.classList.toggle('open', state.isOpen);
  }

  function closeDrawer() {
    state.isOpen = false;
    if (drawerPanel) drawerPanel.classList.remove('open');
  }

  function forceClickElement(el) {
    if (!el) return;
    try {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      if (typeof el.click === 'function') el.click();
    } catch(e) {}
  }

  function getAllAccessibleDocs() {
    const docs = [];
    const seen = new Set();

    function collectDocs(rootDoc) {
      if (!rootDoc || seen.has(rootDoc)) return;
      seen.add(rootDoc);
      docs.push(rootDoc);

      rootDoc.querySelectorAll('iframe').forEach(iframe => {
        try {
          const idoc = iframe.contentDocument || iframe.contentWindow.document;
          if (idoc) collectDocs(idoc);
        } catch (e) {}
      });
    }

    collectDocs(document);
    return docs;
  }

  function clickMainXetNghiemTab(docToUse) {
    const doc = docToUse || document;
    const candidates = doc.querySelectorAll('div, span, button, a, td, li');
    let bestEl = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (el.closest && (el.closest('#his-assistant-drawer') || el.closest('#his-assistant-trigger'))) continue;
      const text = cleanString(el.innerText || el.textContent || '').toLowerCase();
      if (!text || text.length > 80) continue;

      const attrText = `${(el.id || '').toLowerCase()} ${(el.className || '').toString().toLowerCase()} ${(el.getAttribute && el.getAttribute('title') || '').toLowerCase()}`;
      const isLabMain = /(^|\s)xét\s*nghiệm(\(\d+\))?($|\s)|(^|\s)xet\s*nghiem(\(\d+\))?($|\s)/i.test(text);
      const isLabSub = text.includes('kết quả xét nghiệm') || text.includes('ket qua xet nghiem');
      const attrHint = attrText.includes('xetnghiem') || attrText.includes('xet-nghiem') || attrText.includes('lab');

      if (isLabSub) continue;

      let score = 0;
      if (isLabMain) score += 10;
      if (attrHint) score += 3;
      if (el.tagName === 'LI' || el.tagName === 'A' || el.tagName === 'BUTTON') score += 2;

      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }

    if (bestEl && bestScore >= 10) {
      forceClickElement(bestEl);
      if (bestEl.parentElement) forceClickElement(bestEl.parentElement);
      return true;
    }

    return false;
  }

  let _lastAutoScanTriggerAt = 0;

  function triggerAutoScanForSelectedPatient(reason) {
    if (state.isDemoMode) return;
    if (_isRunningAutoScan || state.isScanning) return;

    const now = Date.now();
    if (now - _lastAutoScanTriggerAt < 1200) return;
    _lastAutoScanTriggerAt = now;

    state.hasScannedCurrentPatient = false;
    logDebug(`[AutoScan] Kich hoat quet XN tu dong (${reason || 'patient-click'})`);

    const docs = getAllAccessibleDocs();
    docs.forEach(doc => clickMainXetNghiemTab(doc));

    setTimeout(() => {
      const freshDocs = getAllAccessibleDocs();
      freshDocs.forEach(doc => {
        clickKetQuaXetNghiemTab(doc);
        runAutoScanSequence(doc);
      });
    }, 250);
  }

  function requestAutoScanFromTop(reason) {
    if (isTopFrame) {
      triggerAutoScanForSelectedPatient(reason);
      return;
    }

    try {
      window.top.postMessage({
        type: 'HIS_EXT_TRIGGER_AUTOSCAN',
        reason: reason || 'iframe-request'
      }, '*');
    } catch (e) {
      triggerAutoScanForSelectedPatient(reason);
    }
  }

  function isLikelyPatientSelectionRow(row) {
    if (!row) return false;
    const text = cleanString(row.innerText || '');
    if (!text || text.length < 10) return false;

    const lower = text.toLowerCase();
    if (
      lower.includes('kết quả xét nghiệm') ||
      lower.includes('danh sách xét nghiệm') ||
      lower.includes('trị số bình thường') ||
      lower.includes('barcode') ||
      lower.includes('phiếu điều trị') ||
      lower.includes('kết luận') ||
      lower.includes('chẩn đoán hình ảnh') ||
      lower.includes('xem phim')
    ) {
      return false;
    }

    if (/\b(ba\d+|bn\d+[-_]?\d+)\b/i.test(text)) return true;

    const hasName = /[a-zA-ZàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]+\s+[a-zA-ZàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]+/i.test(text);
    const hasGender = /\b(nam|nữ)\b/i.test(text);
    const hasAgeOrBirth = /\b\d{1,3}\s*tuổi\b|\d{2}\/\d{2}\/\d{4}/i.test(text);

    return hasName && (hasGender || hasAgeOrBirth);
  }

  // ====================================================
  // TỰ ĐỘNG HÓA TUẦN TỰ 4 BƯỚC VNPT HIS
  // Bước 1: Phát hiện click tab Xét nghiệm
  // Bước 2: Click "Load phiếu theo đợt điều trị"
  // Bước 3: Lần lượt click từng phiếu trong danh sách
  // Bước 4: Click sub-tab "Kết quả xét nghiệm" → bóc tách
  // ====================================================

  let _isRunningAutoScan = false;

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function runAutoScanSequence(docToUse) {
    if (_isRunningAutoScan) return;
    if (state.hasScannedCurrentPatient) {
      logDebug(`[AutoScan] Đã quét bệnh nhân này trước đó. Bỏ qua để tránh giật lag.`);
      return;
    }
    _isRunningAutoScan = true;

    // Phát tín hiệu bắt đầu quét
    state.isScanning = true;
    if (isTopFrame) {
      renderContent();
    } else {
      try {
        window.top.postMessage({ type: 'HIS_EXT_SCANNING_STATE', isScanning: true }, '*');
      } catch(e) {}
    }

    try {
      // Bấm sẵn sub-tab "Kết quả xét nghiệm" một lần duy nhất ở đầu
      const clickedTab = clickKetQuaXetNghiemTab(docToUse);
      if (clickedTab) {
        await delay(200);
      }

      // Bước 1: Click "Load phiếu theo đợt điều trị" nếu có
      const loadChk = findLoadPhieuCheckbox(docToUse);
      if (loadChk) {
        if (!loadChk.checked) {
          loadChk.checked = true;
          loadChk.dispatchEvent(new Event('change', { bubbles: true }));
          forceClickElement(loadChk);
          await delay(350);
        }
      }

      // Bước 2: Tìm bảng danh sách phiếu xét nghiệm
      const initialSheetRows = await waitForSheetRowsReady(docToUse, 2200);
      if (initialSheetRows.length === 0) {
        logDebug(`[AutoScan] Khong tim thay danh sach phieu XN sau khi doi render`);
        state.isScanning = false;
        if (isTopFrame) {
          renderContent();
        } else {
          try { window.top.postMessage({ type: 'HIS_EXT_SCANNING_STATE', isScanning: false }, '*'); } catch(e) {}
        }
        _isRunningAutoScan = false;
        return;
      }

      // Bước 3: Duyệt tuần tự từng phiếu và đợi dữ liệu render để không mất phiếu.
      const totalSheets = initialSheetRows.length;
      for (let i = 0; i < totalSheets; i++) {
        // Re-query mỗi vòng vì jqGrid thường re-render, tránh click vào node đã stale.
        const liveRows = findSheetListRows(docToUse);
        const row = liveRows[i] || liveRows[liveRows.length - 1];
        if (!row) continue;
        
        const rowPreview = cleanString((row.innerText || '').replace(/\s+/g, ' ')).slice(0, 90);
        logDebug(`[AutoScan] Kích hoạt phiếu ${i + 1}/${totalSheets}: ${rowPreview}...`);

        // Click vào phiếu để kích hoạt XHR
        const clickTarget = row.querySelector('td:nth-child(4), td:nth-child(3), td') || row;
        forceClickElement(clickTarget);
        forceClickElement(row);

        // Mỗi phiếu cần đợi HIS tải phần kết quả rồi mới bóc tách.
        await delay(700);
        clickKetQuaXetNghiemTab(docToUse);
        await delay(250);
        await waitForLabResultReady(docToUse, 2200);
        extractRealDataFromHIS(true);
      }

      // Đợi thêm ở cuối để các phản hồi trễ nhất vẫn được gộp.
      logDebug(`[AutoScan] Đang gộp kết quả từ máy chủ...`);
      await delay(1600);

      // Quét DOM dự phòng lần cuối
      extractRealDataFromHIS(true);

      // Đánh dấu hoàn tất quét bệnh nhân hiện tại
      state.hasScannedCurrentPatient = true;
      logDebug(`[AutoScan] Quét thành công tất cả phiếu của bệnh nhân!`);

    } catch(e) {
      logDebug(`[Error] Lỗi autoScan: ${e.message}`);
    }

    // Phát tín hiệu kết thúc quét
    state.isScanning = false;
    if (isTopFrame) {
      renderContent();
    } else {
      try {
        window.top.postMessage({ type: 'HIS_EXT_SCANNING_STATE', isScanning: false }, '*');
      } catch(e) {}
    }
    _isRunningAutoScan = false;
  }

  async function waitForSheetRowsReady(docToUse, timeoutMs) {
    const doc = docToUse || document;
    const maxMs = timeoutMs || 4000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxMs) {
      const rows = findSheetListRows(doc);
      if (rows.length > 0) return rows;

      await delay(350);
    }

    return [];
  }

  async function waitForLabResultReady(docToUse, timeoutMs) {
    const doc = docToUse || document;
    const maxMs = timeoutMs || 1800;
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxMs) {
      const tables = Array.from(doc.querySelectorAll('table.ui-jqgrid-btable'));
      const hasLabResultData = tables.some(t => {
        const text = getGridFullText(t);
        const norm = normalizeVietnameseText(text || '');
        if (!norm.includes('danh sach ket qua xet nghiem')) return false;
        if (norm.includes('dang nap du lieu')) return false;
        // Co it nhat 1 ket qua so hoac dinh tinh
        return /\b(am tinh|duong tinh|negative|positive|reactive|detected|khong phat hien)\b/.test(norm) || /\b\d+[.,]?\d*\b/.test(norm);
      });

      if (hasLabResultData) return true;
      await delay(120);
    }

    return false;
  }

  function findLoadPhieuCheckbox(docToUse) {
    const doc = docToUse || document;
    const labels = doc.querySelectorAll('label, span, div');
    for (const el of labels) {
      const txt = (el.innerText || el.textContent || '').toLowerCase();
      if (txt.includes('load phiếu theo đợt') || txt.includes('load phiếu')) {
        const chk = el.querySelector('input[type="checkbox"]');
        if (chk) return chk;
        if (el.type === 'checkbox') return el;
      }
    }
    const chks = doc.querySelectorAll('input[type="checkbox"]');
    for (const chk of chks) {
      const nearby = chk.closest('label, td, div');
      const txt = (nearby ? (nearby.innerText || nearby.textContent || '') : '').toLowerCase();
      if (txt.includes('load phiếu')) return chk;
    }
    return null;
  }

  function findSheetListRows(docToUse) {
    const doc = docToUse || document;
    const result = [];
    
    // 1. Tìm container chứa tiêu đề "Danh sách xét nghiệm" (không lấy bảng kết quả / dịch vụ chỉ định)
    const grids = doc.querySelectorAll('.ui-jqgrid, .dhtmlxGrid, .jqx-grid, [role="grid"], div[class*="grid"], div[class*="Grid"]');
    let sheetGrid = null;
    for (const grid of grids) {
      const textNorm = normalizeVietnameseText(grid.innerText || '');
      const isSheetList = textNorm.includes('danh sach xet nghiem');
      const isResultList = textNorm.includes('danh sach ket qua xet nghiem');
      const isServiceList = textNorm.includes('danh sach dich vu chi dinh');
      if (isSheetList && !isResultList && !isServiceList) {
        sheetGrid = grid;
        break;
      }
    }

    if (!sheetGrid) {
      logDebug(`[AutoScan] Không tìm thấy grid "Danh sách xét nghiệm"`);
      return [];
    }

    // 2. Chỉ quét các hàng dữ liệu thật của jqGrid để tránh dính header/pager
    let rows = Array.from(sheetGrid.querySelectorAll('tr.jqgrow, tr[role="row"]'));
    if (rows.length === 0) {
      rows = Array.from(sheetGrid.querySelectorAll('table.ui-jqgrid-btable tr'));
    }

    rows.forEach(row => {
      const text = cleanString(row.innerText);
      const textNorm = normalizeVietnameseText(text);
      if (!textNorm || textNorm.length < 10) return;

      // Bo qua hang tieu de/pager
      if (textNorm.includes('muc cho cls') || textNorm.includes('tg chi dinh') || textNorm.includes('tr. /')) return;
      
      // Hàng phiếu xét nghiệm hợp lệ chứa ngày tháng chỉ định
      const hasDate = /\d{2}\/\d{2}\/\d{4}/.test(text);
      if (hasDate) {
        result.push(row);
      }
    });
    
    logDebug(`[AutoScan] Tìm thấy ${result.length} phiếu xét nghiệm để quét`);
    return result;
  }

  function clickKetQuaXetNghiemTab(docToUse) {
    const doc = docToUse || document;
    const candidates = doc.querySelectorAll('div, span, button, a, td, li');
    for (const el of candidates) {
      if (el.closest && (el.closest('#his-assistant-drawer') || el.closest('#his-assistant-trigger'))) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (text === 'Kết quả xét nghiệm' || text.toLowerCase() === 'kết quả xét nghiệm') {
        forceClickElement(el);
        if (el.parentElement) forceClickElement(el.parentElement);
        return true;
      }
    }
    return false;
  }

  // Aliases tương thích ngược
  function autoSelectAllHISSheets(doc) { autoScanAllLabSheets(doc); }
  function autoClickKetQuaTab(doc) { clickKetQuaXetNghiemTab(doc); }
  function autoSwitchToKetQuaTab(doc) { clickKetQuaXetNghiemTab(doc); }
  function autoScanAllLabSheets(doc) { runAutoScanSequence(doc); }

  function openDrawer() {
    state.isOpen = true;
    if (drawerPanel) drawerPanel.classList.add('open');
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.getElementById('his-tab-lab').classList.toggle('active', tabName === 'lab');
    document.getElementById('his-tab-imaging').classList.toggle('active', tabName === 'imaging');
    renderContent();
  }

  function isLabTabActive(doc) {
    const text = (doc.body ? doc.body.innerText : '').toLowerCase();
    return text.includes('danh sách xét nghiệm') && (text.includes('load phiếu theo đợt') || text.includes('kết quả xét nghiệm'));
  }

  /**
   * Bắt sự kiện click chọn bệnh nhân / tab xét nghiệm & tự động kích hoạt chuỗi bóc tách
   */
  function bindPatientSelectionListeners() {
    let _lastXNClickTime = 0;
    let lastPatientCode = '';

    const handleDocumentClick = (e) => {
      if (!e.target) return;

      // Bỏ qua click bên trong bảng điều khiển tiện ích
      if (e.target.closest && (e.target.closest('#his-assistant-drawer') || e.target.closest('#his-assistant-trigger'))) return;

      const text = (e.target.innerText || e.target.textContent || '').trim();
      const closestText = e.target.closest ? (e.target.closest('li, a, div, td, button')?.innerText || '') : '';
      const combinedText = `${text} ${closestText}`.toLowerCase();
      const now = Date.now();

      // Phát hiện click tab Xét nghiệm chính
      if (combinedText.includes('xét nghiệm') && !_isRunningAutoScan && (now - _lastXNClickTime > 2500)) {
        _lastXNClickTime = now;
        logDebug(`[Click] Bác sĩ bấm vào tab Xét nghiệm`);
        setTimeout(() => {
          const docs = getAllAccessibleDocs();
          docs.forEach(doc => {
            if (isLabTabActive(doc)) {
              runAutoScanSequence(doc);
            }
          });
        }, 600);
      }

      // Trích xuất thông tin bệnh nhân từ header
      extractPatientHeaderFromDOM();
      const row = e.target.closest && e.target.closest('tr, div[role="row"]');
      if (row) {
        extractPatientInfoFromRow(row);
      }

      // Trích xuất dữ liệu sau mỗi click
      setTimeout(() => {
        extractRealDataFromHIS();
      }, 300);
    };

    document.addEventListener('click', handleDocumentClick, true);

    // Gán listener cho iframes mới được tạo & tự động kích hoạt khi đổi bệnh nhân
    if (!isTopFrame) return;

    setInterval(() => {
      scanAndAttachIframeListeners(handleDocumentClick);
      
      const prevCode = state.selectedPatient.code;
      extractPatientHeaderFromDOM();
      const currentCode = state.selectedPatient.code;
      
      if (currentCode !== '---' && currentCode !== lastPatientCode) {
        lastPatientCode = currentCode;
        state.hasScannedCurrentPatient = false; // Reset flag cho bệnh nhân mới!
        logDebug(`[Patient] Chọn bệnh nhân mới: ${state.selectedPatient.name} (${currentCode})`);
      }
    }, 2000);
  }

  function scanAndAttachIframeListeners(handler) {
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (iframeDoc && !iframeDoc.__his_listener_attached__) {
          iframeDoc.__his_listener_attached__ = true;
          iframeDoc.addEventListener('click', handler, true);
        }
      } catch (e) {}
    });
  }

  /**
   * TRÍCH XUẤT CHÍNH XÁC THANH THÔNG TIN BỆNH NHÂN VNPT HIS:
   * Định dạng chuẩn VNPT HIS:
   * BA2607180160 | CHÂU THỊ MỸ KHUYÊN | 03/08/1990 (35 Tuổi) | Nữ | ... | Phòng :... | Giường :...
   */
  function extractPatientHeaderFromDOM() {
    const docsToScan = [document];
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const idoc = iframe.contentDocument || iframe.contentWindow.document;
        if (idoc) docsToScan.push(idoc);
      } catch (e) {}
    });

    docsToScan.forEach(doc => {
      // Tìm tất cả các phần tử có chứa dấu gạch đứng | đặc trưng của VNPT HIS header
      const elements = doc.querySelectorAll('div, span, p, td, b, strong');
      elements.forEach(el => {
        const text = (el.innerText || '').trim();
        // Kiểm tra xem dòng chữ có chứa thông tin bệnh nhân VNPT HIS chuẩn hay không
        if (text.includes('|') && (text.includes('Tuổi)') || text.includes('Tuổi') || text.includes('Phòng :') || text.includes('Giường :'))) {
          parseVNPTPatientHeaderString(text);
        }
      });
    });
  }

  /**
   * Tách chuỗi Header VNPT HIS thành các trường thông tin chuẩn:
   * "BA2607180160 | CHÂU THỊ MỸ KHUYÊN | 03/08/1990 (35 Tuổi) | Nữ | ... | Phòng :Buồng... | Giường :H030..."
   */
  function parseVNPTPatientHeaderString(headerStr) {
    const parts = headerStr.split('|').map(p => p.trim());
    if (parts.length < 3) return;

    // Part 0: Mã bệnh nhân / bệnh án
    if (parts[0]) {
      // Chi chap nhan ma BA/BN de tranh reset do so phieu, ngay thang, barcode.
      const codeMatch = parts[0].match(/\b(BA\d+|BN\d+[-_]?\d+)\b/i);
      const newCode = codeMatch ? codeMatch[1] : '';
      if (newCode && state.selectedPatient.code !== newCode) {
        state.selectedPatient.code = newCode;
        state.labResults = [];
        state.imagingResults = [];

        // Chi cap nhat thong tin benh nhan; khong tu dong autoscan de tranh lag.
      }
    }

    // Part 1: Tên bệnh nhân (Chữ in hoa)
    if (parts[1] && parts[1].length >= 3 && !/\d/.test(parts[1])) {
      state.selectedPatient.name = parts[1];
    }

    // Part 2: Ngày sinh & Tuổi (VD: 03/08/1990 (35 Tuổi))
    if (parts[2]) {
      const ageMatch = parts[2].match(/\((\d+)\s*Tuổi\)/i) || parts[2].match(/(\d+)\s*T/i);
      if (ageMatch) {
        state.selectedPatient.age = parseInt(ageMatch[1], 10);
      }
    }

    // Part 3: Giới tính (Nam / Nữ)
    if (parts[3] && (parts[3].toLowerCase() === 'nam' || parts[3].toLowerCase() === 'nữ')) {
      state.selectedPatient.gender = parts[3];
    }

    // Duyệt tìm Phòng & Giường trong các Part còn lại
    parts.forEach(part => {
      if (part.includes('Phòng :') || part.includes('Phòng:')) {
        state.selectedPatient.room = part.replace(/Phòng\s*:/i, '').trim();
      }
      if (part.includes('Giường :') || part.includes('Giường:')) {
        state.selectedPatient.bed = part.replace(/Giường\s*:/i, '').trim();
      }
    });

    updatePatientInfoUI();
  }

  function extractPatientInfoFromRow(row) {
    if (state.isScanning || _isRunningAutoScan) return;

    const text = row.innerText || '';
    // Chỉ chấp nhận mã BN/BA chuẩn để tránh nhận nhầm số phiếu, barcode, STT...
    const matchCode = text.match(/(BA\d+|BN\d+[-_]?\d+)/i);
    if (matchCode) {
      const newCode = matchCode[1];
      if (state.selectedPatient.code !== newCode) {
        state.selectedPatient.code = newCode;
        state.labResults = [];
        state.imagingResults = [];

        // Click benh nhan moi -> kich hoat mot lan luong XN nhe.
        setTimeout(() => requestAutoScanFromTop('row-new-patient'), 250);
      } else {
        return;
      }
    }

    const cells = Array.from(row.querySelectorAll('td, div, span')).map(c => c.innerText.trim()).filter(Boolean);
    const possibleName = cells.find(c => c.length >= 4 && !/\d{4,}/.test(c) && c.includes(' ') && /^[a-zA-ZàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵĐđ\s]+$/i.test(c));
    if (possibleName) {
      state.selectedPatient.name = possibleName;
    }

    updatePatientInfoUI();
  }

  function loadPatientData(patientCode) {
    if (state.isDemoMode) {
      const key = Object.keys(MOCK_PATIENTS_DATABASE).find(k => patientCode && patientCode.includes(k)) || 'DEFAULT';
      const data = MOCK_PATIENTS_DATABASE[key] || MOCK_PATIENTS_DATABASE['DEFAULT'];
      state.selectedPatient = { ...data.patient, code: patientCode || data.patient.code };
      state.labResults = data.lab;
      state.imagingResults = data.imaging;
      updatePatientInfoUI();
      renderContent();
    } else {
      extractRealDataFromHIS();
    }
  }

  /**
   * TRÍCH XUẤT DỮ LIỆU THẬT XÉT NGHIỆM VÀ CĐHA TỪ DOM VNPT HIS
   */
  function isElementVisible(el) {
    if (!el) return false;
    const hasSize = el.offsetWidth > 0 || el.offsetHeight > 0 || (el.getClientRects && el.getClientRects().length > 0);
    const hasText = el.innerText && el.innerText.trim().length > 10;
    return hasSize || hasText;
  }

  function getGridFullText(container) {
    let current = container;
    const ownerDoc = container.ownerDocument || document;
    while (current && current !== ownerDoc.body) {
      const cls = (current.className || '').toString().toLowerCase();
      const id = (current.id || '').toString().toLowerCase();
      const isJqGridInnerLayer =
        cls.includes('ui-jqgrid-btable') ||
        cls.includes('ui-jqgrid-htable') ||
        cls.includes('ui-jqgrid-bdiv') ||
        cls.includes('ui-jqgrid-hbox') ||
        cls.includes('ui-jqgrid-view');
      
      // Chỉ nhận diện các container grid thực tế của chính bảng này để tránh lan rộng
      if (
        cls.includes('dhtmlxgrid') ||
        cls.includes('jqx-grid') ||
        cls.includes('jqxgrid') ||
        (cls.includes('ui-jqgrid') && !isJqGridInnerLayer) ||
        cls.includes('gridbox') ||
        cls.includes('grid-box') ||
        id.includes('gridbox')
      ) {
        return (current.innerText || '').toLowerCase();
      }
      current = current.parentElement;
    }
    
    if (container.parentElement) {
      return (container.parentElement.innerText || '').toLowerCase();
    }
    return (container.innerText || '').toLowerCase();
  }

  function shouldSkipContainerForLabScan(container) {
    if (!container) return true;

    if (container.closest && container.closest('#his-assistant-drawer')) return true;

    const className = (container.className || '').toString().toLowerCase();
    const id = (container.id || '').toString().toLowerCase();
    const text = cleanString(container.innerText || '').toLowerCase();

    if (className.includes('his-abnormal-table')) return true;

    // Bo qua cac bang tim kiem, pager, dieu huong va cac o loc nho gay nhieu log.
    if (
      className.includes('ui-search-table') ||
      className.includes('ui-pg-table') ||
      className.includes('navtable') ||
      className.includes('ui-jqgrid-pager') ||
      className.includes('ui-jqgrid-hdiv') ||
      className.includes('ui-jqgrid-sdiv') ||
      id.includes('pager')
    ) {
      return true;
    }

    if (!text || text.length < 30) return true;

    // Cac tu khoa thuoc bang danh sach benh nhan/hanh chinh, khong phai bang ket qua XN.
    if (
      text.includes('danh sách bệnh nhân') ||
      text.includes('danh sach benh nhan') ||
      text.includes('phòng/giường') ||
      text.includes('phong/giuong') ||
      text.includes('họ tên') ||
      text.includes('ho ten') ||
      text.includes('mã ba') ||
      text.includes('ma ba') ||
      text.includes('ngày vv') ||
      text.includes('ngay vv') ||
      text.includes('vào khoa') ||
      text.includes('vao khoa') ||
      text.includes('mã bhyt') ||
      text.includes('ma bhyt') ||
      text.includes('icd-rv') ||
      text.includes('chờ nhập khoa') ||
      text.includes('cho nhap khoa') ||
      text.includes('đang điều trị') ||
      text.includes('dang dieu tri')
    ) {
      return true;
    }

    return false;
  }

  function isLabResultTable(container) {
    if (!container) return false;

    if (shouldSkipContainerForLabScan(container)) return false;
    
    // Lấy toàn bộ text của grid bao gồm cả phần Header cột
    const text = getGridFullText(container);

    if (!text || text.length < 30) return false;
    
    // Rút gọn text để in debug
    const textSnippet = text.substring(0, 80).replace(/\n/g, ' ');
    logDebug(`[Check] Bảng class="${container.className}". Chữ: "${textSnippet}..." (dài ${text.length} ký tự)`);

    // 1. Bỏ qua các bảng danh sách phiếu chỉ định (chứa Barcode, TG dự kiến...)
    if (text.includes('barcode') || text.includes('số phiếu') || text.includes('phiếu điều trị') || text.includes('bác sỹ chỉ định') || text.includes('tg chỉ định')) {
      logDebug(`[Bỏ qua] Grid chứa từ khóa danh sách phiếu chỉ định`);
      return false;
    }

    // 2. Bỏ qua các bảng danh sách phòng bệnh / tìm kiếm buồng giường
    if (text.includes('phòng số') || text.includes('buồng dịch vụ') || text.includes('phòng cấp cứu') || text.includes('giường :')) {
      logDebug(`[Bỏ qua] Grid chứa từ khóa buồng giường`);
      return false;
    }

    // 3. BỎ QUA BẢNG "DANH SÁCH DỊCH VỤ CHỈ ĐỊNH" (Chứa Số lượng, Loại thanh toán, Loại MBP, Viện phí)
    if (text.includes('danh sách dịch vụ chỉ định') || text.includes('dịch vụ chỉ định') || text.includes('loại thanh toán') || text.includes('loại mbp') || text.includes('số lượng') || text.includes('viện phí') || text.includes('thành tiền')) {
      logDebug(`[Bỏ qua] Grid chứa từ khóa viện phí/số lượng`);
      return false;
    }

    const textNorm = normalizeVietnameseText(text);

    const hasResultTableTitle = textNorm.includes('danh sach ket qua xet nghiem');

    const hasLabHeaders =
      (textNorm.includes('ma xet nghiem') || textNorm.includes('ten xet nghiem') || textNorm.includes('ten chi dinh')) &&
      (textNorm.includes('ket qua') || textNorm.includes('tri so binh thuong') || textNorm.includes('chi so binh thuong') || textNorm.includes('don vi'));

    const hasTechnicalLabMarkers =
      textNorm.includes('ketquaclsid') ||
      textNorm.includes('paramhashed') ||
      textNorm.includes('param_hashed') ||
      textNorm.includes('maubenhphamid') ||
      textNorm.includes('dichvuthuchienid') ||
      textNorm.includes('maxetnghiem') ||
      textNorm.includes('tenchidinh');

    // 4. Ưu tiên nhận diện bảng kết quả XN theo tiêu đề + header cột.
    if (hasResultTableTitle && (hasLabHeaders || hasTechnicalLabMarkers)) {
      logDebug(`[Chấp nhận] Khớp bảng 'Danh sách kết quả xét nghiệm' theo header/marker kỹ thuật`);
      return true;
    }

    // 5. Dự phòng: nhận diện bằng dải tham chiếu (VD: 3.5 - 5.0)
    const hasRange = /[\d.,]+\s*[-~–—]\s*[\d.,]+/.test(text);
    if (!hasRange) {
      logDebug(`[Bỏ qua] Grid không chứa dải tham chiếu (VD: 3.5 - 5.0)`);
      return false;
    }

    logDebug(`[Chấp nhận] Khớp bảng kết quả XN hợp lệ!`);
    return true;
  }

  function isGarbageIndicator(name, value) {
    if (!name || !value) return true;
    const n = name.trim().toLowerCase();
    const v = value.trim().toLowerCase();

    // Bỏ qua các chuỗi rác viện phí, thành tiền, phòng bệnh, buồng giường, năm sinh, filter x
    if (n.includes('viện phí') || v.includes('viện phí') || n.includes('thành tiền') || v.includes('thành tiền') || n.includes('đơn giá') || v.includes('đơn giá')) return true;
    if (n.includes('phòng số') || n.includes('buồng') || n.includes('giường') || n.includes('khoa')) return true;
    if (n === 'x' || v === 'x' || n === 'n/a' || v === 'n/a' || n === '---' || v === '---') return true;
    if (n === 'mã xét nghiệm' || n === 'tên xét nghiệm' || n === 'kết quả' || n === 'trị số bình thường' || n === 'stt') return true;
    if (v === 'mã xét nghiệm' || v === 'tên xét nghiệm' || v === 'kết quả' || v === 'trị số bình thường') return true;

    // Giá trị kết quả xét nghiệm bắt buộc phải là chuỗi số thập phân/nguyên hợp lệ
    // Đã loại bỏ tất cả khoảng trắng và các ký tự zero-width ẩn
    const valClean = value.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0\s]/g, '').replace(',', '.');
    const isNumeric = /^[-+]?\d+([.]\d+)?$/.test(valClean);
    if (!isNumeric && !isLikelyQualitativeResult(value) && !value.includes('*') && !value.toLowerCase().includes('tăng') && !value.toLowerCase().includes('giảm')) {
      return true; // Lọc bỏ các dòng chứa văn bản dịch vụ viện phí làm giá trị
    }

    if (name.length > 70 || value.length > 15) return true;
    if (/\d{2}\/\d{2}\/\d{4}/.test(name) || /\d{2}\/\d{2}\/\d{4}/.test(value)) return true; // Lọc bỏ dòng chứa ngày tháng
    if (/[A-F0-9]{12,}/i.test(name)) return true; // Lọc các mã GUID rác từ cache grid
    if (/(\d)\1{4,}/.test(value)) return true; // Lọc các dãy số lặp rác như 222222, 777777

    return false;
  }

  function queryAllContainersRecursively(doc) {
    let result = [];
    try {
      // Chi lay bang data chinh de tranh parse lap lai qua nhieu lop wrapper/pager.
      const containers = doc.querySelectorAll('table.ui-jqgrid-btable, table.jqx-grid-table, .dhtmlxGrid table');
      containers.forEach(c => {
        if (!shouldSkipContainerForLabScan(c)) {
          result.push({ container: c, doc: doc });
        }
      });

      doc.querySelectorAll('iframe').forEach(iframe => {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (iframeDoc) {
            result.push(...queryAllContainersRecursively(iframeDoc));
          }
        } catch(e) {}
      });
    } catch(e) {}
    return result;
  }

  let _lastExtractAt = 0;

  function extractRealDataFromHIS(force) {
    if (state.isDemoMode) return;

    const now = Date.now();
    if (!force && now - _lastExtractAt < 1000) return;
    _lastExtractAt = now;

    let realLabGroups = [];
    let realImagingGroups = [];

    // Quét toàn bộ DOM ở mọi iframe cùng nguồn đệ quy
    const allContainers = queryAllContainersRecursively(document);
    
    logDebug(`[Scan] Tìm thấy ${allContainers.length} containers ứng viên ở mọi frame`);

    let labMatchedCount = 0;
    allContainers.forEach(({ container, doc }) => {
      if (!isElementVisible(container)) return;
      if (shouldSkipContainerForLabScan(container)) return;

      // 1. QUÉT BẢNG KẾT QUẢ XÉT NGHIỆM CHÍNH XÁC
      if (isLabResultTable(container)) {
        labMatchedCount++;
        const parsedGroup = parseHISLabTable(container);
        if (parsedGroup && parsedGroup.indicators.length > 0) {
          realLabGroups.push(parsedGroup);
          logDebug(`[Success] Khớp bảng XN: ${parsedGroup.indicators.length} chỉ số`);
        } else {
          logDebug(`[Warning] Khớp bảng XN nhưng 0 chỉ số được bóc tách`);
        }
      }

      // 2. QUÉT BẢNG CHẨN ĐOÁN HÌNH ẢNH
      const text = container.innerText || '';
      if (text.includes('Danh sách kết quả chẩn đoán hình ảnh') || text.includes('TG trả KQ') || text.includes('BS kết luận') || text.includes('Mô tả') || text.includes('Kết luận') || text.includes('Xem phim')) {
        const parsedImaging = parseHISImagingTableVNPT(container);
        if (parsedImaging && parsedImaging.length > 0) {
          realImagingGroups.push(...parsedImaging);
        }
      }
    });

    if (labMatchedCount > 0) {
      logDebug(`[Scan] Tìm thấy ${labMatchedCount} bảng phù hợp tiêu chí XN`);
    }

    extractPatientHeaderFromDOM();

    if (realLabGroups.length > 0) {
      state.labResults = mergeDuplicateLabGroups([...state.labResults, ...realLabGroups]);
    }

    if (realImagingGroups.length > 0) {
      state.imagingResults = mergeImagingResults(state.imagingResults, realImagingGroups);
    }

    if (isTopFrame) {
      updatePatientInfoUI();
      renderContent();
    } else {
      // Vẫn gửi postMessage dự phòng cho các iframe con
      if (realLabGroups.length > 0 || realImagingGroups.length > 0) {
        try {
          window.top.postMessage({
            type: 'HIS_EXT_PARSED_DATA',
            patient: state.selectedPatient.code !== '---' ? state.selectedPatient : null,
            labResults: realLabGroups,
            imagingResults: realImagingGroups
          }, '*');
        } catch(e) {}
      }
    }
  }

  function parseHISImagingTableVNPT(table) {
    if (!isElementVisible(table)) return [];
    const rows = Array.from(table.querySelectorAll('tr'));
    let results = [];

    rows.forEach(r => {
      const cells = Array.from(r.querySelectorAll('td')).map(c => c.innerText.trim());
      if (cells.length >= 3) {
        const fullRowText = cells.join(' ').toLowerCase();
        if (fullRowText.includes('tên dịch vụ') && fullRowText.includes('kết luận')) return;

        let serviceName = cells.find(c => 
          c.length > 3 && 
          !/^\d+$/.test(c) && 
          !/\d{2}\/\d{2}\/\d{4}/.test(c) && 
          !c.toLowerCase().includes('bác sĩ') && 
          !c.toLowerCase().includes('bs') &&
          !c.toLowerCase().includes('tên dịch vụ') &&
          !c.toLowerCase().includes('kết luận')
        ) || 'Chẩn đoán hình ảnh';

        let conclusion = cells[cells.length - 1] || cells[cells.length - 2] || 'Đã có kết quả CĐHA.';
        if (conclusion.length < 3 || conclusion.toLowerCase().includes('kết luận')) {
          conclusion = 'Hiện tại không phát hiện tổn thương bất thường.';
        }

        let doctor = cells.find(c => c.toLowerCase().includes('bs') || c.toLowerCase().includes('bác sĩ') || c.includes('Nguyễn') || c.includes('Trần') || c.includes('Lê') || c.includes('Phạm') || c.includes('Hoàng')) || 'Bác sĩ CĐHA';
        let date = cells.find(c => /\d{2}\/\d{2}\/\d{4}/.test(c)) || new Date().toLocaleDateString('vi-VN');

        let dicomUrl = '';
        const interactiveElements = r.querySelectorAll('a, button, img, [onclick], [data-url], [data-pacs], [data-dicom], [data-link]');
        interactiveElements.forEach(el => {
          if (dicomUrl) return;
          const href = el.getAttribute('href') || el.href || '';
          const onclick = el.getAttribute('onclick') || '';
          const dataUrl = el.getAttribute('data-url') || el.getAttribute('data-pacs') || el.getAttribute('data-dicom') || el.getAttribute('data-link') || '';

          const combined = `${href} ${onclick} ${dataUrl}`;
          const urlMatch = combined.match(/(https?:\/\/[^\s'"<>]+)/i);
          if (urlMatch) {
            dicomUrl = urlMatch[1];
          } else if (href && href !== '#' && !href.startsWith('javascript:')) {
            dicomUrl = href;
          }
        });

        if (!dicomUrl && (fullRowText.includes('pacs') || fullRowText.includes('dicom') || fullRowText.includes('xem phim') || fullRowText.includes('xem ảnh') || r.querySelector('.dc-icon, img[src*="dicom"], img[src*="pacs"]'))) {
          dicomUrl = `https://pacs.vnpt.vn/viewer?patientId=${state.selectedPatient.code || 'BA2607180160'}`;
        }

        if (serviceName && !serviceName.toLowerCase().includes('stt')) {
          results.push({
            serviceName: serviceName,
            conclusion: conclusion,
            doctor: doctor,
            date: date,
            dicomUrl: dicomUrl,
            slices: serviceName.toLowerCase().includes('ct') ? 12 : serviceName.toLowerCase().includes('x-quang') ? 2 : 6
          });
        }
      }
    });

    return results;
  }

  function detectColumnIndices(rows, container) {
    let codeIdx = -1, nameIdx = -1, valIdx = -1, unitIdx = -1, rangeIdx = -1;

    // Tìm trong bảng header rời của jqGrid / dhtmlxGrid / HTML table (như .ui-jqgrid-htable hoặc thead)
    const gridEl = container ? container.closest('.dhtmlxGrid, .jqx-grid, .ui-jqgrid, [role="grid"], div[class*="grid"], div[class*="Grid"]') : null;
    let headerRows = [];
    if (gridEl) {
      headerRows = Array.from(gridEl.querySelectorAll('table.hdr tr, table.ui-jqgrid-htable tr, .jqx-grid-header tr, thead tr'));
    }

    const allHeaderRows = [...headerRows, ...rows];

    allHeaderRows.forEach(r => {
      const cells = Array.from(r.querySelectorAll('th, td')).map(c => cleanString(c.innerText));
      const rowTextLower = cells.join(' ').toLowerCase();

      if (rowTextLower.includes('danh sách') && cells.length < 3) return;

      cells.forEach((text, i) => {
        const t = text.toLowerCase();
        const tNorm = normalizeVietnameseText(text);
        if (tNorm === 'ma xet nghiem' || tNorm === 'ma xn' || tNorm === 'ma chi so' || tNorm.includes('ma xet nghiem')) {
          codeIdx = i;
        } else if (tNorm === 'ten xet nghiem' || tNorm === 'ten chi so' || tNorm === 'chi so' || tNorm === 'ten xet nghiem/chi so' || tNorm === 'ten dv' || tNorm.includes('ten chi dinh')) {
          nameIdx = i;
        } else if (
          tNorm === 'ket qua' ||
          tNorm === 'gia tri ket qua' ||
          tNorm === 'ket qua cls' ||
          (tNorm.startsWith('ket qua ') && !tNorm.includes('id'))
        ) {
          valIdx = i;
        } else if (tNorm.includes('tri so binh thuong') || tNorm.includes('chi so binh thuong') || tNorm.includes('tri so bt') || tNorm.includes('tham chieu') || tNorm.includes('gioi han')) {
          rangeIdx = i;
        } else if (tNorm === 'don vi' || tNorm === 'dvt') {
          unitIdx = i;
        }
      });
    });

    // Cột mặc định chuẩn VNPT HIS: Col 2 (Mã XN), Col 3 (Tên XN), Col 4 (Kết quả), Col 5 (Trị số BT)
    if (codeIdx === -1) codeIdx = 2;
    if (nameIdx === -1) nameIdx = 3;
    if (valIdx === -1) valIdx = 4;
    if (rangeIdx === -1) rangeIdx = 5;

    return { codeIdx, nameIdx, valIdx, unitIdx, rangeIdx };
  }

  function isRowStatusText(text) {
    const t = normalizeVietnameseText(text || '');
    return (
      t.includes('da tra ket qua') ||
      t.includes('cho thuc hien') ||
      t.includes('dang thuc hien') ||
      t.includes('chua co ket qua') ||
      t === 'x'
    );
  }

  function extractPerformedAtFromCells(cells) {
    const joined = (cells || []).join(' ');
    const match = joined.match(/\b\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}:\d{2})?\b/);
    return match ? match[0] : '';
  }

  function isLikelyIndicatorLabel(text) {
    const value = cleanString(text || '');
    if (!value) return false;
    if (/\d/.test(value)) return false;
    if (isRowStatusText(value) || isLikelyQualitativeResult(value)) return false;
    if (value.length < 2 || value.length > 16) return false;
    return /^[A-ZÀ-Ỵ%()+/#.-]+$/i.test(value);
  }

  function pickIndicatorLabel(cells, fallbackName, codeVal) {
    const candidates = (cells || []).map(c => cleanString(c)).filter(Boolean);
    const hashLabel = candidates.find(c => /#/.test(c) && /^[A-ZÀ-Ỵ0-9#%()+/.-]+$/i.test(c) && c.length <= 8);
    if (hashLabel) return hashLabel;

    const shortLabel = candidates.find(c => /^[A-ZÀ-Ỵ%()+/.-]{2,8}$/i.test(c) && !/\d/.test(c));
    if (shortLabel) return shortLabel;

    const preferred = candidates.find(c => isLikelyIndicatorLabel(c));
    if (preferred) return preferred;

    const codeLike = candidates.find(c => {
      if (!c || c === fallbackName || c === codeVal) return false;
      if (c.includes(' ')) return false;
      if (/^\d+$/.test(c)) return false;
      return /^[A-Z]{1,4}\d+[A-Z0-9._-]*$/i.test(c) || /^[A-Z]\d{1,3}$/i.test(c);
    });
    if (codeLike && fallbackName && codeLike !== fallbackName) return fallbackName;

    return fallbackName || '';
  }

  function parseRowSemantically(cells) {
    if (!cells || cells.length < 2) return null;

    const cleaned = cells.map(c => cleanString(c)).filter(Boolean);
    if (cleaned.length < 2) return null;

    const rowJoined = normalizeVietnameseText(cleaned.join(' '));
    if (
      rowJoined.includes('ma xet nghiem') ||
      rowJoined.includes('ten xet nghiem') ||
      rowJoined.includes('ten chi dinh')
    ) {
      return null;
    }

    const labelCandidate = cleaned.find(c => /#/.test(c) && /^[A-ZÀ-Ỵ0-9#%()+/.-]+$/i.test(c) && c.length <= 8) ||
      cleaned.find(c => /^[A-ZÀ-Ỵ%()+/.-]{2,8}$/i.test(c) && !/\d/.test(c));

    // Uu tien ket qua dinh tinh truoc de tranh lay nham ma so ky thuat.
    let valueCandidate = cleaned.find(c => {
      if (isRowStatusText(c)) return false;
      return isLikelyQualitativeResult(c);
    }) || '';

    // Neu khong co dinh tinh, moi tim ket qua so nhung loai bo ID dai.
    if (!valueCandidate) {
      valueCandidate = cleaned.find(c => {
        if (isRowStatusText(c)) return false;
        const v = c.replace(/\s/g, '').replace(',', '.');
        if (/^\d{6,}$/.test(v)) return false;
        return /^[-+]?\d+(\.\d+)?$/.test(v) || /\b[HL]\b/i.test(c) || c.includes('*');
      }) || '';
    }

    const rangeCandidate = cleaned.find(c => {
      const n = normalizeVietnameseText(c);
      if (!n) return false;
      if (/^[A-Z]\d{1,3}-\d+$/i.test(c)) return false;
      if (/^[A-Z]{1,3}\d{1,3}-\d+$/i.test(c)) return false;
      return /[\d.,]+\s*[-~–—]\s*[\d.,]+/.test(c) || /<=?\s*[\d.,]+|>=?\s*[\d.,]+/.test(c);
    }) || '';

    let nameCandidate = cleaned.find(c => {
      const n = normalizeVietnameseText(c);
      if (!n || n.length < 3) return false;
      if (isRowStatusText(c)) return false;
      if (isLikelyQualitativeResult(c)) return false;
      if (/^[A-Z]\d{1,3}-\d+$/i.test(c)) return false;
      if (/^[A-Z]{1,3}\d{1,3}-\d+$/i.test(c)) return false;
      if (/^[A-F0-9]{16,}$/i.test(c.replace(/\s/g, ''))) return false;
      if (/^\d{6,}$/.test(c.replace(/\s/g, ''))) return false;
      if (/^\d{1,2}(\.\d{2,}){2,}$/.test(c)) return false;
      if (/\d{2}\/\d{2}\/\d{4}/.test(c)) return false;
      if (n.includes('paramhashed') || n.includes('maubenhphamid') || n.includes('ketquaclsid') || n.includes('dichvuthuchienid')) return false;
      return /[a-zA-ZàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/.test(c);
    }) || '';

    if (!nameCandidate && cleaned.length > 0) {
      nameCandidate = cleaned.find(c => {
        if (isRowStatusText(c) || isLikelyQualitativeResult(c)) return false;
        if (/^[A-Z]\d{1,3}-\d+$/i.test(c)) return false;
        if (/^[A-Z]{1,3}\d{1,3}-\d+$/i.test(c)) return false;
        return true;
      }) || '';
    }

    if (labelCandidate) {
      nameCandidate = labelCandidate;
    }

    if (!nameCandidate || !valueCandidate) return null;

    return {
      name: nameCandidate,
      value: valueCandidate,
      unit: '',
      range: rangeCandidate,
      status: evaluateAbnormalStatus(valueCandidate, rangeCandidate)
    };
  }

  function parseRowDynamically(cells, rowElement) {
    if (!cells || cells.length < 2) return null;

    let value = '';
    let range = '';
    let code = '';
    let name = '';
    let testName = '';
    let unit = '';

    const nonDateCells = cells.filter(c => c && !/\d{2}\/\d{2}\/\d{4}/.test(c));

    const textCandidates = nonDateCells.filter(c => {
      if (!c || isRowStatusText(c) || isLikelyQualitativeResult(c)) return false;
      if (/^[A-Z]\d{1,3}-\d+$/i.test(c)) return false;
      if (/^[A-Z]{1,3}\d{1,3}-\d+$/i.test(c)) return false;
      return /[a-zA-ZàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/.test(c);
    });

    // 1. Tìm ô dải tham chiếu (chứa pattern "min - max" như "3.5 - 5.0mmol/l" hoặc "0 - 42u/l")
    const rangeIdx = nonDateCells.findIndex(c => {
      if (/^[A-Z]\d{1,3}-\d+$/i.test(c)) return false;
      if (/^[A-Z]{1,3}\d{1,3}-\d+$/i.test(c)) return false;
      return /[\d.,]+\s*[-~–—]\s*[\d.,]+/.test(c);
    });
    if (rangeIdx !== -1) {
      range = nonDateCells[rangeIdx];
      const uMatch = range.match(/[0-9.,\s]+([a-zA-Z%^/0-9μµL]+)/);
      if (uMatch) unit = uMatch[1].trim();
    }

    // 2. Tìm ô giá trị (chứa số kết quả như "3.2", "97", "47.15", "7.73")
    const valIdx = nonDateCells.findIndex((c, idx) => 
      idx !== rangeIdx &&
      /^[-+]?\d+([.,]\d+)?$/.test(c) &&
      !/^(19|20)\d{2}$/.test(c) &&
      !/^\d{5,}$/.test(c)
    );

    if (valIdx !== -1) {
      value = nonDateCells[valIdx];
    }

    // Dữ liệu định tính (HIV test nhanh, PCR...) có thể không phải số.
    if (!value) {
      const qualitativeIdx = nonDateCells.findIndex((c, idx) => {
        if (idx === rangeIdx) return false;
        const cNorm = normalizeVietnameseText(c);
        if (!isLikelyQualitativeResult(c)) return false;
        if (cNorm.includes('ma xet nghiem') || cNorm.includes('ten xet nghiem') || cNorm.includes('ten chi dinh')) return false;
        return true;
      });
      if (qualitativeIdx !== -1) {
        value = nonDateCells[qualitativeIdx];
      }
    }

    if (!value && !range) return null;

    const hashLabel = nonDateCells.find(c => /#/.test(c) && /^[A-ZÀ-Ỵ0-9#%()+/.-]+$/i.test(c) && c.length <= 8) || '';
    if (hashLabel) {
      name = hashLabel;
    }

    const longNameCandidate = textCandidates.find(c => c.length > 18 && /\s/.test(c)) || '';
    if (longNameCandidate) {
      testName = longNameCandidate;
    }

    // 3. Tìm ô mã chỉ số
    const codeIdx = nonDateCells.findIndex(c => {
      if (c === value || c.includes(' ')) return false;
      if (/^[A-Z]\d{1,3}-\d+$/i.test(c)) return false;
      return /^[A-Z0-9._-]{2,15}$/i.test(c);
    });
    if (codeIdx !== -1) {
      code = nonDateCells[codeIdx];
    }

    // 4. Tìm ô tên chỉ số
    const nameIdx = nonDateCells.findIndex((c, idx) => 
      idx !== rangeIdx && idx !== valIdx && idx !== codeIdx &&
      c.length >= 2 && !/^\d+$/.test(c) &&
      c.toLowerCase() !== 'x' && c.toLowerCase() !== 'n/a' &&
      !c.toLowerCase().includes('mã xét nghiệm') && !c.toLowerCase().includes('tên xét nghiệm')
    );
    if (nameIdx !== -1) {
      name = nonDateCells[nameIdx];
    }

    if (!testName) {
      testName = nonDateCells.find(c => c !== name && c !== value && c !== range && /\s/.test(c) && c.length > 8) || '';
    }

    // Nếu tên đang là chuỗi dài của cả xét nghiệm, đổi lại ưu tiên mã ngắn như HGB/PLT/WBC.
    if (name && name.length > 12 && textCandidates.length > 0) {
      const shortCode = textCandidates.find(c => /^[A-Z]{1,6}\d{0,3}(?:[%/\-][A-Z0-9]+)?$/i.test(c) || /^[A-Z]{2,6}$/i.test(c));
      if (shortCode) {
        name = shortCode;
      }
    }

    name = pickIndicatorLabel(nonDateCells, name, code);
    if (!name && code) name = code;
    if (code && name && !name.includes(code) && /^[A-Z0-9._-]+$/i.test(code)) name = `${name} (${code})`;

    if (!name || !value) return null;

    // Đánh giá trạng thái bất thường
    const rowHtml = rowElement ? (rowElement.innerHTML || '') : '';
    const rowStyle = rowElement ? (rowElement.getAttribute('style') || '').toLowerCase() : '';
    
    const isRedText = rowHtml.includes('color: red') || rowHtml.includes('color:red') || rowHtml.includes('#red') ||
                      rowHtml.includes('#d13438') || rowHtml.includes('#ef4444') || rowHtml.includes('#ff0000') ||
                      rowStyle.includes('red') || (rowElement && rowElement.querySelector('[style*="red"], .red, font[color="red"]') !== null);

    const isBlueText = rowHtml.includes('color: blue') || rowHtml.includes('color:blue') || rowHtml.includes('#blue') ||
                       rowHtml.includes('#3b82f6') || rowHtml.includes('#0000ff') || rowStyle.includes('blue') ||
                       (rowElement && rowElement.querySelector('[style*="blue"], .blue, font[color="blue"]') !== null);

    let status = evaluateAbnormalStatus(value, range);
    if (isRedText && status === 'NORMAL') status = 'HIGH';
    if (isBlueText && status === 'NORMAL') status = 'LOW';

    return { name, value, unit, range, status, testName: testName || '', performedAt: '' };
  }

  function parseHISLabTable(container) {
    if (!isElementVisible(container)) return null;

    const rows = Array.from(container.querySelectorAll('tr, div[role="row"]'));
    logDebug(`[Parse] Bảng có ${rows.length} hàng`);
    if (rows.length === 0) return null;

    let serviceName = 'Xét nghiệm cận lâm sàng';
    let indicators = [];

    const { codeIdx, nameIdx, valIdx, unitIdx, rangeIdx } = detectColumnIndices(rows, container);
    logDebug(`[Parse] Phát hiện cột: code=${codeIdx}, name=${nameIdx}, val=${valIdx}, range=${rangeIdx}`);

    rows.forEach((r, idx) => {
      // Giữ nguyên các ô rỗng để chỉ số cột (index) khớp 1-to-1 chính xác với Header
      const cells = Array.from(r.querySelectorAll('td, th').length > 0 ? r.querySelectorAll('td, th') : r.querySelectorAll('div[role="gridcell"], div.jqx-grid-cell, div')).map(c => cleanString(c.innerText));
      const cellsClean = cells.filter(Boolean);
      if (cellsClean.length < 2) {
        return;
      }
      const performedAt = extractPerformedAtFromCells(cellsClean);

      const rowTextNorm = normalizeVietnameseText(cellsClean.join(' '));
      if (
        rowTextNorm.includes('tr. /') ||
        rowTextNorm.includes('1 den') ||
        rowTextNorm.includes('/ 1') ||
        rowTextNorm.includes('50100150') ||
        rowTextNorm.includes('150100150')
      ) {
        return;
      }

      if (cells.length === 1 || r.classList.contains('group-header') || r.classList.contains('jqx-grid-groups-row')) {
        const groupText = r.innerText.trim().replace(/^[☒☑\s+-\s]+/, '');
        if (groupText && !groupText.toLowerCase().includes('mã xét nghiệm') && !groupText.toLowerCase().includes('danh sách')) {
          serviceName = groupText;
          logDebug(`[Parse] Group header mới: "${serviceName}"`);
        }
        return;
      }

      // 1. Giải mã động ô dữ liệu
      const dynamicInd = parseRowDynamically(cells, r);
      if (dynamicInd) {
        const isGarbage = isGarbageIndicator(dynamicInd.name, dynamicInd.value);
        logDebug(`[Parse] Dòng ${idx}: name="${dynamicInd.name}", value="${dynamicInd.value}", range="${dynamicInd.range}", isGarbage=${isGarbage}`);
        if (!isGarbage) {
          if (serviceName === 'Xét nghiệm cận lâm sàng' && dynamicInd.testName) {
            serviceName = dynamicInd.testName;
          }
          indicators.push({ ...dynamicInd, performedAt, testName: serviceName });
          return;
        }
      } else {
        logDebug(`[Parse] Dòng ${idx}: Không phân tích động được. cells: [${cells.join(' | ')}]`);
      }

      // 1b. Dự phòng theo ngữ nghĩa để bắt kết quả định tính/không chuẩn cột
      const semanticInd = parseRowSemantically(cells);
      if (semanticInd) {
        const isGarbage = isGarbageIndicator(semanticInd.name, semanticInd.value);
        logDebug(`[Parse] Dòng ${idx} Semantic: name="${semanticInd.name}", value="${semanticInd.value}", range="${semanticInd.range}", isGarbage=${isGarbage}`);
        if (!isGarbage) {
          if (serviceName === 'Xét nghiệm cận lâm sàng' && semanticInd.testName) {
            serviceName = semanticInd.testName;
          }
          indicators.push({ ...semanticInd, performedAt, testName: serviceName });
          return;
        }
      }

      // 2. Dự phòng giải mã theo cột cố định
      const rowTextLower = cells.join(' ').toLowerCase();
      if (rowTextLower.includes('tên xét nghiệm') || rowTextLower.includes('mã xét nghiệm') || rowTextLower.includes('danh sách kết quả')) {
        return;
      }

      const codeVal = cells[codeIdx] || '';
      const testNameCell = cells[nameIdx] || '';
      let name = cells[nameIdx + 1] || testNameCell || '';
      const value = cells[valIdx] || '';
      let range = rangeIdx !== -1 ? (cells[rangeIdx] || '') : '';
      let unit = unitIdx !== -1 ? (cells[unitIdx] || '') : '';

      if (codeVal && name && !name.includes(codeVal) && /^[A-Z0-9._-]+$/i.test(codeVal)) {
        name = `${name} (${codeVal})`;
      }

      if (!unit && range) {
        const unitMatch = range.match(/[0-9.,\s]+([a-zA-Z%^/0-9μµL]+)/);
        if (unitMatch) {
          unit = unitMatch[1].trim();
        }
      }

      name = pickIndicatorLabel(cells, name, codeVal);
      const isGarbage = isGarbageIndicator(name, value);
      logDebug(`[Parse] Dòng ${idx} Fallback: name="${name}", value="${value}", range="${range}", isGarbage=${isGarbage}`);
      if (!isGarbage) {
        let status = evaluateAbnormalStatus(value, range);
        if (serviceName === 'Xét nghiệm cận lâm sàng' && name && name.length > 12) {
          const shortCode = [codeVal, ...cells].find(c => c && /^[A-Z]{2,6}$/i.test(c));
          if (shortCode) {
            name = shortCode;
          }
        }
        if (serviceName === 'Xét nghiệm cận lâm sàng') {
          const rowTestName = testNameCell || cells.find(c => c && c.length > 18 && /\s/.test(c)) || '';
          if (rowTestName) serviceName = rowTestName;
        }
        indicators.push({ name, value, unit, range, status, performedAt, testName: serviceName });
      }
    });

    return { serviceName, indicators };
  }

  function parseRealXHRResponse(url, rawResponseText) {
    if (!rawResponseText) return;
    try {
      const text = rawResponseText.trim();
      let parsed = null;

      if (text.startsWith('{') || text.startsWith('[')) {
        parsed = JSON.parse(text);
      } else {
        const startObj = text.indexOf('{');
        const startArr = text.indexOf('[');
        let start = -1;
        if (startObj !== -1 && startArr !== -1) start = Math.min(startObj, startArr);
        else start = startObj !== -1 ? startObj : startArr;

        if (start !== -1) {
          const candidate = text.slice(start);
          try {
            parsed = JSON.parse(candidate);
          } catch (e) {}
        }
      }

      if (parsed) {
        const json = parsed;
        let items = [];
        if (Array.isArray(json)) {
          items = json;
        } else if (json.data && Array.isArray(json.data)) {
          items = json.data;
        } else if (json.result && Array.isArray(json.result)) {
          items = json.result;
        } else if (json.rows && Array.isArray(json.rows)) {
          items = json.rows;
        }

        if (items.length > 0) {
          processHISJSONData(items);
        }
      }
    } catch(e) {}
  }

  function processHISJSONData(items) {
    let labIndicators = [];
    let imagingItems = [];

    items.forEach(item => {
      const normalizeKey = (k) => String(k || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');

      const pickField = (obj, directKeys, normalizedKeys) => {
        for (const k of directKeys) {
          if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
            return obj[k];
          }
        }

        const targetSet = new Set(normalizedKeys);
        for (const rawKey of Object.keys(obj || {})) {
          const nk = normalizeKey(rawKey);
          if (targetSet.has(nk)) {
            const val = obj[rawKey];
            if (val !== undefined && val !== null && String(val).trim() !== '') {
              return val;
            }
          }
        }

        return undefined;
      };

      // 1. Quét Xét nghiệm
      const name = pickField(item,
        ['TEN_CHI_SO', 'TEN_DV', 'TEN_XETNGHIEM', 'TEN_CHISO', 'CHISO_TEN', 'NAME', 'TEN_CHI_DINH', 'TENCHIDINH'],
        ['tenchiso', 'tendv', 'tenxetnghiem', 'chisoten', 'name', 'tenchidinh']
      );
      const value = pickField(item,
        ['KET_QUA', 'GIATRI', 'RESULT', 'KETQUA', 'VAL', 'KET_QUA_CLS', 'KETQUA_CLS', 'KETQUACLS'],
        ['ketqua', 'giatri', 'result', 'val', 'ketquacls']
      );
      const range = pickField(item,
        ['TRI_SO_BT', 'CHISO_BT', 'TRI_SO_BINH_THUONG', 'GIATRI_BT', 'RANGE', 'TRI_SO_BT_NAM', 'TRI_SO_BT_NU'],
        ['trisobt', 'chisobt', 'trisobinhthuong', 'giatribt', 'range', 'trisobtnam', 'trisobtnu']
      );
      const unit = pickField(item,
        ['DON_VI', 'DONVI', 'UNIT', 'DVT'],
        ['donvi', 'unit', 'dvt']
      );
      const serviceName = pickField(item,
        ['TEN_DICH_VU', 'TEN_DVKT', 'TEN_NHOM', 'TEN_CHI_DINH'],
        ['tendichvu', 'tendvkt', 'tennhom', 'tenchidinh']
      ) || 'Xét nghiệm cận lâm sàng';
      const performedAt = pickField(item,
        ['NGAY_TRA_KQ', 'NGAY_THUC_HIEN', 'NGAY_KET_QUA', 'DATE', 'NGAY'],
        ['ngaytrakq', 'ngaythuchien', 'ngayketqua', 'date', 'ngay']
      ) || '';

      if (name && value && name !== 'STT') {
        const status = evaluateAbnormalStatus(String(value), String(range || ''));
        labIndicators.push({ serviceName, performedAt, indicator: { name, value, unit: unit || '', range: range || '', status, performedAt, testName: serviceName } });
      }

      // 2. Quét CĐHA / PACS / DICOM
      const imgServiceName = item.TEN_DICH_VU || item.TEN_CDHA || item.TEN_DVKT || item.SERVICE_NAME;
      const conclusion = item.KET_LUAN || item.KETLUAN || item.MO_TA || item.MOTA || item.CONCLUSION;
      const doctor = item.BS_DOC || item.TEN_BS || item.BS_KETLUAN || item.DOCTOR_NAME;
      const dicomUrl = item.URL_PACS || item.LINK_PACS || item.LINK_DICOM || item.DICOM_URL || item.URL || item.PATH;
      const date = item.NGAY_TRA_KQ || item.NGAY_THUC_HIEN || item.DATE;

      if (imgServiceName && (conclusion || dicomUrl) && (imgServiceName.toLowerCase().includes('chụp') || imgServiceName.toLowerCase().includes('siêu âm') || imgServiceName.toLowerCase().includes('ct') || imgServiceName.toLowerCase().includes('x-quang') || imgServiceName.toLowerCase().includes('mri') || dicomUrl)) {
        imagingItems.push({
          serviceName: imgServiceName,
          conclusion: conclusion || 'Đã có kết quả CĐHA.',
          doctor: doctor || 'Bác sĩ CĐHA',
          date: date || new Date().toLocaleDateString('vi-VN'),
          dicomUrl: dicomUrl || `https://pacs.vnpt.vn/viewer?patientId=${state.selectedPatient.code}`,
          slices: (imgServiceName && imgServiceName.toLowerCase().includes('ct')) ? 12 : 2
        });
      }
    });

    const grouped = {};
    labIndicators.forEach(i => {
      const key = `${i.serviceName || ''}|||${i.performedAt || ''}`;
      if (!grouped[key]) {
        grouped[key] = { serviceName: i.serviceName || 'Xét nghiệm cận lâm sàng', performedAt: i.performedAt || '', indicators: [] };
      }
      grouped[key].indicators.push(i.indicator);
    });

    const parsedLabGroups = Object.keys(grouped).map(key => grouped[key]);

    if (isTopFrame) {
      if (parsedLabGroups.length > 0) {
        state.labResults = mergeDuplicateLabGroups([...state.labResults, ...parsedLabGroups]);
      }
      if (imagingItems.length > 0) {
        state.imagingResults = mergeImagingResults(state.imagingResults, imagingItems);
      }
      updatePatientInfoUI();
      renderContent();
    } else {
      // KHUNG PHỤ: Chuyển tiếp kết quả bóc từ mạng lên Khung chính
      if (parsedLabGroups.length > 0 || imagingItems.length > 0) {
        try {
          window.top.postMessage({
            type: 'HIS_EXT_PARSED_DATA',
            patient: state.selectedPatient.code !== '---' ? state.selectedPatient : null,
            labResults: parsedLabGroups,
            imagingResults: imagingItems
          }, '*');
        } catch(e) {}
      }
    }
  }

  function mergeDuplicateLabGroups(groups) {
    const map = {};
    groups.forEach(g => {
      const sName = g.serviceName || 'Xét nghiệm cận lâm sàng';
      const performedAt = g.performedAt || '';
      const key = `${sName}|||${performedAt}`;
      if (!map[key]) map[key] = { serviceName: sName, performedAt, indicators: [] };
      g.indicators.forEach(ind => {
        if (isGarbageIndicator(ind.name, ind.value)) return;
        // Không gộp chỉ theo tên vì cùng chỉ số có thể xuất hiện ở nhiều phiếu khác nhau.
        const fingerprint = `${ind.name || ''}|${ind.value || ''}|${ind.range || ''}|${ind.unit || ''}|${ind.status || ''}|${ind.performedAt || performedAt}`;
        const exists = map[key].indicators.find(x => `${x.name || ''}|${x.value || ''}|${x.range || ''}|${x.unit || ''}|${x.status || ''}|${x.performedAt || ''}` === fingerprint);
        if (!exists) {
          map[key].indicators.push(ind);
        }
      });
    });

    return Object.keys(map)
      .map(key => map[key])
      .filter(g => g.indicators.length > 0);
  }

  function mergeImagingResults(existingItems, incomingItems) {
    const merged = [];
    const seen = new Set();

    [...(existingItems || []), ...(incomingItems || [])].forEach(item => {
      if (!item || !item.serviceName) return;
      const key = [
        item.serviceName || '',
        item.date || '',
        item.doctor || '',
        item.conclusion || '',
        item.dicomUrl || ''
      ].join('|').toLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    });

    return merged;
  }

  function evaluateAbnormalStatus(valueStr, rangeStr) {
    if (!valueStr) return 'NORMAL';
    const val = parseFloat(valueStr.replace(',', '.'));

    if (valueStr.includes('*') || /\bH\b/i.test(valueStr) || valueStr.toLowerCase().includes('tăng')) return 'HIGH';
    if (/\bL\b/i.test(valueStr) || valueStr.toLowerCase().includes('giảm')) return 'LOW';

    if (isNaN(val) || !rangeStr) return 'NORMAL';

    const rangeMatch = rangeStr.match(/([\d.,]+)\s*[-~–—]\s*([\d.,]+)/);
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1].replace(',', '.'));
      const max = parseFloat(rangeMatch[2].replace(',', '.'));
      if (!isNaN(min) && val < min) return 'LOW';
      if (!isNaN(max) && val > max) return 'HIGH';
    }

    const maxMatch = rangeStr.match(/<=\s*([\d.,]+)|<\s*([\d.,]+)/);
    if (maxMatch) {
      const max = parseFloat((maxMatch[1] || maxMatch[2]).replace(',', '.'));
      if (!isNaN(max) && val > max) return 'HIGH';
    }

    const minMatch = rangeStr.match(/>=\s*([\d.,]+)|>\s*([\d.,]+)/);
    if (minMatch) {
      const min = parseFloat((minMatch[1] || minMatch[2]).replace(',', '.'));
      if (!isNaN(min) && val < min) return 'LOW';
    }

    return 'NORMAL';
  }

  function updatePatientInfoUI() {
    const p = state.selectedPatient;
    const pName = document.getElementById('his-p-name');
    const pCode = document.getElementById('his-p-code');
    const pGenderAge = document.getElementById('his-p-gender-age');
    const pRoom = document.getElementById('his-p-room');

    if (pName) pName.textContent = p.name || 'Bệnh nhân';
    if (pCode) pCode.textContent = p.code || 'BN---';
    if (pGenderAge) pGenderAge.textContent = `${p.age || '--'} tuổi | Giới tính: ${p.gender || '--'}`;
    if (pRoom) pRoom.textContent = `${p.room || ''} - ${p.bed || ''}`;
  }

  function renderContent() {
    const body = document.getElementById('his-drawer-body-content');
    if (!body) return;

    let totalAbnormalCount = 0;
    state.labResults.forEach(group => {
      group.indicators.forEach(ind => {
        if (ind.status === 'HIGH' || ind.status === 'LOW') totalAbnormalCount++;
      });
    });

    const totalImagingCount = state.imagingResults.length;

    const countLab = document.getElementById('his-count-lab');
    const countImg = document.getElementById('his-count-imaging');
    const triggerBadge = document.getElementById('his-trigger-badge');

    if (countLab) countLab.textContent = totalAbnormalCount;
    if (countImg) countImg.textContent = totalImagingCount;
    if (triggerBadge) triggerBadge.textContent = totalAbnormalCount + totalImagingCount;

    if (state.isScanning) {
      renderLoading(body);
    } else if (state.activeTab === 'lab') {
      renderLabResults(body);
    } else {
      renderImagingResults(body);
    }
  }

  function renderLoading(container) {
    container.innerHTML = `
      <style>
        @keyframes his-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 40px 20px; text-align: center; color: #1e3a8a; min-height: 250px;">
        <div style="width: 42px; height: 42px; border: 4px solid #e2e8f0; border-top: 4px solid #3b82f6; border-radius: 50%; animation: his-spin 1s linear infinite; margin-bottom: 20px;"></div>
        <div style="font-weight: 600; font-size: 14px; margin-bottom: 6px; color: #1e293b;">🧬 Đang tự động gom & gộp phiếu xét nghiệm...</div>
        <div style="font-size: 11px; color: #64748b; max-width: 260px;">Vui lòng giữ nguyên màn hình để tiện ích đồng bộ tất cả chỉ số vượt ngưỡng của bệnh nhân.</div>
      </div>
    `;
  }

  function renderLabResults(container) {
    let html = `
      <div class="his-filter-bar">
        <input type="text" id="his-lab-search" class="his-search-input" placeholder="🔍 Tìm tên dịch vụ hoặc chỉ số xét nghiệm..." value="${state.filterKeyword}">
        <label class="his-toggle-label">
          <input type="checkbox" id="his-only-abnormal-chk" ${state.showOnlyAbnormal ? 'checked' : ''}>
          Chỉ xem chỉ số vượt cận
        </label>
      </div>
    `;

    let hasData = false;

    state.labResults.forEach(group => {
      const displayDate = group.performedAt || (group.indicators.find(i => i.performedAt)?.performedAt || '');
      let indicatorsToDisplay = group.indicators;
      if (state.showOnlyAbnormal) {
        indicatorsToDisplay = group.indicators.filter(i => i.status === 'HIGH' || i.status === 'LOW');
      }

      if (state.filterKeyword) {
        const kw = state.filterKeyword.toLowerCase();
        indicatorsToDisplay = indicatorsToDisplay.filter(i => 
          i.name.toLowerCase().includes(kw) ||
          (i.testName || group.serviceName || '').toLowerCase().includes(kw) ||
          displayDate.toLowerCase().includes(kw)
        );
      }

      if (indicatorsToDisplay.length > 0) {
        hasData = true;
        html += `
          <div class="his-service-group">
            <div class="his-group-header">
              <span>🩺 ${group.serviceName}</span>
              <span class="his-patient-tag">${displayDate || 'Không rõ ngày'}</span>
            </div>
            <table class="his-abnormal-table">
              <thead>
                <tr>
                  <th>Ngày thực hiện</th>
                  <th>Tên xét nghiệm</th>
                  <th>Tên chỉ số</th>
                  <th>Kết quả</th>
                  <th>Giá trị BT</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
        `;

        indicatorsToDisplay.forEach(ind => {
          const isHigh = ind.status === 'HIGH';
          const isLow = ind.status === 'LOW';
          const statusText = isHigh ? '▲ Cao' : isLow ? '▼ Thấp' : 'Bình thường';
          const statusClass = isHigh ? 'high' : isLow ? 'low' : 'normal';

          html += `
            <tr class="${ind.status !== 'NORMAL' ? 'his-abnormal-row' : ''}">
              <td>
                <span class="his-date-badge" title="Thời gian thực hiện: ${ind.performedAt || displayDate || 'N/A'}">
                  📅 ${ind.performedAt || displayDate || 'N/A'}
                </span>
              </td>
              <td class="his-test-name-col" title="${ind.testName || group.serviceName}">
                <div class="his-test-name-text">${ind.testName || group.serviceName}</div>
              </td>
              <td class="his-indicator-name">${ind.name}</td>
              <td class="his-indicator-value ${statusClass}">${ind.value} <span style="font-size:10px; font-weight:normal; color:#94a3b8;">${ind.unit}</span></td>
              <td style="color:#64748b; font-size:12px;">${ind.range || 'N/A'}</td>
              <td>
                <span class="his-status-badge ${statusClass}">
                  ${statusText}
                </span>
              </td>
            </tr>
          `;
        });

        html += `
              </tbody>
            </table>
          </div>
        `;
      }
    });

    if (!hasData) {
      html += `
        <div class="his-empty-state">
          <div class="his-empty-icon">✅</div>
          <h3>Không có chỉ số Xét nghiệm vượt cận!</h3>
          <p>Tất cả các xét nghiệm của bệnh nhân đều nằm trong giới hạn bình thường hoặc chưa có dữ liệu mới.</p>
        </div>
      `;
    }

    container.innerHTML = html;

    const searchInput = document.getElementById('his-lab-search');
    if (searchInput) {
      searchInput.oninput = (e) => {
        state.filterKeyword = e.target.value;
        renderLabResults(container);
      };
    }

    const chk = document.getElementById('his-only-abnormal-chk');
    if (chk) {
      chk.onchange = (e) => {
        state.showOnlyAbnormal = e.target.checked;
        renderLabResults(container);
      };
    }
  }

  function renderImagingResults(container) {
    if (!state.imagingResults || state.imagingResults.length === 0) {
      container.innerHTML = `
        <div class="his-empty-state">
          <div class="his-empty-icon">📷</div>
          <h3>Chưa có kết quả CĐHA</h3>
          <p>Bệnh nhân chưa thực hiện chỉ định Chẩn đoán hình ảnh hoặc phim đang chờ đọc.</p>
        </div>
      `;
      return;
    }

    let html = '';

    state.imagingResults.forEach((study, idx) => {
      const hasWebUrl = study.dicomUrl && study.dicomUrl.startsWith('http');
      const webPACSUrl = hasWebUrl ? study.dicomUrl : `https://bvgialai.vncare.vn/pacs/viewer?patientId=${state.selectedPatient.code || study.patientCode || 'BA2607180160'}`;

      html += `
        <div class="his-imaging-card">
          <div class="his-imaging-title">
            <span>📷 ${study.serviceName}</span>
            <span class="his-patient-tag">${study.date || ''}</span>
          </div>
          
          <div style="font-size:12px; color:#94a3b8; margin-bottom: 6px;">
            Bác sĩ đọc: <strong>${study.doctor || 'N/A'}</strong>
          </div>

          <div class="his-imaging-conclusion">
            <strong>Kết luận:</strong> ${study.conclusion}
          </div>

          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
            <button class="his-btn-dicom" data-study-idx="${idx}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
              👁️ Xem DICOM (Viewer tích hợp)
            </button>

            <a href="${webPACSUrl}" target="_blank" class="his-btn-pacs-external" style="display:inline-flex; align-items:center; gap:6px; padding:8px 14px; background:#1e293b; color:#38bdf8; border:1px solid #0284c7; border-radius:6px; font-size:12px; font-weight:600; text-decoration:none; transition:all 0.2s;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              🔗 Mở PACS Web gốc
            </a>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.his-btn-dicom').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.getAttribute('data-study-idx'), 10);
        const study = state.imagingResults[idx];
        if (window.HISDicomViewer) {
          window.HISDicomViewer.openModal({
            ...study,
            patientName: state.selectedPatient.name,
            patientCode: state.selectedPatient.code
          });
        } else {
          alert('Hệ thống DICOM Viewer đang khởi động, vui lòng thử lại.');
        }
      };
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

})();
