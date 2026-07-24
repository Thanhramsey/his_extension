document.addEventListener('DOMContentLoaded', () => {
  const chkEnable = document.getElementById('chk-enable-extension');
  const chkDemo = document.getElementById('chk-demo-mode');
  const chkAbnormal = document.getElementById('chk-only-abnormal');
  const btnOpenHis = document.getElementById('btn-open-his');

  // Đọc cài đặt đã lưu
  if (chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(['isEnabled', 'isDemoMode', 'showOnlyAbnormal'], (res) => {
      if (res.isEnabled !== undefined) chkEnable.checked = res.isEnabled;
      if (res.isDemoMode !== undefined) chkDemo.checked = res.isDemoMode;
      if (res.showOnlyAbnormal !== undefined) chkAbnormal.checked = res.showOnlyAbnormal;
    });
  }

  // Lưu khi thay đổi
  chkEnable.addEventListener('change', () => {
    saveSetting('isEnabled', chkEnable.checked);
  });

  chkDemo.addEventListener('change', () => {
    saveSetting('isDemoMode', chkDemo.checked);
  });

  chkAbnormal.addEventListener('change', () => {
    saveSetting('showOnlyAbnormal', chkAbnormal.checked);
  });

  btnOpenHis.addEventListener('click', () => {
    chrome.tabs.create({
      url: 'https://bvgialai.vncare.vn/vnpthis/main/manager.jsp?func=../noitru/NTU02D021_BuongDieuTri&loaitiepnhan=0'
    });
  });

  function saveSetting(key, val) {
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ [key]: val });
    }
  }
});
