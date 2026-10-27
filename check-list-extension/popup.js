// 检查当前页面是否有未完成的会话
(async function initPopup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch (e) { return; }

  const stateKey = `checkState_${origin}`;

  try {
    const result = await chrome.storage.local.get(stateKey);
    const saved = result[stateKey];

    if (saved && saved.checkItems && saved.checkItems.length > 0) {
      const resumeBox = document.getElementById('resumeBox');
      const resumeInfo = document.getElementById('resumeInfo');
      const total = saved.checkItems.length;
      const done = saved.checkItems.filter(i => i.status !== null).length;
      const current = saved.currentIndex || 0;
      resumeInfo.textContent = `域名：${origin}，共 ${total} 条，已完成 ${done} 条，当前第 ${current + 1} 条`;
      resumeBox.style.display = 'block';
    }
  } catch (e) { /* ignore */ }

  // 继续做题
  document.getElementById('resumeBtn').addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'RESUME_CHECK' });
    } catch (e) {
      // content script 未注入，手动注入
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await new Promise(r => setTimeout(r, 200));
        await chrome.tabs.sendMessage(tab.id, { type: 'RESUME_CHECK' });
      } catch (e2) {
        alert('无法在当前页面运行');
        return;
      }
    }
    window.close();
  });

  // 放弃并重新开始
  document.getElementById('discardBtn').addEventListener('click', async () => {
    await chrome.storage.local.remove(stateKey);
    // 通知 content script 关闭面板
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'DISCARD_CHECK' });
    } catch (e) { /* ignore */ }
    document.getElementById('resumeBox').style.display = 'none';
  });
})();

// 开始新的检查
document.getElementById('startBtn').addEventListener('click', async () => {
  const rawText = document.getElementById('inputText').value.trim();
  if (!rawText) {
    alert('请先输入列表数据');
    return;
  }

  const items = rawText.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);

  if (items.length === 0) {
    alert('未解析到有效条目');
    return;
  }

  const modeEl = document.querySelector('input[name="checkMode"]:checked');
  const checkMode = modeEl ? modeEl.value : 'single';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 清除旧会话
  let origin;
  try {
    origin = new URL(tab.url).origin;
    await chrome.storage.local.remove(`checkState_${origin}`);
  } catch (e) { /* ignore */ }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'START_CHECK',
      items: items,
      mode: checkMode
    });
  } catch (e) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 200));
      await chrome.tabs.sendMessage(tab.id, {
        type: 'START_CHECK',
        items: items,
        mode: checkMode
      });
    } catch (e2) {
      alert('无法在当前页面运行，请确保不是 chrome:// 等特殊页面');
      return;
    }
  }

  window.close();
});
