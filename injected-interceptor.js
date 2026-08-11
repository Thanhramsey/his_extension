/**
 * VNPT HIS network bridge.
 * Runs in the page context so requests reuse the authenticated HIS session.
 */
(function () {
  'use strict';

  if (window.__HIS_INTERCEPTOR_INJECTED__) return;
  window.__HIS_INTERCEPTOR_INJECTED__ = true;

  const REST_SERVICE_MARKER = '/vnpthis/restservice';
  const RIS_VIEWER_MARKER = '/api/public/dicomviewer';
  const DETAIL_QUERY = 'NT.024.2';
  const ORDER_QUERY = 'NT024.CLS.CHIDINH';
  const LIST_QUERY = 'NT.024.DSPHIEUCLS';
  const PATIENT_CONTEXT_KEY = 'NT021.TAB.SLSKDT';
  const OUTPATIENT_CONTEXT_QUERY = 'NGT02K001.EV002';
  const relevantQueries = new Set([DETAIL_QUERY, ORDER_QUERY, LIST_QUERY]);

  let activePatientContext = null;
  let activeRisConfig = null;
  const knownSheetCategories = new Map();
  let lastLoadedContextKey = '';
  let loadGeneration = 0;

  function safeParseJSON(value) {
    if (!value || typeof value !== 'string') return null;
    try { return JSON.parse(value); } catch (e) { return null; }
  }

  function getRequestPayload(url, body) {
    const parsedBody = typeof body === 'string' ? safeParseJSON(body) : null;
    if (parsedBody) return parsedBody;

    try {
      const parsedUrl = new URL(String(url), window.location.href);
      return safeParseJSON(parsedUrl.searchParams.get('postData'));
    } catch (e) {
      return null;
    }
  }

  function getQueryName(payload) {
    return payload && Array.isArray(payload.params) ? String(payload.params[0] || '') : '';
  }

  function getOptionValues(payload) {
    if (!payload || !Array.isArray(payload.options)) return [];
    return payload.options.map(option => String(option && option.value != null ? option.value : ''));
  }

  function postToExtension(type, detail) {
    window.postMessage(Object.assign({ type }, detail || {}), '*');
  }

  function forwardRelevantResponse(url, payload, responseText, context) {
    const queryName = getQueryName(payload);
    if (!relevantQueries.has(queryName) || !responseText) return;

    // Requests created by our background loader always carry a category. A
    // detail request without it comes from selecting a sheet in the HIS UI:
    // notify the panel, but never ingest the same response as another record.
    if ((!context || !context.category) && (queryName === DETAIL_QUERY || queryName === ORDER_QUERY)) {
      const sheetId = getOptionValues(payload)[0] || '';
      if (sheetId) {
        postToExtension('HIS_SHEET_SELECTED', {
          sheetId,
          category: knownSheetCategories.get(String(sheetId)) || ''
        });
      }
      return;
    }

    postToExtension('HIS_XHR_DATA', {
      url: String(url || ''),
      queryName,
      category: context && context.category ? context.category : '',
      sheetId: context && context.sheetId ? context.sheetId : '',
      sheetNumber: context && context.sheetNumber ? context.sheetNumber : '',
      sheetDate: context && context.sheetDate ? context.sheetDate : '',
      response: responseText
    });
  }

  function forwardPatientMetadata(responseText) {
    const outer = safeParseJSON(responseText);
    if (!outer) return;

    let data = outer;
    if (typeof outer.result === 'string') data = safeParseJSON(outer.result);
    else if (outer.result && typeof outer.result === 'object') data = outer.result;
    const row = Array.isArray(data) ? data[0] : (data && Array.isArray(data.rows) ? data.rows[0] : data);
    if (!row || typeof row !== 'object') return;

    const pick = (...keys) => {
      for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim()) return String(row[key]).trim();
      }
      return '';
    };
    const patient = {
      name: pick('TENBENHNHAN', 'TEN_BENH_NHAN'),
      code: pick('MABENHAN', 'MAHOSOBENHAN', 'SOLUUTRU', 'MABENHNHAN', 'MA_BENH_AN'),
      age: pick('SOTUOI', 'TUOI'),
      gender: pick('GIOITINH', 'GIOI_TINH'),
      room: pick('PHONGKHAM', 'PHONGDIEUTRI', 'PHONG'),
      healthInsuranceNumber: pick('SOTHEBHYT', 'SOTHE_BHYT', 'MABHYT', 'MA_THE_BHYT'),
      primaryIcd: pick('MACDC', 'BENHCHINHCODE', 'MACHANDOANVAOVIEN', 'MAICDCHINH', 'ICDCHINH', 'MA_CHAN_DOAN_CHINH'),
      diagnosis: pick('CDC', 'CHANDOANDIEUTRI', 'CHANDOANVAOKHOA', 'BENHCHINHVAOKHOA', 'CHANDOANVAOVIEN1', 'CHANDOANVAOVIEN', 'CHANDOAN', 'CHAN_DOAN', 'CHANDOANCHINH', 'CHAN_DOAN_CHINH'),
      citizenId: pick('CCCD', 'SOCMTND', 'SOCCCD', 'SO_CCCD', 'CANCUOC', 'SOCANCUOC', 'SO_CANCUOC', 'CMND', 'SOCMND', 'SO_CMND')
    };

    if (!patient.primaryIcd && patient.diagnosis) {
      const icdMatch = patient.diagnosis.match(/^\s*([A-Z][0-9]{2}(?:\.[0-9A-Z]+)?[†*]?)/i);
      if (icdMatch) patient.primaryIcd = icdMatch[1];
    }

    // Ignore ordinary lab/imaging rows that happen to contain a patient name/code.
    if (!patient.healthInsuranceNumber && !patient.primaryIcd && !patient.diagnosis && !patient.citizenId) return;
    postToExtension('HIS_PATIENT_METADATA', { patient });
  }

  function forwardRisViewerResponse(url, responseText) {
    const json = safeParseJSON(responseText);
    const viewerUrl = json && typeof json.data === 'string' ? json.data.trim() : '';
    if (!/^https?:\/\//i.test(viewerUrl)) return;
    try {
      const requestUrl = new URL(String(url), window.location.href);
      const resultUrl = new URL(viewerUrl);
      if (requestUrl.origin !== resultUrl.origin) return;
      postToExtension('HIS_RIS_VIEWER_URL', {
        studyInstanceUID: requestUrl.searchParams.get('studyInstanceUID') || '',
        viewerUrl
      });
    } catch (e) {}
  }

  function activatePatientContext(patientEncounterId, treatmentContextId, uuid, careType) {
    if (!patientEncounterId || !treatmentContextId || !uuid) return;

    activePatientContext = { patientEncounterId, treatmentContextId, uuid, careType: careType || '' };
    const contextKey = `${patientEncounterId}|${treatmentContextId}`;
    if (contextKey === lastLoadedContextKey) return;
    lastLoadedContextKey = contextKey;
    postToExtension('HIS_API_CONTEXT', {
      careType: careType || '',
      contextKey: `${careType || 'unknown'}:${patientEncounterId}:${treatmentContextId}`
    });
    loadPatientClinicalData(activePatientContext);
  }

  function observePatientContext(payload) {
    if (!payload || payload.func !== 'getOneValue' || payload.params?.[1] !== PATIENT_CONTEXT_KEY) return;

    const values = getOptionValues(payload);
    activatePatientContext(
      values[0],
      values[1],
      typeof payload.uuid === 'string' ? payload.uuid : '',
      'inpatient'
    );
  }

  function readHiddenNumericValue(selectors) {
    const documents = [document];
    try {
      if (window.parent && window.parent !== window && window.parent.document) documents.push(window.parent.document);
    } catch (e) {}
    try {
      if (window.top && window.top.document && !documents.includes(window.top.document)) documents.push(window.top.document);
    } catch (e) {}

    for (const doc of documents) {
      for (const selector of selectors) {
        const element = doc.querySelector(selector);
        const value = String(element && (element.value || element.getAttribute('value')) || '').trim();
        if (/^\d+$/.test(value) && value !== '0') return value;
      }
    }
    return '';
  }

  function observeOutpatientContext(payload) {
    if (!payload || payload.func !== 'ajaxCALL_SP_O' || payload.params?.[0] !== OUTPATIENT_CONTEXT_QUERY) return;
    const rawContext = String(payload.params?.[1] || '');
    const patientEncounterId = rawContext.split('$')[0].trim();
    const uuid = typeof payload.uuid === 'string' ? payload.uuid : '';
    if (!/^\d+$/.test(patientEncounterId) || !uuid) return;

    const tryActivate = () => {
      const visibleEncounterId = readHiddenNumericValue([
        '#hidKHAMBENHID',
        '[id$="hidKHAMBENHID"]',
        '[id$="KHAMBENHID"]',
        'input[name="KHAMBENHID"]',
        'input[name="khambenhid"]'
      ]);
      if (visibleEncounterId && visibleEncounterId !== patientEncounterId) return false;

      const patientId = readHiddenNumericValue([
        '#hidBENHNHANID',
        '[id$="hidBENHNHANID"]',
        '[id$="BENHNHANID"]',
        'input[name="BENHNHANID"]',
        'input[name="benhnhanid"]'
      ]);
      if (!patientId) return false;
      activatePatientContext(patientEncounterId, patientId, uuid, 'outpatient');
      return true;
    };

    if (tryActivate()) return;
    [100, 300, 800, 1500].forEach(delay => setTimeout(tryActivate, delay));
  }

  function buildPagingUrl(queryName, options, uuid, paging) {
    const payload = {
      func: 'ajaxExecuteQueryPaging',
      uuid,
      params: [queryName],
      options: options.map((value, index) => ({ name: `[${index}]`, value: String(value) }))
    };
    const params = new URLSearchParams({
      postData: JSON.stringify(payload),
      _search: 'false',
      nd: String(Date.now()),
      rows: String(paging.rows || 500),
      page: String(paging.page || 1),
      sidx: paging.sidx || '',
      sord: paging.sord || 'asc'
    });
    return `${window.location.origin}/vnpthis/RestService?${params.toString()}`;
  }

  async function loadRisConfig(uuid) {
    // Let HIS initialize its own RIS globals; getHashRIS depends on them.
    try {
      if (typeof window.loadRISConfig === 'function') {
        await Promise.resolve(window.loadRISConfig());
      }
    } catch (e) {}

    const response = await originalFetch.call(window, `${window.location.origin}/vnpthis/RestService`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: JSON.stringify({
        func: 'ajaxCALL_SP_S',
        params: [
          'CLS02C001.RISC',
          "['RIS_SERVICE_DOMAIN_NAME','RIS_GET_DICOM_VIEWER']"
        ],
        uuid
      })
    });
    if (!response.ok) throw new Error(`RIS config HTTP ${response.status}`);
    const outer = safeParseJSON(await response.text());
    const config = outer && typeof outer.result === 'string' ? safeParseJSON(outer.result) : null;
    if (!config || !config.RIS_SERVICE_DOMAIN_NAME || !config.RIS_GET_DICOM_VIEWER) {
      throw new Error('Thiếu cấu hình RIS viewer');
    }
    activeRisConfig = config;
    return config;
  }

  async function loadInpatientPatientMetadata(context) {
    if (!context || context.careType !== 'inpatient') return;
    const response = await originalFetch.call(window, `${window.location.origin}/vnpthis/RestService`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: JSON.stringify({
        func: 'ajaxCALL_SP_O',
        params: ['NT.005', String(context.patientEncounterId), 0],
        uuid: context.uuid
      })
    });
    if (!response.ok) throw new Error(`Thông tin nội trú HTTP ${response.status}`);
    forwardPatientMetadata(await response.text());
  }

  async function resolveRisViewerUrl(item) {
    const identifyCode = String(item && item.GHICHU2 != null ? item.GHICHU2 : '').trim();
    let accessHash = '';
    try {
      if (typeof window.getHashRIS === 'function') {
        accessHash = String(window.getHashRIS(identifyCode) || '').trim();
      }
    } catch (e) {}
    // Compatibility fallback for HIS variants that return the access hash in-row.
    if (!accessHash) accessHash = String(item && item.PARAM_HASHED != null ? item.PARAM_HASHED : '').trim();
    if (!activeRisConfig || !identifyCode || !accessHash) return '';

    const base = String(activeRisConfig.RIS_SERVICE_DOMAIN_NAME).replace(/\/+$/, '');
    const path = String(activeRisConfig.RIS_GET_DICOM_VIEWER).replace(/^\/+/, '');
    const url = `${base}/${path}?studyInstanceUID=${encodeURIComponent(identifyCode)}`;
    const response = await originalFetch.call(window, url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Identify-Code': identifyCode,
        'Ris-Access-Hash': accessHash
      }
    });
    if (!response.ok) return '';
    const json = safeParseJSON(await response.text());
    const viewerUrl = json && typeof json.data === 'string' ? json.data.trim() : '';
    if (!/^https?:\/\//i.test(viewerUrl)) return '';

    // Only accept a viewer URL returned by the configured RIS host.
    try {
      if (new URL(viewerUrl).origin !== new URL(base).origin) return '';
    } catch (e) {
      return '';
    }
    return viewerUrl;
  }

  async function enrichImagingResponse(responseText) {
    const json = safeParseJSON(responseText);
    if (!json || !Array.isArray(json.rows)) return responseText;
    await Promise.allSettled(json.rows.map(async item => {
      try {
        const viewerUrl = await resolveRisViewerUrl(item);
        if (viewerUrl) {
          item.LINK_DICOM = viewerUrl;
          postToExtension('HIS_RIS_LINK_STATE', { success: true });
        } else {
          postToExtension('HIS_RIS_LINK_STATE', { success: false });
        }
      } catch (e) {
        postToExtension('HIS_RIS_LINK_STATE', { success: false });
      }
    }));
    return JSON.stringify(json);
  }

  async function executePagingQuery(queryName, options, uuid, paging, context) {
    const url = buildPagingUrl(queryName, options, uuid, paging || {});
    // Use the native fetch directly; the categorized response is forwarded below once.
    const response = await originalFetch.call(window, url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let text = await response.text();
    if (queryName === DETAIL_QUERY && context && context.category === 'imaging') {
      text = await enrichImagingResponse(text);
    }
    forwardRelevantResponse(url, { params: [queryName] }, text, context);
    const json = safeParseJSON(text);
    return json && Array.isArray(json.rows) ? json.rows : [];
  }

  async function loadSheetDetails(sheet, category, context, generation) {
    if (generation !== loadGeneration) return;
    const sheetId = String(sheet && sheet.MAUBENHPHAMID != null ? sheet.MAUBENHPHAMID : '');
    if (!sheetId) return;

    await Promise.allSettled([
      executePagingQuery(DETAIL_QUERY, [sheetId], context.uuid, {
        rows: 500,
        sidx: 'TENCHIDINH asc,',
        sord: 'asc'
      }, {
        category,
        sheetId,
        sheetNumber: String(sheet.SOPHIEU || ''),
        sheetDate: String(sheet.NGAYMAUBENHPHAM_HOANTHANH || sheet.NGAYMAUBENHPHAM || '')
      }),
      executePagingQuery(ORDER_QUERY, [sheetId], context.uuid, {
        rows: 500,
        sord: 'asc'
      }, {
        category,
        sheetId,
        sheetNumber: String(sheet.SOPHIEU || ''),
        sheetDate: String(sheet.NGAYMAUBENHPHAM_HOANTHANH || sheet.NGAYMAUBENHPHAM || '')
      })
    ]);
  }

  async function runWithConcurrency(tasks, limit) {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (nextIndex < tasks.length) {
        const taskIndex = nextIndex++;
        await tasks[taskIndex]();
      }
    });
    await Promise.allSettled(workers);
  }

  async function loadPatientClinicalData(context) {
    const generation = ++loadGeneration;
    knownSheetCategories.clear();
    postToExtension('HIS_API_LOADING_STATE', { isLoading: true });

    try {
      if (context.careType === 'inpatient') {
        // NT.005 is normally requested before document_end, so explicitly reload it.
        loadInpatientPatientMetadata(context).catch(() => {});
      }
      const [labSheets, imagingSheets] = await Promise.all([
        executePagingQuery(LIST_QUERY, [context.patientEncounterId, context.treatmentContextId, '1', '-1'], context.uuid, {
          rows: 500,
          sidx: 'KHOADIEUTRI asc,',
          sord: 'asc'
        }, { category: 'lab' }),
        executePagingQuery(LIST_QUERY, [context.patientEncounterId, context.treatmentContextId, '2', '-1'], context.uuid, {
          rows: 500,
          sidx: 'KHOADIEUTRI asc,',
          sord: 'asc'
        }, { category: 'imaging' })
      ]);

      labSheets.forEach(sheet => {
        if (sheet && sheet.MAUBENHPHAMID != null) knownSheetCategories.set(String(sheet.MAUBENHPHAMID), 'lab');
      });
      imagingSheets.forEach(sheet => {
        if (sheet && sheet.MAUBENHPHAMID != null) knownSheetCategories.set(String(sheet.MAUBENHPHAMID), 'imaging');
      });

      if (imagingSheets.length > 0) {
        try { await loadRisConfig(context.uuid); } catch (e) { activeRisConfig = null; }
      }

      const jobs = [];
      labSheets.forEach(sheet => jobs.push(() => loadSheetDetails(sheet, 'lab', context, generation)));
      imagingSheets.forEach(sheet => jobs.push(() => loadSheetDetails(sheet, 'imaging', context, generation)));
      // Keep pressure on the clinical HIS service modest while still loading quickly.
      await runWithConcurrency(jobs, 3);

      if (generation === loadGeneration) {
        postToExtension('HIS_LAB_SHEET_LIST', {
          sheets: labSheets.map(sheet => ({
            MAUBENHPHAMID: sheet.MAUBENHPHAMID,
            SOPHIEU: sheet.SOPHIEU,
            TRANGTHAIMAUBENHPHAM: sheet.TRANGTHAIMAUBENHPHAM,
            NGAYMAUBENHPHAM: sheet.NGAYMAUBENHPHAM,
            NGAYMAUBENHPHAM_HOANTHANH: sheet.NGAYMAUBENHPHAM_HOANTHANH
          }))
        });
        postToExtension('HIS_API_LOADING_STATE', {
          isLoading: false,
          success: true,
          sheetCount: labSheets.length + imagingSheets.length
        });
      }
    } catch (error) {
      if (generation === loadGeneration) {
        postToExtension('HIS_API_LOADING_STATE', {
          isLoading: false,
          success: false,
          error: error && error.message ? error.message : 'Không thể tải dữ liệu HIS'
        });
      }
    }
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__hisRequestUrl = url;
    this.__hisRequestMethod = method;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__hisRequestUrl;
    const isRestService = String(url || '').toLowerCase().includes(REST_SERVICE_MARKER);
    const isRisViewer = String(url || '').toLowerCase().includes(RIS_VIEWER_MARKER);
    if (isRestService) {
      const payload = getRequestPayload(url, body);
      observePatientContext(payload);
      observeOutpatientContext(payload);
      this.addEventListener('load', function () {
        try {
          forwardRelevantResponse(url, payload, this.responseText, null);
          forwardPatientMetadata(this.responseText);
        } catch (e) {}
      });
    } else if (isRisViewer) {
      this.addEventListener('load', function () {
        try { forwardRisViewerResponse(url, this.responseText); } catch (e) {}
      });
    }
    return originalSend.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const input = args[0];
        const init = args[1] || {};
        const url = input ? (typeof input === 'string' ? input : input.url) : '';
        if (String(url).toLowerCase().includes(REST_SERVICE_MARKER)) {
          const body = init.body || (input && typeof input !== 'string' ? input.body : null);
          const payload = getRequestPayload(url, body);
          observePatientContext(payload);
          observeOutpatientContext(payload);
          const clone = response.clone();
          clone.text().then(text => {
            forwardRelevantResponse(url, payload, text, null);
            forwardPatientMetadata(text);
          }).catch(() => {});
        } else if (String(url).toLowerCase().includes(RIS_VIEWER_MARKER)) {
          const clone = response.clone();
          clone.text().then(text => forwardRisViewerResponse(url, text)).catch(() => {});
        }
      } catch (e) {}
      return response;
    };
  }

  window.addEventListener('message', async function (event) {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'HIS_API_RELOAD') {
      if (activePatientContext) {
        lastLoadedContextKey = '';
        loadPatientClinicalData(activePatientContext);
      }
      return;
    }

    if (event.data.type === 'HIS_RIS_REFRESH_REQUEST' && activePatientContext) {
      const requestId = String(event.data.requestId || '');
      const studyInstanceUID = String(event.data.studyInstanceUID || '').trim();
      if (!requestId || !studyInstanceUID) return;

      try {
        // Refresh config/session state and sign a new viewer URL on every click.
        await loadRisConfig(activePatientContext.uuid);
        const viewerUrl = await resolveRisViewerUrl({ GHICHU2: studyInstanceUID });
        postToExtension('HIS_RIS_REFRESH_RESULT', {
          requestId,
          studyInstanceUID,
          viewerUrl,
          success: !!viewerUrl
        });
      } catch (error) {
        postToExtension('HIS_RIS_REFRESH_RESULT', {
          requestId,
          studyInstanceUID,
          viewerUrl: '',
          success: false,
          error: error && error.message ? error.message : 'Không thể làm mới link RIS'
        });
      }
    }
  });
})();
