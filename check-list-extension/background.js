// 标签页域名变化时清除对应域名的会话数据
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    try {
      const newOrigin = new URL(changeInfo.url).origin;
      // 检查 storage 中是否有旧域名的会话需要清理
      // 由于我们按 origin 存储，导航到新域名时旧数据自然保留在旧 key 下
      // 只需检查是否当前标签页之前保存了不同域名的数据
      chrome.storage.local.get(null, (allData) => {
        for (const [key, value] of Object.entries(allData)) {
          if (key.startsWith('checkState_') && value.origin && value.origin !== newOrigin) {
            // 不同域名，不做清理（其他标签页可能还在用）
          }
        }
      });
    } catch (e) { /* ignore invalid url */ }
  }
});
