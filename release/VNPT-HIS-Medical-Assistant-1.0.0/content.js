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
    showOnlyAbnormal: true,
    showOnlyIncompleteLabs: false,
    filterKeyword: '',
    selectedPatient: {
      name: 'Chưa chọn bệnh nhân',
      code: '---',
      age: '--',
      gender: '--',
      room: '--',
      bed: '--',
      healthInsuranceNumber: '',
      primaryIcd: '',
      diagnosis: '',
      citizenId: ''
    },
    labResults: [],
    imagingResults: [],
    orderedServices: [],
    hasScannedCurrentPatient: false,
    isScanning: false,
    scanProgress: '',
    activeApiContextKey: '',
    selectedLabSheetId: '',
    selectedImagingSheetId: '',
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

  function applyApiPatientContext(contextKey, careType) {
    if (!contextKey) return;
    if (state.activeApiContextKey === contextKey) return;

    state.activeApiContextKey = contextKey;
    state.labResults = [];
    state.imagingResults = [];
    state.orderedServices = [];
    state.orderedServiceMap = {};
    state.selectedLabSheetId = '';
    state.selectedImagingSheetId = '';
    state.hasScannedCurrentPatient = false;
    state.filterKeyword = '';
    state.selectedPatient = Object.assign({}, state.selectedPatient, {
      healthInsuranceNumber: '',
      primaryIcd: '',
      diagnosis: '',
      citizenId: ''
    });

    logDebug(careType === 'outpatient'
      ? '[API] Đã nhận diện bệnh nhân ngoại trú; khởi tạo dữ liệu mới'
      : '[API] Đã nhận diện bệnh nhân nội trú; khởi tạo dữ liệu mới');
    renderContent();
  }

  function cleanString(str) {
    if (str === undefined || str === null) return '';
    return String(str).replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '')
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

  function parseHISDateTimestamp(value) {
    const text = cleanString(value);
    if (!text) return 0;

    // HIS commonly returns dd/MM/yyyy HH:mm or dd/MM/yyyy HH:mm:ss.
    const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (match) {
      const timestamp = new Date(
        Number(match[3]),
        Number(match[2]) - 1,
        Number(match[1]),
        Number(match[4] || 0),
        Number(match[5] || 0),
        Number(match[6] || 0)
      ).getTime();
      return Number.isNaN(timestamp) ? 0 : timestamp;
    }

    const timestamp = Date.parse(text);
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  function getLabGroupTimestamp(group) {
    const timestamps = [
      parseHISDateTimestamp(group && group.performedAt),
      ...((group && group.indicators) || []).map(ind => parseHISDateTimestamp(ind && ind.performedAt))
    ];
    return Math.max(...timestamps, 0);
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
  const pendingRisWindows = new Map();

  setupNetworkInterceptors();
  setupStorageChangeListener();

  function init() {
    loadStateFromStorage(() => {
      if (isTopFrame) {
        createTriggerButton();
        createDrawerPanel();
        setupTopFrameMessageListener();
      }
      bindPatientSelectionListeners();
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
        // Legacy DOM auto-scan has been retired. Data comes from RestService only.
        return;
      }

      if (event.data.type === 'HIS_EXT_PARSED_DATA') {
        const { patient, labResults, imagingResults } = event.data;
        if (patient && patient.code && patient.code !== '---' && patient.name && patient.name !== 'Chưa chọn bệnh nhân') {
          state.selectedPatient = patient;
        }
        if (labResults && labResults.length > 0) {
          state.labResults = mergeDuplicateLabGroups([...state.labResults, ...labResults]);
        }
        if (imagingResults && imagingResults.length > 0) {
          state.imagingResults = mergeImagingResults(state.imagingResults, imagingResults);
        }
        updatePatientInfoUI();
        renderContent();
        return;
      }

      if (event.data.type === 'HIS_EXT_API_CONTEXT') {
        applyApiPatientContext(event.data.contextKey || '', event.data.careType || '');
        return;
      }

      if (event.data.type === 'HIS_EXT_PATIENT_METADATA') {
        applyPatientMetadata(event.data.patient || {});
        return;
      }

      if (event.data.type === 'HIS_EXT_SHEET_SELECTED') {
        focusSelectedSheet(event.data.sheetId || '', event.data.category || '');
        return;
      }

      if (event.data.type === 'HIS_EXT_RIS_REFRESH_RESULT') {
        handleRisRefreshResult(event.data);
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
      if (event.source !== window || !event.data) return;

      if (event.data.type === 'HIS_XHR_DATA') {
        parseRealXHRResponse(event.data.url, event.data.response, {
          queryName: event.data.queryName || '',
          category: event.data.category || '',
          sheetId: event.data.sheetId || '',
          sheetNumber: event.data.sheetNumber || '',
          sheetDate: event.data.sheetDate || ''
        });
        return;
      }

      if (event.data.type === 'HIS_RIS_VIEWER_URL') {
        const studyId = cleanString(event.data.studyInstanceUID || '');
        const viewerUrl = cleanString(event.data.viewerUrl || '');
        if (studyId && /^https?:\/\//i.test(viewerUrl)) {
          state.imagingResults.forEach(item => {
            if (cleanString(item.risStudyId || '') === studyId) item.dicomUrl = viewerUrl;
          });
          renderContent();
        }
        return;
      }

      if (event.data.type === 'HIS_RIS_LINK_STATE') {
        logDebug(event.data.success
          ? '[RIS] Đã nhận được link DICOM thật'
          : '[RIS] Chưa lấy được link DICOM từ máy chủ RIS');
        return;
      }

      if (event.data.type === 'HIS_RIS_REFRESH_RESULT') {
        if (isTopFrame) {
          handleRisRefreshResult(event.data);
        } else {
          try {
            window.top.postMessage(Object.assign({}, event.data, {
              type: 'HIS_EXT_RIS_REFRESH_RESULT'
            }), '*');
          } catch (e) {}
        }
        return;
      }

      if (event.data.type === 'HIS_API_CONTEXT') {
        if (isTopFrame) {
          applyApiPatientContext(event.data.contextKey || '', event.data.careType || '');
        } else {
          try {
            window.top.postMessage({
              type: 'HIS_EXT_API_CONTEXT',
              contextKey: event.data.contextKey || '',
              careType: event.data.careType || ''
            }, '*');
          } catch (e) {}
        }
        return;
      }

      if (event.data.type === 'HIS_PATIENT_METADATA') {
        if (isTopFrame) {
          applyPatientMetadata(event.data.patient || {});
        } else {
          try {
            window.top.postMessage({
              type: 'HIS_EXT_PATIENT_METADATA',
              patient: event.data.patient || {}
            }, '*');
          } catch (e) {}
        }
        return;
      }

      if (event.data.type === 'HIS_SHEET_SELECTED') {
        if (isTopFrame) {
          focusSelectedSheet(event.data.sheetId || '', event.data.category || '');
        } else {
          try {
            window.top.postMessage({
              type: 'HIS_EXT_SHEET_SELECTED',
              sheetId: event.data.sheetId || '',
              category: event.data.category || ''
            }, '*');
          } catch (e) {}
        }
        return;
      }

      if (event.data.type === 'HIS_LAB_SHEET_LIST') {
        processHISLabSheetList(Array.isArray(event.data.sheets) ? event.data.sheets : []);
        return;
      }

      if (event.data.type === 'HIS_API_LOADING_STATE') {
        state.isScanning = !!event.data.isLoading;
        if (event.data.isLoading) {
          state.scanProgress = 'Đang tải trực tiếp kết quả từ HIS...';
          logDebug('[API] Đang tải danh sách phiếu và kết quả từ HIS');
        } else if (event.data.success) {
          state.hasScannedCurrentPatient = true;
          state.scanProgress = '';
          logDebug(`[API] Đã tải xong ${event.data.sheetCount || 0} phiếu từ HIS`);
        } else {
          state.scanProgress = '';
          logDebug(`[API] Không thể tải trực tiếp: ${event.data.error || 'Lỗi không xác định'}. Có thể dùng quét DOM dự phòng.`);
        }
        renderContent();
      }
    });
  }

  function loadStateFromStorage(callback) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['showOnlyAbnormal'], (result) => {
        if (result.showOnlyAbnormal !== undefined) state.showOnlyAbnormal = result.showOnlyAbnormal;
        callback();
      });
    } else {
      callback();
    }
  }

  function setupStorageChangeListener() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes.showOnlyAbnormal) return;
      state.showOnlyAbnormal = !!changes.showOnlyAbnormal.newValue;
      if (isTopFrame) renderContent();
    });
  }

  function createTriggerButton() {
    if (document.getElementById('his-assistant-trigger')) return;

    triggerBtn = document.createElement('div');
    triggerBtn.id = 'his-assistant-trigger';
    triggerBtn.className = 'his-assistant-trigger';
    triggerBtn.setAttribute('role', 'button');
    triggerBtn.setAttribute('tabindex', '0');
    triggerBtn.setAttribute('title', 'Mở HIS Assistant');
    triggerBtn.setAttribute('aria-label', 'Mở HIS Assistant');
    triggerBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
      <span class="his-badge-count" id="his-trigger-badge">0</span>
    `;

    triggerBtn.onclick = () => toggleDrawer();
    triggerBtn.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleDrawer();
      }
    };
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
      <button id="his-collapse-drawer" class="his-collapse-handle" title="Thu gọn HIS Assistant" aria-label="Thu gọn HIS Assistant">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      <!-- Header -->
      <div class="his-drawer-header">
        <div class="his-header-top">
          <div class="his-brand">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
            HIS VNPT Assistant
          </div>
          <div class="his-header-controls">
            <button id="his-rescan-btn" class="his-header-action-btn" style="background:#0284c7; color:#fff; border:none;" title="Tải lại dữ liệu từ HIS">
              🔄 Quét lại
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
          <div class="his-patient-details">
            <div><strong>Thẻ BHYT:</strong> <span id="his-p-bhyt"></span></div>
            <div><strong>CCCD:</strong> <span id="his-p-cccd"></span></div>
            <div><strong>ICD chính:</strong> <span id="his-p-icd"></span></div>
            <div class="his-patient-diagnosis"><strong>Chẩn đoán:</strong> <span id="his-p-diagnosis"></span></div>
          </div>
        </div>
      </div>

      <!-- Tabs Chuyển đổi -->
      <div class="his-drawer-tabs">
        <button class="his-tab-btn active" id="his-tab-lab">
          🩸 Xét nghiệm
          <span class="his-tab-count" id="his-count-lab">0</span>
        </button>
        <button class="his-tab-btn" id="his-tab-imaging">
          📷 CĐHA
          <span class="his-tab-count" id="his-count-imaging">0</span>
        </button>
      </div>

      <!-- Body Content -->
      <div class="his-drawer-body" id="his-drawer-body-content">
      </div>
    `;

    document.body.appendChild(drawerPanel);

    document.getElementById('his-close-drawer').onclick = () => closeDrawer();
    document.getElementById('his-collapse-drawer').onclick = () => closeDrawer();
    
    document.getElementById('his-rescan-btn').onclick = () => {
      state.labResults = [];
      state.imagingResults = [];
      state.hasScannedCurrentPatient = false;
      state.isScanning = true;
      state.scanProgress = 'Đang tải lại trực tiếp từ HIS...';
      window.postMessage({ type: 'HIS_API_RELOAD' }, '*');
      document.querySelectorAll('iframe').forEach(iframe => {
        try { iframe.contentWindow.postMessage({ type: 'HIS_API_RELOAD' }, '*'); } catch (e) {}
      });
      renderContent();
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

  function clickClinicalSectionTab(docToUse, category) {
    const doc = docToUse || document;
    const candidates = doc.querySelectorAll('button, a, li, [role="tab"], span, div');
    const wanted = category === 'imaging'
      ? ['cđha', 'cdha', 'chẩn đoán hình ảnh', 'chan doan hinh anh']
      : ['xét nghiệm', 'xet nghiem'];

    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      if (el.closest && (el.closest('#his-assistant-drawer') || el.closest('#his-assistant-trigger'))) continue;
      const text = cleanString(el.innerText || el.textContent || '').toLowerCase();
      if (!text || text.length > 50 || !wanted.some(term => text === term || text.includes(term))) continue;
      let score = text === wanted[0] ? 10 : 5;
      if (['BUTTON', 'A', 'LI'].includes(el.tagName) || el.getAttribute('role') === 'tab') score += 4;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (!best) return false;
    forceClickElement(best);
    return true;
  }

  function findHisSheetRow(doc, sheetId, sheetNumber, category) {
    const rows = doc.querySelectorAll('tr.jqgrow, tr[role="row"], .dhtmlxGrid tr, .jqx-grid [role="row"]');
    let bestRow = null;
    let bestScore = 0;

    rows.forEach(row => {
      if (row.closest && row.closest('#his-assistant-drawer')) return;
      const text = cleanString(row.innerText || row.textContent || '');
      const attrs = [
        row.id,
        row.getAttribute('data-id'),
        row.getAttribute('data-key'),
        row.getAttribute('data-rowid'),
        row.getAttribute('onclick')
      ].filter(Boolean).join(' ');
      let score = 0;
      if (sheetId && attrs.includes(sheetId)) score += 20;
      if (sheetId && text.includes(sheetId)) score += 15;
      if (sheetNumber && text.includes(sheetNumber)) score += 12;

      const nearbyText = normalizeVietnameseText((row.closest('.ui-jqgrid, [role="grid"], div[class*="grid"]') || row.parentElement || row).innerText || '');
      if (category === 'lab' && nearbyText.includes('xet nghiem')) score += 3;
      if (category === 'imaging' && (nearbyText.includes('chan doan hinh anh') || nearbyText.includes('cdha'))) score += 3;
      if (score > bestScore) {
        bestRow = row;
        bestScore = score;
      }
    });

    return bestScore >= 12 ? bestRow : null;
  }

  async function focusSheetOnHis(sheetId, sheetNumber, category) {
    const normalizedId = cleanString(sheetId);
    const normalizedNumber = cleanString(sheetNumber);
    if (!normalizedId && !normalizedNumber) return;

    let targetRow = null;
    const findTarget = () => {
      for (const doc of getAllAccessibleDocs()) {
        const row = findHisSheetRow(doc, normalizedId, normalizedNumber, category);
        if (row) return row;
      }
      return null;
    };

    targetRow = findTarget();
    if (!targetRow) {
      getAllAccessibleDocs().forEach(doc => clickClinicalSectionTab(doc, category));
      await delay(450);
      targetRow = findTarget();
    }
    if (!targetRow) {
      logDebug(`[Focus HIS] Không tìm thấy phiếu ${normalizedNumber || normalizedId} trên màn hình HIS`);
      return;
    }

    const clickTarget = targetRow.querySelector('td:nth-child(4), td:nth-child(3), td') || targetRow;
    forceClickElement(clickTarget);
    forceClickElement(targetRow);
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    targetRow.classList.remove('his-his-row-focus');
    void targetRow.offsetWidth;
    targetRow.classList.add('his-his-row-focus');
    setTimeout(() => targetRow.classList.remove('his-his-row-focus'), 1800);
  }

  function bindPanelSheetFocusHandlers(container, category) {
    const selector = category === 'lab' ? '.his-service-group' : '.his-imaging-card';
    container.querySelectorAll(selector).forEach(card => {
      card.onclick = event => {
        if (event.target.closest('button, a, input, label, summary, details')) return;
        focusSheetOnHis(
          card.getAttribute('data-his-sheet-id') || '',
          card.getAttribute('data-his-sheet-number') || '',
          category
        );
      };
    });
  }

  function focusSelectedSheet(sheetId, category) {
    const normalizedId = cleanString(sheetId);
    if (!normalizedId) return;

    let targetCategory = category;
    if (!targetCategory && state.labResults.some(item => cleanString(item.sheetId) === normalizedId)) targetCategory = 'lab';
    if (!targetCategory && state.imagingResults.some(item => cleanString(item.sheetId) === normalizedId)) targetCategory = 'imaging';
    if (!targetCategory) return;

    if (targetCategory === 'lab') state.selectedLabSheetId = normalizedId;
    if (targetCategory === 'imaging') state.selectedImagingSheetId = normalizedId;
    switchTab(targetCategory);

    requestAnimationFrame(() => {
      const selector = `[data-his-sheet-id="${CSS.escape(normalizedId)}"]`;
      const target = document.querySelector(selector);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('his-sheet-focus-pulse');
      void target.offsetWidth;
      target.classList.add('his-sheet-focus-pulse');
    });
  }

  function handleRisRefreshResult(result) {
    const requestId = cleanString(result && result.requestId);
    if (!requestId || !pendingRisWindows.has(requestId)) return;

    const viewerWindow = pendingRisWindows.get(requestId);
    pendingRisWindows.delete(requestId);
    const viewerUrl = cleanString(result.viewerUrl || '');
    const studyId = cleanString(result.studyInstanceUID || '');

    if (result.success && /^https?:\/\//i.test(viewerUrl)) {
      state.imagingResults.forEach(item => {
        if (cleanString(item.risStudyId) === studyId) item.dicomUrl = viewerUrl;
      });
      if (viewerWindow && !viewerWindow.closed) viewerWindow.location.replace(viewerUrl);
      renderContent();
      return;
    }

    if (viewerWindow && !viewerWindow.closed) viewerWindow.close();
    alert('Không thể tạo link DICOM/RIS mới. Vui lòng kiểm tra lại phiên đăng nhập HIS.');
  }

  function openFreshRisViewer(study) {
    const studyId = cleanString(study && study.risStudyId);
    if (!studyId) {
      if (study && /^https?:\/\//i.test(study.dicomUrl || '')) window.open(study.dicomUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    // Open synchronously to preserve the user gesture; navigate it after the
    // asynchronous RIS signing request completes.
    const viewerWindow = window.open('', '_blank');
    if (!viewerWindow) {
      alert('Trình duyệt đang chặn cửa sổ DICOM. Vui lòng cho phép pop-up cho trang HIS.');
      return;
    }
    try { viewerWindow.opener = null; } catch (e) {}
    viewerWindow.document.title = 'Đang mở DICOM / RIS...';
    viewerWindow.document.body.textContent = 'Đang tạo đường dẫn DICOM / RIS mới...';

    const requestId = `ris-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingRisWindows.set(requestId, viewerWindow);
    const message = { type: 'HIS_RIS_REFRESH_REQUEST', requestId, studyInstanceUID: studyId };
    window.postMessage(message, '*');
    document.querySelectorAll('iframe').forEach(iframe => {
      try { iframe.contentWindow.postMessage(message, '*'); } catch (e) {}
    });

    setTimeout(() => {
      if (!pendingRisWindows.has(requestId)) return;
      pendingRisWindows.delete(requestId);
      if (!viewerWindow.closed) viewerWindow.close();
      alert('Hết thời gian tạo link DICOM/RIS. Vui lòng tải lại trang HIS và thử lại.');
    }, 15000);
  }

  function isLabTabActive(doc) {
    const text = (doc.body ? doc.body.innerText : '').toLowerCase();
    return text.includes('danh sách xét nghiệm') && (text.includes('load phiếu theo đợt') || text.includes('kết quả xét nghiệm'));
  }

  /** Chỉ theo dõi lựa chọn bệnh nhân; dữ liệu lâm sàng được tải qua API. */
  function bindPatientSelectionListeners() {
    const handleDocumentClick = (e) => {
      if (!e.target) return;

      // Bỏ qua click bên trong bảng điều khiển tiện ích
      if (e.target.closest && (e.target.closest('#his-assistant-drawer') || e.target.closest('#his-assistant-trigger'))) return;

      // Trích xuất thông tin bệnh nhân từ header
      extractPatientHeaderFromDOM();
      const row = e.target.closest && e.target.closest('tr, div[role="row"]');
      if (row) {
        extractPatientInfoFromRow(row);
      }
    };

    document.addEventListener('click', handleDocumentClick, true);

    // Gán listener cho iframes mới được tạo & tự động kích hoạt khi đổi bệnh nhân
    if (!isTopFrame) return;

    setInterval(() => {
      scanAndAttachIframeListeners(handleDocumentClick);
      
      extractPatientHeaderFromDOM();
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
    renderContent();
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

    // Giá trị kết quả xét nghiệm bắt buộc phải chứa số thập phân/nguyên hoặc là định tính hợp lệ
    const valClean = value.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0\s]/g, '').replace(',', '.');
    const hasNumber = /^([<>]=?\s*)?[-+]?\d+([.]\d+)?/.test(valClean) || /\d/.test(valClean);
    if (!hasNumber && !isLikelyQualitativeResult(value) && !value.includes('*') && !value.toLowerCase().includes('tăng') && !value.toLowerCase().includes('giảm')) {
      return true; // Lọc bỏ các dòng không phải kết quả XN
    }

    // Bỏ qua các dòng mà tên chỉ số là 1 dãy số ID thuần túy (ví dụ: 14886475)
    if (/^\d+$/.test(name.trim())) return true;

    if (name.length > 120 || value.length > 25) return true;
    if (/\d{2}\/\d{2}\/\d{4}/.test(name) || /\d{2}\/\d{2}\/\d{4}/.test(value)) return true; // Lọc bỏ dòng chứa ngày tháng
    if (/[A-F0-9]{16,}/i.test(name)) return true; // Lọc các mã GUID rác từ cache grid
    if (/(\d)\1{5,}/.test(value)) return true; // Lọc các dãy số lặp rác như 222222, 777777

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

  function extractOrderedServicesFromDOM() {
    const docs = getAllAccessibleDocs();
    const serviceList = [];
    const serviceMap = {};

    docs.forEach(doc => {
      const elements = doc.querySelectorAll('table, div[role="grid"], .ui-jqgrid, .jqx-grid, div[class*="grid"]');
      elements.forEach(el => {
        const text = (el.innerText || '').toLowerCase();
        if (text.includes('dịch vụ chỉ định') || text.includes('dich vu chi dinh') || text.includes('tên dịch vụ') || text.includes('ten dich vu') || text.includes('danh sách dịch vụ') || text.includes('phiếu chỉ định') || text.includes('chỉ định dịch vụ') || text.includes('tên xét nghiệm')) {
          const rows = Array.from(el.querySelectorAll('tr, div[role="row"]'));
          if (rows.length < 2) return;

          let codeColIdx = -1;
          let nameColIdx = 2; // Cột số 2 mặc định là Tên xét nghiệm như cấu trúc bảng VNPT HIS

          // Quét 3 hàng đầu để định vị đúng cột Tên xét nghiệm
          for (let i = 0; i < Math.min(3, rows.length); i++) {
            const headerCells = Array.from(rows[i].querySelectorAll('th, td, div[role="columnheader"]')).map(c => normalizeVietnameseText(c.innerText));
            headerCells.forEach((hText, idx) => {
              if (hText.includes('ma xet nghiem') || hText.includes('ma dv') || hText.includes('ma mbp')) {
                codeColIdx = idx;
              }
              if (hText.includes('ten xet nghiem') || hText.includes('ten dich vu') || hText.includes('ten dv')) {
                nameColIdx = idx;
              }
            });
          }

          rows.forEach(r => {
            const cells = Array.from(r.querySelectorAll('td, th, div[role="gridcell"]')).map(c => cleanString(c.innerText));
            if (cells.length <= nameColIdx) return;

            const serviceName = cells[nameColIdx] || '';
            const serviceCode = codeColIdx !== -1 ? (cells[codeColIdx] || '') : '';

            const norm = normalizeVietnameseText(serviceName);
            if (serviceName && serviceName.length >= 5 && /\s/.test(serviceName) &&
                !isHeaderOrMetadataText(serviceName) &&
                !isDoctorOrPersonName(serviceName) &&
                !isLikelyQualitativeResult(serviceName) &&
                !isRangeString(serviceName)) {
              
              if (!serviceList.includes(serviceName)) {
                serviceList.push(serviceName);
              }
              if (serviceCode) {
                serviceMap[serviceCode.toUpperCase()] = serviceName;
              }
            }
          });
        }
      });
    });

    state.orderedServiceMap = serviceMap;
    logDebug(`[ServiceScan] Tìm thấy ${serviceList.length} dịch vụ chỉ định từ Cột 2 tab Dịch vụ chỉ định`);
    return serviceList;
  }

  function isHeaderOrMetadataText(text) {
    if (!text) return false;
    const t = normalizeVietnameseText(text);
    if (!t) return false;
    return (
      t.includes('ma xet nghiem') ||
      t.includes('ten xet nghiem') ||
      t.includes('ma dv') ||
      t.includes('ten dv') ||
      t.includes('ten chi dinh') ||
      t.includes('danh sach') ||
      t.includes('tri so binh thuong') ||
      t.includes('gia tri binh thuong') ||
      t.includes('ket qua') ||
      t.includes('don vi') ||
      t.includes('nguoi tra') ||
      t.includes('nguoi thuc hien') ||
      t.includes('loai mbp') ||
      t.includes('ma mbp') ||
      t.includes('mau benh pham') ||
      t.includes('loai mau') ||
      t.includes('loai thanh toan') ||
      t.includes('thanh toan') ||
      t.includes('so luong') ||
      t.includes('don gia') ||
      t.includes('thanh tien')
    );
  }

  function matchServiceFromOrderedList(rawTestName, indicatorName, orderedServices) {
    const list = (orderedServices || state.orderedServices || [])
      .map(item => cleanString(typeof item === 'string' ? item : (item && item.name)))
      .filter(Boolean);

    const rawNorm = normalizeVietnameseText(rawTestName || '');
    const indNorm = normalizeVietnameseText(indicatorName || '');

    // 0. Ưu tiên khớp theo Mã xét nghiệm / Mã MBP từ tab chỉ định nếu có
    if (state.orderedServiceMap && indicatorName) {
      const codeMatch = indicatorName.match(/\(([A-Z0-9._-]+)\)/i);
      const codeKey = codeMatch ? codeMatch[1].toUpperCase() : indicatorName.trim().toUpperCase();
      if (state.orderedServiceMap[codeKey]) {
        return state.orderedServiceMap[codeKey];
      }
    }

    // 1. Nếu rawTestName hợp lệ và không phải header, thử khớp với danh sách dịch vụ chỉ định
    if (rawNorm && rawNorm !== 'xet nghiem can lam sang' && !isHeaderOrMetadataText(rawTestName) && !isDoctorOrPersonName(rawTestName) && !isRangeString(rawTestName)) {
      const match = list.find(s => {
        const sNorm = normalizeVietnameseText(s);
        return sNorm === rawNorm || sNorm.includes(rawNorm) || rawNorm.includes(sNorm);
      });
      if (match) return match;
    }

    // 2. Tự động khớp theo tên chỉ số đặc trưng với danh sách dịch vụ chỉ định
    if (indNorm) {
      // Công thức máu: WBC, RBC, HGB, PLT, MPV, PCT, PDW, BA#, EO#, MO#, NE#, LY#, NEU#, LYM#, MONO#, EOS#, BASO#...
      if (indNorm.includes('wbc') || indNorm.includes('rbc') || indNorm.includes('hgb') || indNorm.includes('plt') || indNorm.includes('hct') || indNorm.includes('mcv') || indNorm.includes('mch') || indNorm.includes('mchc') || indNorm.includes('rdw') || indNorm.includes('mpv') || indNorm.includes('pct') || indNorm.includes('pdw') || indNorm.includes('bach cau') || indNorm.includes('hong cau') || indNorm.includes('tieu cau') || indNorm.includes('ba#') || indNorm.includes('eo#') || indNorm.includes('mo#') || indNorm.includes('ne#') || indNorm.includes('ly#') || indNorm.includes('neu#') || indNorm.includes('lym#') || indNorm.includes('mono#') || indNorm.includes('eos#') || indNorm.includes('baso#') || indNorm.includes('h18') || indNorm.includes('h22')) {
        const match = list.find(s => {
          const sn = normalizeVietnameseText(s);
          return sn.includes('te bao mau') || sn.includes('cong thuc mau') || sn.includes('laser');
        });
        if (match) return match;
      }

      // Điện giải đồ: Na, K, Cl, Na+, K+, Cl-, S07, S08, S10...
      if (indNorm.includes('na') || indNorm.includes('k') || indNorm.includes('cl') || indNorm.includes('dien gia') || indNorm.includes('s07') || indNorm.includes('s08') || indNorm.includes('s10')) {
        const match = list.find(s => normalizeVietnameseText(s).includes('dien gia'));
        if (match) return match;
      }

      if (indNorm.includes('hiv')) {
        const match = list.find(s => normalizeVietnameseText(s).includes('hiv'));
        if (match) return match;
      }

      if (indNorm.includes('tb') || indNorm.includes('lao')) {
        const match = list.find(s => normalizeVietnameseText(s).includes('lao') || normalizeVietnameseText(s).includes('tuberculosis'));
        if (match) return match;
      }

      if (indNorm.includes('creatinin')) {
        const match = list.find(s => normalizeVietnameseText(s).includes('creatinin'));
        if (match) return match;
      }

      if (indNorm.includes('glucose') || indNorm.includes('duong mau')) {
        const match = list.find(s => normalizeVietnameseText(s).includes('glucose'));
        if (match) return match;
      }

      if (indNorm.includes('crp')) {
        const match = list.find(s => normalizeVietnameseText(s).includes('crp'));
        if (match) return match;
      }

      if (indNorm.includes('ast') || indNorm.includes('alt') || indNorm.includes('got') || indNorm.includes('gpt')) {
        const match = list.find(s => normalizeVietnameseText(s).includes('ast') || normalizeVietnameseText(s).includes('alt') || normalizeVietnameseText(s).includes('men gan'));
        if (match) return match;
      }
    }

    // 3. Fallback tên đã trích xuất nếu hợp lệ và không phải text header
    if (rawTestName && rawTestName !== 'Xét nghiệm cận lâm sàng' && !isHeaderOrMetadataText(rawTestName) && !isDoctorOrPersonName(rawTestName) && !isRangeString(rawTestName) && !isLikelyQualitativeResult(rawTestName)) {
      return rawTestName;
    }

    return 'Xét nghiệm cận lâm sàng';
  }

  let _lastExtractAt = 0;

  function extractRealDataFromHIS(force) {
    const now = Date.now();
    if (!force && now - _lastExtractAt < 1000) return;
    _lastExtractAt = now;

    state.orderedServices = extractOrderedServicesFromDOM();

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
          // Never synthesize a PACS URL. Only a URL returned by RIS is valid.
          dicomUrl = '';
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

  function isCellVisible(cell) {
    if (!cell) return false;
    try {
      if (cell.style && (cell.style.display === 'none' || cell.style.visibility === 'hidden')) return false;
      if (cell.getAttribute && cell.getAttribute('hidden') !== null) return false;
      if (cell.classList) {
        if (
          cell.classList.contains('ui-helper-hidden') ||
          cell.classList.contains('jqx-hidegridcolumn') ||
          cell.classList.contains('hidden') ||
          cell.classList.contains('nodata')
        ) return false;
      }
      const parent = cell.parentElement;
      if (parent && parent.style && parent.style.display === 'none') return false;
    } catch(e) {}
    return true;
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
      const visibleCellEls = Array.from(r.querySelectorAll('th, td')).filter(c => isCellVisible(c));
      const cells = visibleCellEls.map(c => cleanString(c.innerText));
      const rowTextLower = cells.join(' ').toLowerCase();

      if (rowTextLower.includes('danh sách') && cells.length < 3) return;

      cells.forEach((text, i) => {
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

  function isUnitString(str) {
    if (!str) return false;
    const s = cleanString(str).trim();
    if (!s) return false;
    return /^(mmol|umol|µmol|mol|g|mg|mcg|ug|μg|u|iu|l|dl|ml|t|g\/l|t\/l|u\/l|iu\/l|umol\/l|mmol\/l|mg\/l|mg\/dl|pg\/ml|\%|10\^9\/l|10\^12\/l)$/i.test(s) ||
           /^[a-z0-9%^μµ/-]{1,10}\/[a-z0-9%^μµ/-]{1,10}$/i.test(s);
  }

  function isLikelyQualitativeResult(text) {
    if (!text) return false;
    const tNorm = normalizeVietnameseText(cleanString(text));
    if (!tNorm) return false;
    return (
      tNorm.includes('am tinh') ||
      tNorm.includes('duong tinh') ||
      tNorm.includes('amtinh') ||
      tNorm.includes('duongtinh') ||
      tNorm.includes('negative') ||
      tNorm.includes('positive') ||
      tNorm.includes('khong phat hien') ||
      tNorm.includes('khong thay') ||
      tNorm.includes('khong phan ung') ||
      tNorm.includes('phan ung') ||
      tNorm.includes('vet') ||
      tNorm.includes('binh thuong') ||
      tNorm.includes('bat thuong') ||
      tNorm.includes('dat')
    );
  }

  function isRangeString(text) {
    if (!text) return false;
    const t = cleanString(text).trim();
    if (!t) return false;
    if (/[\d.,]+\s*[-~–—]\s*[\d.,]+/.test(t)) return true;
    if (/^([<>]=?\s*)?[\d.,]+/.test(t) && /[-~–—]/.test(t)) return true;
    if (/^0\s*[-~–—]\s*\d+/.test(t)) return true;
    if (/^<=\s*[\d.,]+|^>=\s*[\d.,]+|^<\s*[\d.,]+|^>\s*[\d.,]+/.test(t)) return true;
    return false;
  }

  function isLikelyIndicatorLabel(text) {
    const value = cleanString(text || '');
    if (!value) return false;
    if (/\d/.test(value)) return false;
    if (isRowStatusText(value) || isLikelyQualitativeResult(value) || isUnitString(value)) return false;
    if (value.length < 2 || value.length > 16) return false;
    return /^[A-ZÀ-Ỵ%()+/#.-]+$/i.test(value);
  }

  function pickIndicatorLabel(cells, fallbackName, codeVal) {
    const candidates = (cells || []).map(c => cleanString(c)).filter(Boolean);
    const hashLabel = candidates.find(c => /#/.test(c) && /^[A-ZÀ-Ỵ0-9#%()+/.-]+$/i.test(c) && c.length <= 8);
    if (hashLabel) return hashLabel;

    const shortLabel = candidates.find(c => /^[A-ZÀ-Ỵ%()+/.-]{2,8}$/i.test(c) && !/\d/.test(c) && !isUnitString(c));
    if (shortLabel) return shortLabel;

    const preferred = candidates.find(c => isLikelyIndicatorLabel(c) && !isUnitString(c));
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
      cleaned.find(c => /^[A-ZÀ-Ỵ%()+/.-]{2,8}$/i.test(c) && !/\d/.test(c) && !isUnitString(c));

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
        return /^([<>]=?\s*)?[-+]?\d+([.,]\d+)?/.test(v) || /\b[HL]\b/i.test(c) || c.includes('*');
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
      if (isUnitString(c)) return false;
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
        if (isRowStatusText(c) || isLikelyQualitativeResult(c) || isUnitString(c)) return false;
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

  function isDoctorOrPersonName(text) {
    if (!text) return false;
    const t = cleanString(text).trim();
    if (!t) return false;
    const lower = t.toLowerCase();

    if (
      lower.startsWith('bs.') ||
      lower.startsWith('bs ') ||
      lower.startsWith('ktv.') ||
      lower.startsWith('ktv ') ||
      lower.startsWith('ths.') ||
      lower.startsWith('ts.') ||
      lower.startsWith('cn.') ||
      lower.includes('bác sĩ') ||
      lower.includes('kỹ thuật viên') ||
      lower.includes('người thực hiện') ||
      lower.includes('người trả') ||
      lower.includes('người nhập') ||
      lower.includes('thực hiện bởi')
    ) {
      return true;
    }

    const words = t.split(/\s+/);
    if (words.length >= 2 && words.length <= 5) {
      const firstWord = words[0].replace(/[^a-zA-ZàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/g, '');
      const commonSurnames = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý', 'Đào', 'Đinh', 'Đoàn', 'Trịnh', 'Mai', 'Phan', 'Trương', 'Lương'];
      if (commonSurnames.some(s => s.toLowerCase() === firstWord.toLowerCase())) {
        const isLabTerm = lower.includes('xét nghiệm') || lower.includes('tế bào') || lower.includes('định lượng') || lower.includes('điện giải') || lower.includes('máu') || lower.includes('nước tiểu') || lower.includes('sinh hóa') || lower.includes('miễn dịch') || lower.includes('tổng phân tích') || lower.includes('nội tiết') || lower.includes('chỉ số');
        if (!isLabTerm) {
          return true;
        }
      }
    }

    return false;
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
      if (!c || isRowStatusText(c) || isLikelyQualitativeResult(c) || isDoctorOrPersonName(c)) return false;
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

    // 2. Tìm ô giá trị (chứa số kết quả như "3.2", "97", "47.15", "7.73", "9.8 mmol/L", "< 5.0")
    const valIdx = nonDateCells.findIndex((c, idx) => {
      if (idx === rangeIdx) return false;
      const cClean = c.trim();
      if (!/\d/.test(cClean)) return false;
      if (/\d{2}\/\d{2}\/\d{4}/.test(cClean)) return false;
      if (/^(19|20)\d{2}$/.test(cClean)) return false;
      if (/^\d{8,}$/.test(cClean.replace(/\s/g, ''))) return false;
      return /^([<>]=?\s*)?[-+]?\d+([.,]\d+)?(\s*[a-zA-Z%^/0-9μµL]+)?$/i.test(cClean);
    });

    if (valIdx !== -1) {
      const rawVal = nonDateCells[valIdx];
      const match = rawVal.match(/^([<>]=?\s*[-+]?\d+([.,]\d+)?)(.*)$/);
      if (match) {
        value = match[1].trim();
        const inlineUnit = match[3].trim();
        if (inlineUnit && !unit) {
          unit = inlineUnit;
        }
      } else {
        value = rawVal;
      }
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

    const longNameCandidate = textCandidates.find(c => 
      c !== name && 
      c !== value && 
      c !== range &&
      !isRangeString(c) &&
      c.length >= 6 && 
      /\s/.test(c) && 
      !isDoctorOrPersonName(c) && 
      !isLikelyQualitativeResult(c) &&
      !c.toLowerCase().includes('lần')
    ) || '';
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
      !c.toLowerCase().includes('mã xét nghiệm') && !c.toLowerCase().includes('tên xét nghiệm') &&
      !isDoctorOrPersonName(c) &&
      !isLikelyQualitativeResult(c) &&
      !isRangeString(c)
    );
    if (nameIdx !== -1) {
      name = nonDateCells[nameIdx];
    }

    if (!testName) {
      testName = nonDateCells.find(c => 
        c !== name && 
        c !== value && 
        c !== range && 
        !isRangeString(c) &&
        /\s/.test(c) && 
        c.length >= 5 && 
        !isDoctorOrPersonName(c) && 
        !isLikelyQualitativeResult(c) &&
        !c.toLowerCase().includes('lần')
      ) || '';
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
      // Chỉ lấy các ô ĐANG HIỂN THỊ (Visible cells) để loại bỏ các cột chứa ID CSDL ẩn của jqGrid
      const rawEls = Array.from(r.querySelectorAll('td, th').length > 0 ? r.querySelectorAll('td, th') : r.querySelectorAll('div[role="gridcell"], div.jqx-grid-cell, div'));
      const visibleEls = rawEls.filter(c => isCellVisible(c));
      const cells = visibleEls.map(c => cleanString(c.innerText));
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

      const nonDateCellsClean = cellsClean.filter(c => !/\d{2}\/\d{2}\/\d{4}/.test(c));
      const hasResultValue = nonDateCellsClean.some(c => {
        const val = c.trim();
        if (/^\d{5,}$/.test(val.replace(/\s/g, ''))) return false; // Bỏ qua ID CSDL ẩn
        if (/^([<>]=?\s*)?[-+]?\d+([.,]\d+)?$/.test(val)) return true;
        if (/[\d.,]+\s*[-~–—]\s*[\d.,]+/.test(val)) return true;
        if (isLikelyQualitativeResult(val)) return true;
        return false;
      });

      const isGroupHeaderRow = 
        cells.length === 1 || 
        r.classList.contains('group-header') || 
        r.classList.contains('jqx-grid-groups-row') ||
        r.querySelector('td[colspan], th[colspan]') !== null ||
        (!hasResultValue && nonDateCellsClean.some(c => c.length >= 10 && /\s/.test(c) && !isDoctorOrPersonName(c) && !isLikelyQualitativeResult(c)));

      if (isGroupHeaderRow) {
        const groupText = r.innerText.trim().replace(/^[☒☑\s+-\s]+/, '');
        const groupTextClean = groupText.replace(/\(\d+\s*chỉ số\)/i, '').trim();
        if (groupTextClean && 
            !groupTextClean.toLowerCase().includes('mã xét nghiệm') && 
            !groupTextClean.toLowerCase().includes('tên xét nghiệm') && 
            !groupTextClean.toLowerCase().includes('danh sách') && 
            !isDoctorOrPersonName(groupTextClean) &&
            !isLikelyQualitativeResult(groupTextClean)) {
          serviceName = groupTextClean;
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
          const finalTestName = (dynamicInd.testName && !isDoctorOrPersonName(dynamicInd.testName) && !isLikelyQualitativeResult(dynamicInd.testName) && !isRangeString(dynamicInd.testName))
            ? dynamicInd.testName
            : serviceName;
          if (serviceName === 'Xét nghiệm cận lâm sàng' && finalTestName !== 'Xét nghiệm cận lâm sàng') {
            serviceName = finalTestName;
          }
          indicators.push({ ...dynamicInd, performedAt, testName: finalTestName });
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
          const finalTestName = (semanticInd.testName && !isDoctorOrPersonName(semanticInd.testName) && !isLikelyQualitativeResult(semanticInd.testName) && !isRangeString(semanticInd.testName))
            ? semanticInd.testName
            : serviceName;
          if (serviceName === 'Xét nghiệm cận lâm sàng' && finalTestName !== 'Xét nghiệm cận lâm sàng') {
            serviceName = finalTestName;
          }
          indicators.push({ ...semanticInd, performedAt, testName: finalTestName });
          return;
        }
      }

      // 2. Dự phòng giải mã theo cột cố định
      const rowTextLower = cells.join(' ').toLowerCase();
      if (rowTextLower.includes('tên xét nghiệm') || rowTextLower.includes('mã xét nghiệm') || rowTextLower.includes('danh sách kết quả')) {
        return;
      }

      const codeVal = (codeIdx !== -1 && cells[codeIdx]) ? cells[codeIdx] : '';
      const serviceNameCell = (nameIdx !== -1 && cells[nameIdx]) ? cells[nameIdx] : '';
      let indicatorName = (nameIdx !== -1 && cells[nameIdx + 1]) ? cells[nameIdx + 1] : serviceNameCell;
      const value = cells[valIdx] || '';
      let range = rangeIdx !== -1 ? (cells[rangeIdx] || '') : '';
      let unit = unitIdx !== -1 ? (cells[unitIdx] || '') : '';

      const rowTestName = (serviceNameCell && !isDoctorOrPersonName(serviceNameCell) && !isLikelyQualitativeResult(serviceNameCell) && !isRangeString(serviceNameCell))
        ? serviceNameCell
        : serviceName;

      if (codeVal && indicatorName && !indicatorName.includes(codeVal) && /^[A-Z0-9._-]+$/i.test(codeVal)) {
        indicatorName = `${indicatorName} (${codeVal})`;
      }

      if (!unit && range) {
        const unitMatch = range.match(/[0-9.,\s]+([a-zA-Z%^/0-9μµL]+)/);
        if (unitMatch) {
          unit = unitMatch[1].trim();
        }
      }

      indicatorName = pickIndicatorLabel(cells, indicatorName, codeVal);
      const isGarbage = isGarbageIndicator(indicatorName, value);
      logDebug(`[Parse] Dòng ${idx} Fallback: name="${indicatorName}", value="${value}", range="${range}", isGarbage=${isGarbage}`);
      if (!isGarbage) {
        let status = evaluateAbnormalStatus(value, range);
        if (serviceName === 'Xét nghiệm cận lâm sàng' && rowTestName !== 'Xét nghiệm cận lâm sàng') {
          serviceName = rowTestName;
        }
        indicators.push({ name: indicatorName, value, unit, range, status, performedAt, testName: rowTestName });
      }
    });

    return { serviceName, indicators };
  }

  function parseRealXHRResponse(url, rawResponseText, requestContext) {
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
          const queryName = requestContext && requestContext.queryName ? requestContext.queryName : '';
          if (queryName === 'NT.024.DSPHIEUCLS') {
            if (requestContext && requestContext.category === 'lab') {
              processHISLabSheetList(items);
            }
            return;
          }
          if (queryName === 'NT024.CLS.CHIDINH') {
            processHISOrderedServices(items);
            return;
          }
          processHISJSONData(items, requestContext || {});
        }
      }
    } catch(e) {}
  }

  function processHISOrderedServices(items) {
    const names = new Set((state.orderedServices || []).map(item =>
      cleanString(typeof item === 'string' ? item : (item && item.name))
    ).filter(Boolean));
    const serviceMap = Object.assign({}, state.orderedServiceMap || {});

    items.forEach(item => {
      const code = cleanString(item.MADICHVU || item.DICHVUID || '').toUpperCase();
      const name = cleanString(item.TENDICHVU || item.TENCHIDINH || '');
      if (!name) return;
      names.add(name);
      if (code) serviceMap[code] = name;
    });

    state.orderedServices = Array.from(names);
    state.orderedServiceMap = serviceMap;
  }

  function processHISLabSheetList(items) {
    const sheetGroups = items.map(item => {
      const sheetId = cleanString(item.MAUBENHPHAMID || '');
      const sheetNumber = cleanString(item.SOPHIEU || '');
      return {
        sheetId,
        sheetNumber,
        serviceName: sheetNumber ? `Phiếu xét nghiệm ${sheetNumber}` : 'Phiếu xét nghiệm',
        performedAt: cleanString(item.NGAYMAUBENHPHAM_HOANTHANH || item.NGAYMAUBENHPHAM || ''),
        sheetStatus: cleanString(item.TRANGTHAIMAUBENHPHAM),
        indicators: [],
        isSheetPlaceholder: true
      };
    }).filter(group => group.sheetId);

    if (isTopFrame) {
      state.labResults = mergeDuplicateLabGroups([...state.labResults, ...sheetGroups]);
      renderContent();
    } else if (sheetGroups.length > 0) {
      try {
        window.top.postMessage({
          type: 'HIS_EXT_PARSED_DATA',
          patient: state.selectedPatient.code !== '---' ? state.selectedPatient : null,
          labResults: sheetGroups,
          imagingResults: []
        }, '*');
      } catch (e) {}
    }
  }

  function processHISJSONData(items, requestContext) {
    let labIndicators = [];
    let imagingItems = [];
    const category = requestContext && requestContext.category ? requestContext.category : '';
    const requestSheetId = cleanString(requestContext && requestContext.sheetId || '');
    const requestSheetNumber = cleanString(requestContext && requestContext.sheetNumber || '');
    const requestSheetDate = cleanString(requestContext && requestContext.sheetDate || '');

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
        ['TENDICHVU', 'TEN_CHI_SO', 'TEN_DV', 'TEN_XETNGHIEM', 'TEN_CHISO', 'CHISO_TEN', 'NAME', 'TEN_CHI_DINH', 'TENCHIDINH'],
        ['tendichvu', 'tenchiso', 'tendv', 'tenxetnghiem', 'chisoten', 'name', 'tenchidinh']
      );
      const value = pickField(item,
        ['GIATRI_KETQUA', 'KET_QUA', 'GIATRI', 'RESULT', 'KETQUA', 'VAL', 'KET_QUA_CLS', 'KETQUA_CLS', 'KETQUACLS'],
        ['giatriketqua', 'ketqua', 'giatri', 'result', 'val', 'ketquacls']
      );
      let range = pickField(item,
        ['TRI_SO_BT', 'CHISO_BT', 'TRI_SO_BINH_THUONG', 'GIATRI_BT', 'RANGE', 'TRI_SO_BT_NAM', 'TRI_SO_BT_NU'],
        ['trisobt', 'chisobt', 'trisobinhthuong', 'giatribt', 'range', 'trisobtnam', 'trisobtnu']
      );
      if (!range && (item.GIATRINHONHAT != null || item.GIATRILONNHAT != null)) {
        const min = cleanString(String(item.GIATRINHONHAT == null ? '' : item.GIATRINHONHAT));
        const max = cleanString(String(item.GIATRILONNHAT == null ? '' : item.GIATRILONNHAT));
        range = min && max ? `${min} - ${max}` : (min ? `>= ${min}` : (max ? `<= ${max}` : ''));
      }
      const unit = pickField(item,
        ['DON_VI', 'DONVI', 'UNIT', 'DVT'],
        ['donvi', 'unit', 'dvt']
      );
      const serviceName = pickField(item,
        ['TENCHIDINH', 'TEN_CHI_DINH', 'TEN_DICH_VU', 'TEN_DVKT', 'TEN_NHOM', 'TENDICHVU'],
        ['tenchidinh', 'tendichvu', 'tendvkt', 'tennhom']
      ) || 'Xét nghiệm cận lâm sàng';
      const performedAt = pickField(item,
        ['THOIGIANTRAKETQUA', 'THOIGIANTRAKETQUA1', 'NGAY_TRA_KQ', 'NGAY_THUC_HIEN', 'NGAY_KET_QUA', 'DATE', 'NGAY'],
        ['thoigiantraketqua', 'thoigiantraketqua1', 'ngaytrakq', 'ngaythuchien', 'ngayketqua', 'date', 'ngay']
      ) || '';

      if (category !== 'imaging' && name && value !== undefined && value !== null && String(value).trim() !== '' && name !== 'STT') {
        const status = evaluateAbnormalStatus(
          String(value),
          String(range || ''),
          item.GIATRINHONHAT,
          item.GIATRILONNHAT
        );
        labIndicators.push({
          serviceName,
          performedAt: performedAt || requestSheetDate,
          sheetId: requestSheetId,
          sheetNumber: requestSheetNumber,
          indicator: { name, value, unit: unit || '', range: range || '', status, performedAt: performedAt || requestSheetDate, testName: serviceName }
        });
      }

      // 2. Quét CĐHA / PACS / DICOM
      const imgServiceName = item.TENDICHVU || item.TENCHIDINH || item.TEN_DICH_VU || item.TEN_CDHA || item.TEN_DVKT || item.SERVICE_NAME;
      const description = item.KETQUACLS || item.MO_TA || item.MOTA || item.DESCRIPTION || '';
      const conclusion = item.GIATRI_KETQUA || item.KET_LUAN || item.KETLUAN || item.CONCLUSION || '';
      const doctor = item.NGUOITRAKETQUA || item.BACSITHUCHIEN || item.BS_DOC || item.TEN_BS || item.BS_KETLUAN || item.DOCTOR_NAME;
      const dicomUrl = item.URL_PACS || item.LINK_PACS || item.LINK_DICOM || item.DICOM_URL || item.URL || item.PATH;
      const date = item.THOIGIANTRAKETQUA || item.THOIGIANTRAKETQUA1 || item.NGAY_TRA_KQ || item.NGAY_THUC_HIEN || item.DATE;

      if (category === 'imaging' && imgServiceName && (description || conclusion || dicomUrl)) {
        imagingItems.push({
          sheetId: requestSheetId,
          sheetNumber: requestSheetNumber,
          serviceName: imgServiceName,
          description,
          conclusion: conclusion || 'Chưa có kết luận.',
          doctor: doctor || 'Bác sĩ CĐHA',
          date: date || new Date().toLocaleDateString('vi-VN'),
          dicomUrl: dicomUrl || '',
          risStudyId: cleanString(item.GHICHU2 || ''),
          slices: normalizeVietnameseText(imgServiceName).includes('ct') ? 12 : 2
        });
        return;
      }

      if (category === 'lab') return;

      if (imgServiceName && (description || conclusion || dicomUrl) && (imgServiceName.toLowerCase().includes('chụp') || imgServiceName.toLowerCase().includes('siêu âm') || imgServiceName.toLowerCase().includes('ct') || imgServiceName.toLowerCase().includes('x-quang') || imgServiceName.toLowerCase().includes('mri') || dicomUrl)) {
        imagingItems.push({
          sheetId: requestSheetId,
          sheetNumber: requestSheetNumber,
          serviceName: imgServiceName,
          description,
          conclusion: conclusion || 'Chưa có kết luận.',
          doctor: doctor || 'Bác sĩ CĐHA',
          date: date || new Date().toLocaleDateString('vi-VN'),
          dicomUrl: dicomUrl || '',
          slices: (imgServiceName && imgServiceName.toLowerCase().includes('ct')) ? 12 : 2
        });
      }
    });

    const grouped = {};
    labIndicators.forEach(i => {
      const key = i.sheetId ? `sheet:${i.sheetId}` : `${i.serviceName || ''}|||${i.performedAt || ''}`;
      if (!grouped[key]) {
        grouped[key] = {
          sheetId: i.sheetId || '',
          sheetNumber: i.sheetNumber || '',
          serviceName: i.sheetNumber ? `Phiếu xét nghiệm ${i.sheetNumber}` : (i.serviceName || 'Xét nghiệm cận lâm sàng'),
          performedAt: i.performedAt || '',
          indicators: []
        };
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
      const key = g.sheetId ? `sheet:${g.sheetId}` : `${sName}|||${performedAt}`;
      if (!map[key]) {
        map[key] = {
          sheetId: g.sheetId || '',
          sheetNumber: g.sheetNumber || '',
          serviceName: sName,
          performedAt,
          sheetStatus: cleanString(g.sheetStatus),
          indicators: [],
          isSheetPlaceholder: !!g.isSheetPlaceholder
        };
      } else {
        if (!map[key].performedAt && performedAt) map[key].performedAt = performedAt;
        if (!map[key].sheetNumber && g.sheetNumber) map[key].sheetNumber = g.sheetNumber;
        if (g.serviceName) map[key].serviceName = g.serviceName;
        if (g.sheetStatus !== undefined && g.sheetStatus !== null && cleanString(g.sheetStatus)) {
          map[key].sheetStatus = cleanString(g.sheetStatus);
        }
        map[key].isSheetPlaceholder = map[key].isSheetPlaceholder || !!g.isSheetPlaceholder;
      }
      (g.indicators || []).forEach(ind => {
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
      .map(key => map[key]);
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
        item.description || '',
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

  function evaluateAbnormalStatus(valueStr, rangeStr, explicitMin, explicitMax) {
    if (!valueStr) return 'NORMAL';
    const val = parseFloat(valueStr.replace(',', '.'));

    if (valueStr.includes('*') || /\bH\b/i.test(valueStr) || valueStr.toLowerCase().includes('tăng')) return 'HIGH';
    if (/\bL\b/i.test(valueStr) || valueStr.toLowerCase().includes('giảm')) return 'LOW';

    if (isNaN(val)) return 'NORMAL';

    // The HIS detail API provides numeric bounds separately. Prefer them over
    // the formatted range text, which often has the unit appended directly.
    const minFromApi = parseFloat(cleanString(explicitMin).replace(',', '.'));
    const maxFromApi = parseFloat(cleanString(explicitMax).replace(',', '.'));
    if (!isNaN(minFromApi) && val < minFromApi) return 'LOW';
    if (!isNaN(maxFromApi) && val > maxFromApi) return 'HIGH';
    if (!isNaN(minFromApi) || !isNaN(maxFromApi)) return 'NORMAL';

    if (!rangeStr) return 'NORMAL';

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
    const pBhyt = document.getElementById('his-p-bhyt');
    const pCccd = document.getElementById('his-p-cccd');
    const pIcd = document.getElementById('his-p-icd');
    const pDiagnosis = document.getElementById('his-p-diagnosis');

    if (pName) pName.textContent = p.name || 'Bệnh nhân';
    if (pCode) pCode.textContent = p.code || 'BN---';
    if (pGenderAge) pGenderAge.textContent = `${p.age || '--'} tuổi | Giới tính: ${p.gender || '--'}`;
    if (pRoom) pRoom.textContent = `${p.room || ''} - ${p.bed || ''}`;
    if (pBhyt) pBhyt.textContent = p.healthInsuranceNumber || '';
    if (pCccd) pCccd.textContent = p.citizenId || '';
    if (pIcd) pIcd.textContent = p.primaryIcd || '';
    if (pDiagnosis) pDiagnosis.textContent = p.diagnosis || '';
  }

  function applyPatientMetadata(patient) {
    if (!patient || typeof patient !== 'object') return;
    const compact = {};
    Object.keys(patient).forEach(key => {
      const value = cleanString(patient[key]);
      if (value) compact[key] = value;
    });
    state.selectedPatient = Object.assign({}, state.selectedPatient, compact);
    updatePatientInfoUI();
  }

  function renderContent() {
    const body = document.getElementById('his-drawer-body-content');
    if (!body) return;

    const sortedLabResults = [...(state.labResults || [])]
      .sort((a, b) => getLabGroupTimestamp(b) - getLabGroupTimestamp(a));
    const sheetIds = new Set(sortedLabResults.map(group => group.sheetId).filter(Boolean));
    const totalLabCount = sheetIds.size > 0 ? sheetIds.size : sortedLabResults.length;

    const totalImagingCount = state.imagingResults.length;

    const countLab = document.getElementById('his-count-lab');
    const countImg = document.getElementById('his-count-imaging');
    const triggerBadge = document.getElementById('his-trigger-badge');

    if (countLab) countLab.textContent = totalLabCount;
    if (countImg) countImg.textContent = totalImagingCount;
    if (triggerBadge) triggerBadge.textContent = totalLabCount + totalImagingCount;

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
        <div style="font-weight: 600; font-size: 14px; margin-bottom: 6px; color: #1e293b;">🧬 Đang tải kết quả trực tiếp từ HIS...</div>
        <div style="font-size: 11px; color:#64748b; max-width:260px;">Tiện ích đang đồng bộ phiếu xét nghiệm và CĐHA qua API.</div>
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
        <label class="his-toggle-label">
          <input type="checkbox" id="his-only-incomplete-lab-chk" ${state.showOnlyIncompleteLabs ? 'checked' : ''}>
          Xét nghiệm chưa hoàn thành
        </label>
      </div>
    `;

    let hasData = false;
    let sortedLabResults = [...(state.labResults || [])]
      .sort((a, b) => getLabGroupTimestamp(b) - getLabGroupTimestamp(a));
    if (state.showOnlyIncompleteLabs) {
      sortedLabResults = sortedLabResults.filter(group => cleanString(group.sheetStatus) !== '3');
    }

    sortedLabResults.forEach(group => {
      const displayDate = group.performedAt || (group.indicators.find(i => i.performedAt)?.performedAt || '');
      let indicatorsToDisplay = [...group.indicators]
        .sort((a, b) => parseHISDateTimestamp(b && b.performedAt) - parseHISDateTimestamp(a && a.performedAt));
      if (state.showOnlyAbnormal) {
        indicatorsToDisplay = indicatorsToDisplay.filter(i => i.status === 'HIGH' || i.status === 'LOW');
      }

      if (state.filterKeyword) {
        const kw = state.filterKeyword.toLowerCase();
        indicatorsToDisplay = indicatorsToDisplay.filter(i => 
          i.name.toLowerCase().includes(kw) ||
          (i.testName || group.serviceName || '').toLowerCase().includes(kw) ||
          displayDate.toLowerCase().includes(kw)
        );
      }

      const groupKeywordMatch = !state.filterKeyword ||
        group.serviceName.toLowerCase().includes(state.filterKeyword.toLowerCase()) ||
        displayDate.toLowerCase().includes(state.filterKeyword.toLowerCase());
      const shouldShowEmptySheet = !!group.sheetId &&
        (!state.showOnlyAbnormal || state.showOnlyIncompleteLabs) && groupKeywordMatch;

      if (indicatorsToDisplay.length > 0 || shouldShowEmptySheet) {
        hasData = true;
        html += `
        <div class="his-service-group ${cleanString(group.sheetId) === state.selectedLabSheetId ? 'his-sheet-selected' : ''}" data-his-sheet-id="${group.sheetId || ''}" data-his-sheet-number="${group.sheetNumber || ''}" title="Bấm để chọn phiếu này trên HIS">
            <div class="his-group-header">
              <span>🩺 ${group.serviceName}</span>
              <span class="his-patient-tag">${displayDate || 'Không rõ ngày'}</span>
            </div>
            <div class="his-table-scroll">
            <table class="his-abnormal-table">
              <thead>
                <tr>
                  <th>Ngày thực hiện</th>
                  <th>Tên xét nghiệm</th>
                  <th>Tên chỉ số</th>
                  <th>Trạng thái</th>
                  <th>Kết quả</th>
                  <th>Giá trị BT</th>
                </tr>
              </thead>
              <tbody>
        `;

        const preparedIndicators = indicatorsToDisplay.map(ind => {
          const rawTestName = (ind.testName && !isDoctorOrPersonName(ind.testName) && !isRangeString(ind.testName))
            ? ind.testName
            : (group.serviceName && !isDoctorOrPersonName(group.serviceName) && !isRangeString(group.serviceName) ? group.serviceName : 'Xét nghiệm cận lâm sàng');
          const displayTestName = matchServiceFromOrderedList(rawTestName, ind.name, state.orderedServices);
          return { ind, displayTestName, testNameKey: normalizeVietnameseText(displayTestName).trim() };
        });

        preparedIndicators.forEach((prepared, index) => {
          const { ind, displayTestName, testNameKey } = prepared;
          const isHigh = ind.status === 'HIGH';
          const isLow = ind.status === 'LOW';
          const statusText = isHigh ? '▲ Cao' : isLow ? '▼ Thấp' : 'BT';
          const statusClass = isHigh ? 'high' : isLow ? 'low' : 'normal';
          const startsTestGroup = index === 0 || preparedIndicators[index - 1].testNameKey !== testNameKey;
          let testGroupSize = 1;
          if (startsTestGroup) {
            while (index + testGroupSize < preparedIndicators.length && preparedIndicators[index + testGroupSize].testNameKey === testNameKey) {
              testGroupSize++;
            }
          }
          const testNameCell = startsTestGroup
            ? `<td class="his-test-name-col his-test-name-group" rowspan="${testGroupSize}" title="${displayTestName}">
                 <div class="his-test-name-text">${displayTestName}</div>
                 ${testGroupSize > 1 ? `<span class="his-test-count">${testGroupSize} chỉ số</span>` : ''}
               </td>`
            : '';

          html += `
            <tr class="${ind.status !== 'NORMAL' ? 'his-abnormal-row' : ''}">
              <td class="his-date-cell">
                <span class="his-date-badge" title="Thời gian thực hiện: ${ind.performedAt || displayDate || 'N/A'}">
                  📅 ${ind.performedAt || displayDate || 'N/A'}
                </span>
              </td>
              ${testNameCell}
              <td class="his-indicator-name" title="${ind.name}">
                <div class="his-indicator-name-text">${ind.name}</div>
              </td>
              <td>
                <span class="his-status-badge ${statusClass}">
                  ${statusText}
                </span>
              </td>
              <td class="his-indicator-value ${statusClass}">${ind.value} <span style="font-size:10px; font-weight:normal; color:#94a3b8;">${ind.unit}</span></td>
              <td class="his-range-cell" title="${ind.range || 'N/A'}">${ind.range || 'N/A'}</td>
            </tr>
          `;
        });

        if (indicatorsToDisplay.length === 0) {
          html += `
            <tr>
              <td colspan="6" style="padding:14px;text-align:center;color:#64748b;">Phiếu chưa có kết quả xét nghiệm.</td>
            </tr>
          `;
        }

        html += `
              </tbody>
            </table>
            </div>
          </div>
        `;
      }
    });

    if (!hasData) {
      html += `
        <div class="his-empty-state">
          <div class="his-empty-icon">✅</div>
          <h3>${state.showOnlyIncompleteLabs ? 'Không có xét nghiệm chưa hoàn thành!' : 'Không có chỉ số Xét nghiệm vượt cận!'}</h3>
          <p>${state.showOnlyIncompleteLabs ? 'Tất cả phiếu xét nghiệm đã hoàn thành.' : 'Tất cả các xét nghiệm của bệnh nhân đều nằm trong giới hạn bình thường hoặc chưa có dữ liệu mới.'}</p>
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
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
          chrome.storage.sync.set({ showOnlyAbnormal: state.showOnlyAbnormal });
        }
        renderLabResults(container);
      };
    }

    const incompleteChk = document.getElementById('his-only-incomplete-lab-chk');
    if (incompleteChk) {
      incompleteChk.onchange = (e) => {
        state.showOnlyIncompleteLabs = e.target.checked;
        renderLabResults(container);
      };
    }
    bindPanelSheetFocusHandlers(container, 'lab');
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

    const sortedImagingResults = [...state.imagingResults]
      .sort((a, b) => parseHISDateTimestamp(b && b.date) - parseHISDateTimestamp(a && a.date));

    sortedImagingResults.forEach((study, idx) => {
      const canOpenRis = !!cleanString(study.risStudyId) || (study.dicomUrl && study.dicomUrl.startsWith('http'));
      const dicomButton = canOpenRis
        ? `<button class="his-btn-dicom" data-study-idx="${idx}">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
             👁️ Xem DICOM / RIS
           </button>`
        : `<button class="his-btn-dicom" disabled title="RIS chưa trả về đường dẫn phim" style="opacity:.55;cursor:not-allowed;">Chưa có link DICOM</button>`;
      html += `
        <div class="his-imaging-card ${cleanString(study.sheetId) === state.selectedImagingSheetId ? 'his-sheet-selected' : ''}" data-his-sheet-id="${study.sheetId || ''}" data-his-sheet-number="${study.sheetNumber || ''}" title="Bấm để chọn phiếu này trên HIS">
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

          ${study.description ? `
            <details class="his-imaging-description">
              <summary>Mô tả chi tiết</summary>
              <div class="his-imaging-description-content">${study.description}</div>
            </details>
          ` : ''}

          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
            ${dicomButton}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.his-btn-dicom').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.getAttribute('data-study-idx'), 10);
        const study = sortedImagingResults[idx];
        if (study) openFreshRisViewer(study);
      };
    });
    bindPanelSheetFocusHandlers(container, 'imaging');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

})();
