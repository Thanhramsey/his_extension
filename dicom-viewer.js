/**
 * VNPT HIS DICOM & Imaging Viewer Module
 * Quản lý Modal hiển thị ảnh DICOM / PACS trực tiếp trong giao diện VNPT HIS
 */

window.HISDicomViewer = {
  activeStudy: null,
  currentSlice: 0,
  zoomLevel: 1,
  panX: 0,
  panY: 0,
  rotation: 0,
  inverted: false,
  windowLevel: 128,
  windowWidth: 256,
  isDragging: false,
  startX: 0,
  startY: 0,

  /**
   * Khởi tạo và hiển thị Modal DICOM Viewer
   * @param {Object} study Thông tin ca chụp (patientName, patientCode, serviceName, conclusion, dicomUrl, slices)
   */
  openModal(study) {
    this.activeStudy = study;
    this.currentSlice = 0;
    this.zoomLevel = 1;
    this.panX = 0;
    this.panY = 0;
    this.rotation = 0;
    this.inverted = false;

    // Xóa modal cũ nếu có
    const existing = document.getElementById('his-dicom-modal-overlay');
    if (existing) existing.remove();

    // Tạo HTML cho Modal
    const modalHTML = `
      <div id="his-dicom-modal-overlay" class="his-dicom-overlay">
        <div class="his-dicom-container">
          <!-- Header -->
          <div class="his-dicom-header">
            <div class="his-dicom-patient-info">
              <div class="his-dicom-badge">DICOM PACS VIEWER</div>
              <h3 class="his-dicom-title">${study.serviceName || 'Chẩn đoán hình ảnh'}</h3>
              <span class="his-dicom-sub">BN: <strong>${study.patientName || 'N/A'}</strong> (Mã: ${study.patientCode || 'N/A'}) | Ngày: ${study.date || new Date().toLocaleDateString('vi-VN')}</span>
            </div>
            <div class="his-dicom-actions">
              <button id="his-pacs-external-btn" class="his-btn-secondary" title="Mở trang PACS chuyên dụng">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                Mở PACS VNPT
              </button>
              <button id="his-dicom-close-btn" class="his-btn-close">&times;</button>
            </div>
          </div>

          <!-- Body Grid -->
          <div class="his-dicom-body">
            <!-- Sidebar kết luận & danh sách lát cắt -->
            <div class="his-dicom-sidebar">
              <div class="his-dicom-card">
                <h4>📌 Kết luận Bác sĩ CĐHA</h4>
                <div class="his-dicom-conclusion">
                  ${study.conclusion || 'Chưa có kết luận chính thức.'}
                </div>
              </div>

              <div class="his-dicom-card">
                <h4>🎞️ Danh sách Series / Lát cắt (${(study.slices && study.slices.length) || 8} ảnh)</h4>
                <div class="his-slice-list" id="his-slice-thumbnails">
                  <!-- Thumbnails generated dynamically -->
                </div>
              </div>
            </div>

            <!-- Viewport xem ảnh DICOM canvas -->
            <div class="his-dicom-viewport-wrapper">
              <!-- Thanh công cụ xử lý ảnh -->
              <div class="his-dicom-toolbar">
                <button class="his-tool-btn" id="his-tool-zoom-in" title="Phóng to (+)">🔍+</button>
                <button class="his-tool-btn" id="his-tool-zoom-out" title="Thu nhỏ (-)">🔍-</button>
                <button class="his-tool-btn" id="his-tool-rotate" title="Xoay 90 độ">🔄 Xoay</button>
                <button class="his-tool-btn" id="his-tool-invert" title="Đảo màu Âm bản/Dương bản">☯️ Đảo màu</button>
                <button class="his-tool-btn" id="his-tool-reset" title="Đặt lại ảnh ban đầu">⏹️ Reset</button>
                <div class="his-tool-divider"></div>
                <label class="his-tool-label">WW/WL Preset:</label>
                <select id="his-dicom-preset-select" class="his-tool-select">
                  <option value="default">Mặc định</option>
                  <option value="lung">Nhu mô Phổi (W:1500, L:-500)</option>
                  <option value="bone">Xương / Khớp (W:2000, L:300)</option>
                  <option value="brain">Sọ não / Nhu mô (W:80, L:40)</option>
                  <option value="soft">Mô mềm (W:400, L:50)</option>
                </select>
              </div>

              <!-- Canvas vẽ ảnh DICOM -->
              <div class="his-canvas-container" id="his-canvas-container">
                <canvas id="his-dicom-canvas" width="600" height="600"></canvas>
                
                <!-- HUD Overlay trên ảnh -->
                <div class="his-canvas-hud top-left">
                  <div>Bệnh viện: BV Đa khoa Tỉnh Gia Lai</div>
                  <div>Tên BN: ${study.patientName || 'Bệnh nhân'}</div>
                  <div>ID: ${study.patientCode || '123456'}</div>
                </div>
                <div class="his-canvas-hud top-right">
                  <div>Dịch vụ: ${study.serviceCode || 'CĐHA'}</div>
                  <div>kVp: 120 | mA: 200</div>
                  <div>Thickness: 2.5mm</div>
                </div>
                <div class="his-canvas-hud bottom-left">
                  <div id="his-hud-zoom">Zoom: 100%</div>
                  <div id="his-hud-wwwl">W: ${this.windowWidth} | L: ${this.windowLevel}</div>
                </div>
                <div class="his-canvas-hud bottom-right">
                  <div id="his-hud-slice">Lát cắt: 1 / 8</div>
                  <div>VNPT PACS DICOM 3.0</div>
                </div>
              </div>

              <!-- Thanh trượt slice -->
              <div class="his-slice-slider-container">
                <button id="his-slice-prev" class="his-slice-btn">◀ Prev</button>
                <input type="range" id="his-slice-range" min="0" max="7" value="0" step="1">
                <button id="his-slice-next" class="his-slice-btn">Next ▶</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
    this.bindEvents();
    this.renderThumbnails();
    this.renderCanvas();
  },

  /**
   * Đăng ký sự kiện tương tác trên Modal DICOM
   */
  bindEvents() {
    const overlay = document.getElementById('his-dicom-modal-overlay');
    const closeBtn = document.getElementById('his-dicom-close-btn');
    const canvas = document.getElementById('his-dicom-canvas');
    const container = document.getElementById('his-canvas-container');
    const sliceRange = document.getElementById('his-slice-range');

    // Đóng Modal
    closeBtn.onclick = () => overlay.remove();
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };

    // ESC Key để đóng
    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', keyHandler);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        this.changeSlice(this.currentSlice - 1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        this.changeSlice(this.currentSlice + 1);
      }
    };
    document.addEventListener('keydown', keyHandler);

    // Mở trang PACS ngoài
    document.getElementById('his-pacs-external-btn').onclick = () => {
      const dUrl = this.activeStudy && this.activeStudy.dicomUrl;
      const isValidUrl = dUrl && dUrl.startsWith('http');
      const url = isValidUrl ? dUrl : `https://bvgialai.vncare.vn/pacs/viewer?patientId=${(this.activeStudy && this.activeStudy.patientCode) || 'BA2607180160'}`;
      window.open(url, '_blank');
    };

    // Zoom & Pan & Rotate buttons
    document.getElementById('his-tool-zoom-in').onclick = () => {
      this.zoomLevel = Math.min(this.zoomLevel + 0.25, 4);
      this.updateCanvas();
    };
    document.getElementById('his-tool-zoom-out').onclick = () => {
      this.zoomLevel = Math.max(this.zoomLevel - 0.25, 0.5);
      this.updateCanvas();
    };
    document.getElementById('his-tool-rotate').onclick = () => {
      this.rotation = (this.rotation + 90) % 360;
      this.updateCanvas();
    };
    document.getElementById('his-tool-invert').onclick = () => {
      this.inverted = !this.inverted;
      this.updateCanvas();
    };
    document.getElementById('his-tool-reset').onclick = () => {
      this.zoomLevel = 1;
      this.panX = 0;
      this.panY = 0;
      this.rotation = 0;
      this.inverted = false;
      this.updateCanvas();
    };

    // Preset select
    document.getElementById('his-dicom-preset-select').onchange = (e) => {
      const preset = e.target.value;
      if (preset === 'lung') { this.windowWidth = 1500; this.windowLevel = -500; }
      else if (preset === 'bone') { this.windowWidth = 2000; this.windowLevel = 300; }
      else if (preset === 'brain') { this.windowWidth = 80; this.windowLevel = 40; }
      else if (preset === 'soft') { this.windowWidth = 400; this.windowLevel = 50; }
      else { this.windowWidth = 256; this.windowLevel = 128; }
      this.updateCanvas();
    };

    // Slice navigation
    sliceRange.oninput = (e) => {
      this.changeSlice(parseInt(e.target.value, 10));
    };
    document.getElementById('his-slice-prev').onclick = () => this.changeSlice(this.currentSlice - 1);
    document.getElementById('his-slice-next').onclick = () => this.changeSlice(this.currentSlice + 1);

    // Canvas Mouse Drag (Pan) & Wheel (Zoom / Slice change)
    container.onwheel = (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        // Zoom
        this.zoomLevel = Math.max(0.5, Math.min(4, this.zoomLevel + (e.deltaY < 0 ? 0.1 : -0.1)));
        this.updateCanvas();
      } else {
        // Change slice
        this.changeSlice(this.currentSlice + (e.deltaY > 0 ? 1 : -1));
      }
    };

    container.onmousedown = (e) => {
      this.isDragging = true;
      this.startX = e.clientX - this.panX;
      this.startY = e.clientY - this.panY;
      container.style.cursor = 'grabbing';
    };

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.panX = e.clientX - this.startX;
      this.panY = e.clientY - this.startY;
      this.updateCanvas();
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      if (container) container.style.cursor = 'grab';
    });
  },

  /**
   * Thay đổi lát cắt hiện tại
   */
  changeSlice(index) {
    const totalSlices = (this.activeStudy && this.activeStudy.slices && this.activeStudy.slices.length) || 8;
    if (index < 0) index = 0;
    if (index >= totalSlices) index = totalSlices - 1;
    this.currentSlice = index;

    const sliceRange = document.getElementById('his-slice-range');
    if (sliceRange) sliceRange.value = index;

    document.querySelectorAll('.his-slice-thumb').forEach((thumb, idx) => {
      if (idx === index) thumb.classList.add('active');
      else thumb.classList.remove('active');
    });

    this.renderCanvas();
  },

  /**
   * Tạo danh sách thumbnail lát cắt
   */
  renderThumbnails() {
    const list = document.getElementById('his-slice-thumbnails');
    if (!list) return;
    const totalSlices = (this.activeStudy && this.activeStudy.slices && this.activeStudy.slices.length) || 8;

    let html = '';
    for (let i = 0; i < totalSlices; i++) {
      html += `
        <div class="his-slice-thumb ${i === 0 ? 'active' : ''}" data-index="${i}">
          <div class="his-slice-num">#${i + 1}</div>
          <div class="his-slice-preview" style="background-color: #111827;">
            <svg width="40" height="40" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="${30 + (i % 3) * 5}" fill="none" stroke="${i % 2 === 0 ? '#38bdf8' : '#818cf8'}" stroke-width="4" opacity="0.7"/>
              <path d="M 20 ${40 + i * 2} Q 50 ${10 + i * 3} 80 ${40 + i * 2}" fill="none" stroke="#f43f5e" stroke-width="3"/>
            </svg>
          </div>
        </div>
      `;
    }
    list.innerHTML = html;

    const sliceRange = document.getElementById('his-slice-range');
    if (sliceRange) sliceRange.max = totalSlices - 1;

    list.querySelectorAll('.his-slice-thumb').forEach((thumb) => {
      thumb.onclick = () => {
        const idx = parseInt(thumb.getAttribute('data-index'), 10);
        this.changeSlice(idx);
      };
    });
  },

  /**
   * Vẽ lại Canvas mô phỏng DICOM sinh động (X-ray, CT, Ultrasound)
   */
  renderCanvas() {
    const canvas = document.getElementById('his-dicom-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Reset transform
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#050811';
    ctx.fillRect(0, 0, w, h);

    // Áp dụng Pan, Zoom, Rotate
    ctx.translate(w / 2 + this.panX, h / 2 + this.panY);
    ctx.rotate((this.rotation * Math.PI) / 180);
    ctx.scale(this.zoomLevel, this.zoomLevel);
    ctx.translate(-w / 2, -h / 2);

    // Kiểm tra loại dịch vụ để vẽ hình minh họa y tế chân thực
    const serviceName = (this.activeStudy && this.activeStudy.serviceName) || '';

    if (serviceName.toLowerCase().includes('x-quang') || serviceName.toLowerCase().includes('xquang')) {
      this.drawChestXRay(ctx, w, h);
    } else if (serviceName.toLowerCase().includes('ct') || serviceName.toLowerCase().includes('cắt lớp')) {
      this.drawBrainCT(ctx, w, h, this.currentSlice);
    } else {
      this.drawGeneralUltrasound(ctx, w, h, this.currentSlice);
    }

    // Đảo màu âm bản nếu được chọn
    if (this.inverted) {
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];       // Red
        data[i + 1] = 255 - data[i + 1]; // Green
        data[i + 2] = 255 - data[i + 2]; // Blue
      }
      ctx.putImageData(imgData, 0, 0);
    }

    this.updateHUD();
  },

  updateCanvas() {
    this.renderCanvas();
  },

  updateHUD() {
    const hudZoom = document.getElementById('his-hud-zoom');
    const hudWWWL = document.getElementById('his-hud-wwwl');
    const hudSlice = document.getElementById('his-hud-slice');
    const totalSlices = (this.activeStudy && this.activeStudy.slices && this.activeStudy.slices.length) || 8;

    if (hudZoom) hudZoom.textContent = `Zoom: ${Math.round(this.zoomLevel * 100)}%`;
    if (hudWWWL) hudWWWL.textContent = `W: ${this.windowWidth} | L: ${this.windowLevel}`;
    if (hudSlice) hudSlice.textContent = `Lát cắt: ${this.currentSlice + 1} / ${totalSlices}`;
  },

  // --- HÀM VẼ ẢNH MÔ PHỎNG X-QUANG NGỰC ---
  drawChestXRay(ctx, w, h) {
    const center = w / 2;

    // Nền lồng ngực
    const chestGrad = ctx.createRadialGradient(center, h / 2, 50, center, h / 2, 220);
    chestGrad.addColorStop(0, 'rgba(40, 45, 60, 0.9)');
    chestGrad.addColorStop(0.7, 'rgba(15, 20, 30, 0.95)');
    chestGrad.addColorStop(1, '#000000');
    ctx.fillStyle = chestGrad;
    ctx.beginPath();
    ctx.ellipse(center, h / 2, 180, 220, 0, 0, Math.PI * 2);
    ctx.fill();

    // Cột sống & Xương sườn (Màu xám sáng DICOM)
    ctx.strokeStyle = 'rgba(220, 225, 235, 0.7)';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(center, 80);
    ctx.lineTo(center, 520);
    ctx.stroke();

    // Xương sườn trái & phải
    ctx.lineWidth = 6;
    for (let i = 0; i < 9; i++) {
      const y = 140 + i * 40;
      // Bên trái
      ctx.beginPath();
      ctx.bezierCurveTo(center, y, center - 120, y - 10, center - 160, y + 30);
      ctx.stroke();
      // Bên phải
      ctx.beginPath();
      ctx.bezierCurveTo(center, y, center + 120, y - 10, center + 160, y + 30);
      ctx.stroke();
    }

    // Xương đòn (Clavicles)
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(center - 10, 110);
    ctx.bezierCurveTo(center - 80, 95, center - 140, 100, center - 170, 120);
    ctx.moveTo(center + 10, 110);
    ctx.bezierCurveTo(center + 80, 95, center + 140, 100, center + 170, 120);
    ctx.stroke();

    // Bóng tim (Heart Silhouette)
    ctx.fillStyle = 'rgba(180, 190, 205, 0.55)';
    ctx.beginPath();
    ctx.ellipse(center + 35, 340, 75, 95, Math.PI / 6, 0, Math.PI * 2);
    ctx.fill();

    // Cơ hoành (Diaphragm)
    ctx.fillStyle = 'rgba(200, 210, 225, 0.65)';
    ctx.beginPath();
    ctx.arc(center - 90, 480, 110, Math.PI, Math.PI * 1.85);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(center + 90, 490, 110, Math.PI * 1.15, Math.PI * 2);
    ctx.fill();

    // Tổn thương / Đám mờ nếu có
    ctx.fillStyle = 'rgba(245, 245, 250, 0.4)';
    ctx.beginPath();
    ctx.arc(center - 80, 260, 28, 0, Math.PI * 2);
    ctx.fill();
  },

  // --- HÀM VẼ ẢNH MÔ PHỎNG CT SỌ NÃO ---
  drawBrainCT(ctx, w, h, slice) {
    const center = w / 2;
    const r = 200 - slice * 2;

    // Hộp sọ (Skull bone - Trắng sáng trên CT)
    ctx.strokeStyle = 'rgba(240, 245, 255, 0.95)';
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.ellipse(center, h / 2, r, r * 1.2, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Nhu mô não (Brain Tissue)
    const brainGrad = ctx.createRadialGradient(center, h / 2, 20, center, h / 2, r - 10);
    brainGrad.addColorStop(0, 'rgba(70, 75, 85, 0.9)');
    brainGrad.addColorStop(1, 'rgba(40, 45, 55, 0.9)');
    ctx.fillStyle = brainGrad;
    ctx.fill();

    // Rãnh cuộn não & Não thất (Ventricles)
    ctx.fillStyle = 'rgba(15, 20, 30, 0.9)'; // Dịch não tủy màu tối trên CT
    ctx.beginPath();
    ctx.ellipse(center - 30, h / 2 - 10, 20 + slice * 2, 45, -Math.PI / 12, 0, Math.PI * 2);
    ctx.ellipse(center + 30, h / 2 - 10, 20 + slice * 2, 45, Math.PI / 12, 0, Math.PI * 2);
    ctx.fill();

    // Đường giữa (Midline falx)
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(center, h / 2 - r + 15);
    ctx.lineTo(center, h / 2 + r - 15);
    ctx.stroke();
  },

  // --- HÀM VẼ ẢNH MÔ PHỎNG SIÊU ÂM O BỤNG ---
  drawGeneralUltrasound(ctx, w, h, slice) {
    const center = w / 2;

    // Quạt siêu âm (Ultrasound sector beam)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(center, 60);
    ctx.arc(center, 60, 480, (Math.PI * 0.3), (Math.PI * 0.7));
    ctx.closePath();
    ctx.clip();

    // Nhiễu hạt siêu âm (Speckle noise pattern)
    for (let i = 0; i < 600; i++) {
      const x = center + (Math.random() - 0.5) * 450;
      const y = 80 + Math.random() * 420;
      const alpha = Math.random() * 0.35;
      ctx.fillStyle = `rgba(200, 220, 240, ${alpha})`;
      ctx.fillRect(x, y, 2 + Math.random() * 4, 2 + Math.random() * 4);
    }

    // Cơ quan / Nhu mô gan / Thận trong siêu âm
    ctx.fillStyle = 'rgba(90, 105, 120, 0.4)';
    ctx.beginPath();
    ctx.ellipse(center + 40, 240 + slice * 5, 110, 80, Math.PI / 5, 0, Math.PI * 2);
    ctx.fill();

    // Nang / Sỏi phản âm trống/dày
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(center + 60, 230 + slice * 4, 12, 0, Math.PI * 2);
    ctx.fill();

    // Bóng lưng phía sau sỏi (Acoustic Shadowing)
    ctx.fillStyle = 'rgba(5, 10, 15, 0.85)';
    ctx.fillRect(center + 48, 242 + slice * 4, 24, 200);

    ctx.restore();
  }
};
