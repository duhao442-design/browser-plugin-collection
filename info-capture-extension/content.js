(function () {
  'use strict';

  // 供 popup 调用：捕获四个关键信息（题目ID、队列名称、题目链接、alloc镜像image）
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'CAPTURE_INFO') {
      captureInfo().then((data) => sendResponse({ ok: true, data }));
      return true; // 异步响应，保持通道打开
    }
  });

  async function captureInfo() {
    const questionId = captureQuestionId();
    const queueName = captureQueueName();
    const link = await captureLink();
    const allocImages = captureAllocImages();
    return { questionId, queueName, link, allocImages };
  }

  /**
   * 捕获题目ID
   * 规则：找到文本为【题目 ID：】的 span 元素，其父元素下的另一个 span 的文本值即为题目ID
   */
  function captureQuestionId() {
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
      const text = (span.textContent || '').trim();
      // 匹配“题目 ID：”/“题目ID：”之类的标签 span
      if (/题目\s*ID/.test(text)) {
        // 兜底1：标签本身可能携带值，如 【题目 ID：123456】
        const inline = text.match(/题目\s*ID\s*[:：]\s*([^\s】]+)/);
        if (inline) return inline[1];

        // 主要逻辑：取父元素下的另一个 span 的值
        const parent = span.parentElement;
        if (parent) {
          const children = Array.from(parent.children).filter(
            (child) => child.tagName === 'SPAN'
          );
          for (const sib of children) {
            const sibText = (sib.textContent || '').trim();
            if (sib !== span && sibText && !/题目\s*ID/.test(sibText)) {
              return sibText;
            }
          }
          // 兜底2：父元素内任意非标签文本（如文本节点无法直接取，则取兄弟节点首个子元素）
          const anyText = (parent.textContent || '').replace(text, '').trim();
          if (anyText) return anyText;
        }
      }
    }
    return '';
  }

  /**
   * 捕获队列名称
   * 规则：取 task-title-_xrdxI 类元素文本值的前两到三位，一般形如 LF / BAZ / BCA
   * （类名后缀可能随版本变化，因此用前缀匹配）
   */
  function captureQueueName() {
    // 优先精确前缀匹配，其次包含匹配
    const el =
      document.querySelector('[class^="task-title-"]') ||
      document.querySelector('[class*="task-title-"]');
    if (!el) return '';
    const text = (el.textContent || '').trim();
    // 前两到三位：优先取开头的英文字母段（LF、BAZ、BCA 均符合），否则截取前3个字符
    const m = text.match(/^[A-Za-z]{2,3}/);
    return m ? m[0] : text.slice(0, 3);
  }

  /**
   * 捕获题目链接
   * 规则：找到 force-icon-link 类型的 svg（点击该图标会自动复制链接）
   * 优先从元素自身/祖先的 href、title、data-link 等属性读取；缺失时模拟点击并读取剪贴板
   */
  async function captureLink() {
    const iconEl =
      document.querySelector('svg[class*="force-icon-link"]') ||
      document.querySelector('[class*="force-icon-link"] svg') ||
      document.querySelector('[class*="force-icon-link"]');
    if (!iconEl) return '';

    // 方式1：从元素自身及祖先查找链接属性
    const direct = findLinkFromElement(iconEl);
    if (direct) return direct;

    // 方式2：模拟点击图标（站点点击时自动复制到剪贴板），再读取剪贴板
    try {
      const clickTarget =
        iconEl.closest('[class*="force-icon-link"]') || iconEl;
      ['mousedown', 'mouseup', 'click'].forEach((type) => {
        clickTarget.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
        );
      });
      await new Promise((r) => setTimeout(r, 300));
      const text = await navigator.clipboard.readText();
      if (text && /^https?:\/\//.test(text.trim())) {
        return text.trim();
      }
    } catch (e) {
      // 剪贴板读取失败则返回空
    }
    return '';
  }

  // 向上最多查找5层，依次检查 href / title / data-link / data-url 属性
  function findLinkFromElement(el) {
    let node = el;
    for (let i = 0; node && i < 5; i++) {
      if (node.getAttribute) {
        for (const attr of ['href', 'title', 'data-link', 'data-url']) {
          const val = (node.getAttribute(attr) || '').trim();
          if (val && /^https?:\/\//.test(val)) return val;
        }
      }
      node = node.parentElement;
    }
    return '';
  }

  /**
   * 捕获 alloc 镜像 image（可能有多条）
   * 规则：找到 class 以 sandbox-render-error- 开头的 div，其文本中形如
   * image='hub.byted.org/sprouty_envs/...' 的 image 值；每个 div 提取一条
   */
  function captureAllocImages() {
    const images = [];
    const divs = document.querySelectorAll(
      'div[class^="sandbox-render-error-"], div[class*="sandbox-render-error-"]'
    );
    for (const div of divs) {
      const text = (div.textContent || '').trim();
      const m = text.match(/image\s*=\s*'([^']+)'/);
      if (m) images.push(m[1]);
    }
    // 兜底：上述 div 未命中时，全页扫描包含 alloc runtime failed 的文本
    if (images.length === 0 && document.body) {
      const allText = document.body.innerText || '';
      const m = allText.match(/image\s*=\s*'([^']+)'/);
      if (m) images.push(m[1]);
    }
    return images;
  }
})();
