document.addEventListener('DOMContentLoaded', () => {
  const chkEnable = document.getElementById('chk-enable-extension');
  const btnOpenHis = document.getElementById('btn-open-his');

  // Đọc cài đặt đã lưu
  if (chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.remove('isDemoMode');
    chrome.storage.sync.get(['isEnabled'], (res) => {
      if (res.isEnabled !== undefined) chkEnable.checked = res.isEnabled;
    });
  }

  // Lưu khi thay đổi
  chkEnable.addEventListener('change', () => {
    saveSetting('isEnabled', chkEnable.checked);
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
