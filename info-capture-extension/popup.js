// 关键信息捕获扩展 - popup 逻辑
// 按域名保存/恢复上次捕获结果，保证同域刷新或重开弹窗不丢失

const KEY_PREFIX = 'captureState_';

function originKey(origin) {
  return KEY_PREFIX + origin;
}

let currentOrigin = '';

function $(id) {
  return document.getElementById(id);
}

function collect() {
  return {
    questionId: $('fieldId').value.trim(),
    queueName: $('fieldQueue').value.trim(),
    link: $('fieldLink').value.trim(),
    // 镜像可能有多条：按行拆分，忽略空行
    allocImages: $('fieldImage').value.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 0)
  };
}

function fillFields(data) {
  $('fieldId').value = (data.questionId || '').trim();
  $('fieldQueue').value = (data.queueName || '').trim();
  $('fieldLink').value = (data.link || '').trim();
  // 兼容旧数据：allocImage 为单条字符串，allocImages 为数组
  let images = data.allocImages;
  if (typeof images === 'string') {
    images = images ? [images] : [];
  }
  $('fieldImage').value = (images || []).join('\n');
  updateResult();
}

// 合并结果：每条镜像生成一行数据，前三个字段保持不变，以制表符分隔
// 无镜像时保留一行且第4列留空，保证列对齐
function updateResult() {
  const d = collect();
  const prefix = [d.questionId, d.queueName, d.link];
  const rows = d.allocImages.length > 0
    ? d.allocImages.map((img) => prefix.concat(img).join('\t'))
    : [prefix.concat('').join('\t')];
  $('resultText').value = rows.join('\n');
}

async function saveState() {
  if (!currentOrigin) return;
  try {
    await chrome.storage.local.set({ [originKey(currentOrigin)]: collect() });
  } catch (e) { /* ignore */ }
}

// 在指定标签页中触发捕获；content script 未注入时手动注入后重试
async function captureInTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_INFO' });
  } catch (e) {
    // content script 未注入，走手动注入兜底
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 200));
    return await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_INFO' });
  } catch (e) {
    return null;
  }
}

// 初始化：恢复当前域名下上次捕获的结果
(async function initPopup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  try {
    currentOrigin = new URL(tab.url).origin;
  } catch (e) { return; }

  try {
    const result = await chrome.storage.local.get(originKey(currentOrigin));
    const saved = result[originKey(currentOrigin)];
    if (saved) fillFields(saved);
  } catch (e) { /* ignore */ }
  updateResult();
})();

// 四个字段手动修改时，同步合并结果并保存
['fieldId', 'fieldQueue', 'fieldLink', 'fieldImage'].forEach((id) => {
  $(id).addEventListener('input', () => {
    updateResult();
    saveState();
  });
});

// 捕获按钮：从当前页面抓取四个关键信息
$('captureBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    alert('无法获取当前页面');
    return;
  }

  const resp = await captureInTab(tab.id);
  if (resp && resp.ok && resp.data) {
    fillFields(resp.data);
    saveState();
  } else {
    alert('未能捕获到关键信息，请检查页面结构，或手动填写各字段');
  }
});

// 复制按钮：复制制表符分隔的合并结果
$('copyBtn').addEventListener('click', async () => {
  const text = $('resultText').value;
  const btn = $('copyBtn');
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 剪贴板 API 不可用时降级为 execCommand
    $('resultText').select();
    document.execCommand('copy');
  }
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = '复制结果'; }, 1500);
});
