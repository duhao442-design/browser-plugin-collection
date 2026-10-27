(function () {
  const CONTAINER_ID = 'check-list-checker-container';

  let checkItems = [];
  let currentIndex = 0;
  let portNumber = '';
  let checkMode = 'single';
  let panelPos = null; // 弹窗拖动后的位置 { left, top }，用于页面刷新后恢复
  const currentOrigin = location.origin;

  function stateKey() {
    return `checkState_${currentOrigin}`;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_CHECK') {
      startCheck(msg.items, msg.mode || 'single');
    } else if (msg.type === 'RESUME_CHECK') {
      resumeCheck();
    } else if (msg.type === 'DISCARD_CHECK') {
      discardCheck();
    } else if (msg.type === 'GET_STATE') {
      // 让 popup 查询当前页面是否有活跃的面板（同步响应即可）
      const container = document.getElementById(CONTAINER_ID);
      sendResponse({ hasPanel: !!container, currentIndex, total: checkItems.length });
    }
    // 其余消息均为单向通知：不返回 true，否则消息通道挂起，
    // popup 端 await sendMessage 将永不返回，导致按钮点击无反应
  });

  init();

  async function init() {
    // 尝试从 storage 恢复状态
    try {
      const result = await chrome.storage.local.get(stateKey());
      const saved = result[stateKey()];
      if (saved && saved.checkItems && saved.checkItems.length > 0) {
        checkItems = saved.checkItems;
        currentIndex = saved.currentIndex || 0;
        portNumber = saved.portNumber || '';
        checkMode = saved.checkMode || 'single';
        panelPos = saved.panelPos || null;
        renderPanel();
      }
    } catch (e) { /* ignore */ }
  }

  async function saveState() {
    try {
      await chrome.storage.local.set({
        [stateKey()]: { checkItems, currentIndex, portNumber, checkMode, panelPos, origin: currentOrigin }
      });
    } catch (e) { /* ignore */ }
  }

  async function clearState() {
    try {
      await chrome.storage.local.remove(stateKey());
    } catch (e) { /* ignore */ }
  }

  // 拖动：按住顶栏任意位置移动面板（按钮除外）；默认居中，拖动后转为自由浮窗
  function initDrag(container) {
    container.addEventListener('mousedown', (e) => {
      const bar = e.target.closest('.cl-bar');
      if (!bar) return;
      if (e.target.closest('button')) return; // 点击按钮不触发拖动
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = container.getBoundingClientRect().left;
      const startTop = container.getBoundingClientRect().top;

      function onMove(ev) {
        container.style.transform = 'none'; // 取消居中的 transform，改为绝对定位
        const left = startLeft + (ev.clientX - startX);
        const top = startTop + (ev.clientY - startY);
        container.style.left = Math.max(0, left) + 'px';
        container.style.top = Math.max(0, top) + 'px';
        container.style.right = 'auto';
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // 记录拖动后的位置并持久化，刷新后恢复；原地点击未移动时不保存
        const left = parseFloat(container.style.left);
        const top = parseFloat(container.style.top);
        if (Number.isFinite(left) && Number.isFinite(top)) {
          panelPos = { left, top };
          saveState();
        }
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // 隐藏面板：折叠为一个小恢复按钮，位置保持原面板左上角
  function hidePanel() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container || container.style.display === 'none') return;
    const rect = container.getBoundingClientRect();

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'cl-restore-btn';
    restoreBtn.textContent = '检查面板';
    restoreBtn.style.top = Math.max(0, rect.top) + 'px';
    restoreBtn.style.left = Math.max(0, rect.left) + 'px';
    restoreBtn.addEventListener('click', () => {
      container.style.display = '';
      restoreBtn.remove();
    });

    document.body.appendChild(restoreBtn);
    container.style.display = 'none';
  }

  // 在顶栏关闭按钮旁插入隐藏按钮
  function addHideButton(container) {
    if (container.querySelector('.cl-hide-btn')) return;
    const closeBtn = container.querySelector('.cl-close-btn');
    if (!closeBtn) return;

    const hideBtn = document.createElement('button');
    hideBtn.className = 'cl-hide-btn';
    hideBtn.title = '隐藏';
    hideBtn.textContent = '—';
    hideBtn.addEventListener('click', hidePanel);
    closeBtn.parentNode.insertBefore(hideBtn, closeBtn);
  }

  function startCheck(items, mode) {
    const existing = document.getElementById(CONTAINER_ID);
    if (existing) existing.remove();

    checkItems = items.map((text, i) => ({
      index: i + 1,
      text: text,
      status: null,
      reason: ''
    }));
    currentIndex = 0;
    portNumber = '';
    checkMode = mode || 'single';

    renderPanel();
    showPortInput(document.getElementById(CONTAINER_ID));
    saveState();
  }

  async function resumeCheck() {
    const existing = document.getElementById(CONTAINER_ID);
    if (!existing) {
      try {
        const result = await chrome.storage.local.get(stateKey());
        const saved = result[stateKey()];
        if (saved && saved.checkItems && saved.checkItems.length > 0) {
          checkItems = saved.checkItems;
          currentIndex = saved.currentIndex || 0;
          panelPos = saved.panelPos || null;
          renderPanel();
        }
      } catch (e) { /* ignore */ }
    }
  }

  function discardCheck() {
    const existing = document.getElementById(CONTAINER_ID);
    if (existing) {
      existing.remove();
    }
    checkItems = [];
    currentIndex = 0;
  }

  function renderPanel() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      document.body.appendChild(container);
      initDrag(container);
      applyPanelPos(container); // 恢复上次拖动后的位置
    }

    showCurrentItem();
  }

  // 若保存了拖动后的位置，则取消默认居中，恢复到该位置
  function applyPanelPos(container) {
    if (!panelPos || typeof panelPos.left !== 'number' || typeof panelPos.top !== 'number') return;
    container.style.transform = 'none';
    container.style.left = panelPos.left + 'px';
    container.style.top = panelPos.top + 'px';
    container.style.right = 'auto';
  }

  function cleanupKeyHandler(container) {
    if (container._keyHandler) {
      document.removeEventListener('keydown', container._keyHandler);
      container._keyHandler = null;
    }
  }

  function showCurrentItem() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    cleanupKeyHandler(container);

    if (currentIndex >= checkItems.length) {
      if (checkMode === 'left') {
        showResult(container);
      } else {
        showAestheticsRating(container);
      }
      return;
    }

    const item = checkItems[currentIndex];
    container.innerHTML = '';

    // 顶栏
    const bar = document.createElement('div');
    bar.className = 'cl-bar';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'cl-bar-left';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'cl-nav-btn';
    prevBtn.innerHTML = '&lsaquo;';
    prevBtn.title = '上一条';
    if (currentIndex === 0) prevBtn.disabled = true;
    prevBtn.addEventListener('click', () => {
      if (currentIndex > 0) {
        currentIndex--;
        showCurrentItem();
      }
    });

    const progress = document.createElement('span');
    progress.className = 'cl-progress';
    progress.textContent = `${currentIndex + 1} / ${checkItems.length}`;

    const navBtn = document.createElement('button');
    navBtn.className = 'cl-nav-btn cl-nav-index-btn';
    navBtn.textContent = '#';
    navBtn.title = '跳转题号';
    navBtn.addEventListener('click', () => {
      showIndexPanel(container);
    });

    leftGroup.appendChild(prevBtn);
    leftGroup.appendChild(progress);
    leftGroup.appendChild(navBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cl-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', () => {
      container.remove();
      clearState();
    });

    bar.appendChild(leftGroup);
    bar.appendChild(closeBtn);
    container.appendChild(bar);
    addHideButton(container);

    // 当前条目
    const body = document.createElement('div');
    body.className = 'cl-body';

    const numBadge = document.createElement('span');
    numBadge.className = 'cl-num';
    numBadge.textContent = `#${item.index}`;

    const content = document.createElement('span');
    content.className = 'cl-content';
    content.textContent = item.text;

    body.appendChild(numBadge);
    body.appendChild(content);
    container.appendChild(body);

    // 如果已处理过，显示之前的选择
    if (item.status !== null) {
      const prevResult = document.createElement('div');
      prevResult.className = 'cl-prev-result';

      if (item.status === 'pass') {
        const tag = document.createElement('span');
        tag.className = 'cl-prev-pass';
        tag.textContent = '已通过';
        prevResult.appendChild(tag);
      } else {
        const tag = document.createElement('span');
        tag.className = 'cl-prev-fail';
        tag.textContent = '不通过';
        prevResult.appendChild(tag);
        const reasonSpan = document.createElement('span');
        reasonSpan.className = 'cl-prev-reason';
        reasonSpan.textContent = item.reason;
        prevResult.appendChild(reasonSpan);
      }
      container.appendChild(prevResult);
    }

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'cl-actions';

    const passBtn = document.createElement('button');
    passBtn.className = 'cl-btn cl-btn-pass';
    passBtn.textContent = '通过 (Y)';

    const failBtn = document.createElement('button');
    failBtn.className = 'cl-btn cl-btn-fail';
    failBtn.textContent = '不通过 (N)';

    passBtn.addEventListener('click', () => {
      item.status = 'pass';
      item.reason = '';
      currentIndex++;
      saveState();
      showCurrentItem();
    });

    failBtn.addEventListener('click', () => {
      showReasonInput(container, item, actions);
    });

    actions.appendChild(passBtn);
    actions.appendChild(failBtn);
    container.appendChild(actions);

    // 快捷键
    container._keyHandler = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (container.querySelector('.cl-reason-input-wrap')) return;
      if (container.querySelector('.cl-index-panel')) return;
      if (e.key === 'y' || e.key === 'Y') passBtn.click();
      if (e.key === 'n' || e.key === 'N') failBtn.click();
      if (e.key === 'ArrowLeft' || e.key === 'p' || e.key === 'P') prevBtn.click();
    };
    document.addEventListener('keydown', container._keyHandler);
  }

  function showReasonInput(container, item, actionsArea) {
    actionsArea.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = 'cl-reason-input-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cl-reason-input';
    input.placeholder = '请输入不通过理由，回车确认';
    input.setAttribute('autocomplete', 'off');
    if (item.status === 'fail' && item.reason) {
      input.value = item.reason;
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'cl-btn cl-btn-confirm';
    confirmBtn.textContent = '确认';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cl-btn cl-btn-cancel';
    cancelBtn.textContent = '取消';

    confirmBtn.addEventListener('click', () => {
      const reason = input.value.trim();
      if (!reason) {
        input.focus();
        input.style.borderColor = '#e74c3c';
        return;
      }
      item.status = 'fail';
      item.reason = reason;
      currentIndex++;
      saveState();
      showCurrentItem();
    });

    cancelBtn.addEventListener('click', () => {
      wrap.remove();
      actionsArea.style.display = 'flex';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmBtn.click();
      if (e.key === 'Escape') cancelBtn.click();
    });

    wrap.appendChild(input);
    wrap.appendChild(confirmBtn);
    wrap.appendChild(cancelBtn);
    container.appendChild(wrap);
    input.focus();
  }

  function showIndexPanel(container) {
    const existing = container.querySelector('.cl-index-panel');
    if (existing) { existing.remove(); return; }

    const panel = document.createElement('div');
    panel.className = 'cl-index-panel';

    checkItems.forEach((item) => {
      const dot = document.createElement('button');
      dot.className = 'cl-index-dot';
      dot.title = `#${item.index} ${item.text.substring(0, 20)}`;

      if (item.status === 'pass') {
        dot.classList.add('cl-dot-pass');
      } else if (item.status === 'fail') {
        dot.classList.add('cl-dot-fail');
      } else {
        dot.classList.add('cl-dot-pending');
      }

      if (currentIndex === item.index - 1) {
        dot.classList.add('cl-dot-current');
      }

      dot.textContent = item.index;
      dot.addEventListener('click', () => {
        currentIndex = item.index - 1;
        panel.remove();
        showCurrentItem();
      });

      panel.appendChild(dot);
    });

    container.appendChild(panel);
  }

  function showPortInput(container) {
    cleanupKeyHandler(container);
    container.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'cl-bar';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'cl-bar-left';

    const title = document.createElement('span');
    title.className = 'cl-progress';
    title.textContent = '端口号';

    leftGroup.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cl-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      container.remove();
      clearState();
    });

    bar.appendChild(leftGroup);
    bar.appendChild(closeBtn);
    container.appendChild(bar);
    addHideButton(container);

    const body = document.createElement('div');
    body.className = 'cl-body';
    body.innerHTML = '<span class="cl-content">请输入端口号</span>';
    container.appendChild(body);

    const wrap = document.createElement('div');
    wrap.className = 'cl-reason-input-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cl-reason-input';
    input.placeholder = '输入端口号，如：8080';
    input.setAttribute('autocomplete', 'off');
    if (portNumber && portNumber !== '__NONE__') input.value = portNumber;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'cl-btn cl-btn-confirm';
    confirmBtn.textContent = '确认';

    const noneBtn = document.createElement('button');
    noneBtn.className = 'cl-btn cl-btn-fail';
    noneBtn.textContent = '端口号不存在';

    confirmBtn.addEventListener('click', () => {
      const port = input.value.trim();
      if (!port) {
        input.focus();
        input.style.borderColor = '#e74c3c';
        return;
      }
      portNumber = port;
      saveState();
      showCurrentItem();
    });

    noneBtn.addEventListener('click', () => {
      portNumber = '__NONE__';
      saveState();
      showCurrentItem();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmBtn.click();
    });

    wrap.appendChild(input);
    wrap.appendChild(confirmBtn);
    wrap.appendChild(noneBtn);
    container.appendChild(wrap);
    if (portNumber && portNumber !== '__NONE__') input.focus();
  }

  function showAestheticsRating(container) {
    cleanupKeyHandler(container);
    container.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'cl-bar';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'cl-bar-left';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'cl-nav-btn';
    prevBtn.innerHTML = '&lsaquo;';
    prevBtn.title = '返回上一条';
    prevBtn.addEventListener('click', () => {
      currentIndex = checkItems.length - 1;
      showCurrentItem();
    });

    const title = document.createElement('span');
    title.className = 'cl-progress';
    title.textContent = checkMode === 'right' ? '美观度 GSB 原因' : '美观度评分原因';

    leftGroup.appendChild(prevBtn);
    leftGroup.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cl-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      container.remove();
      clearState();
    });

    bar.appendChild(leftGroup);
    bar.appendChild(closeBtn);
    container.appendChild(bar);
    addHideButton(container);

    const body = document.createElement('div');
    body.className = 'cl-body';
    body.innerHTML = '<span class="cl-content">' + (checkMode === 'right' ? '请输入美观度 GSB 原因' : '请输入美观度评分原因') + '</span>';
    container.appendChild(body);

    const wrap = document.createElement('div');
    wrap.className = 'cl-reason-input-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cl-reason-input';
    input.placeholder = checkMode === 'right' ? '输入美观度 GSB 原因' : '输入美观度评分原因，如：优、良、中、差';
    input.setAttribute('autocomplete', 'off');

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'cl-btn cl-btn-confirm';
    confirmBtn.textContent = '确认';

    confirmBtn.addEventListener('click', () => {
      const rating = input.value.trim();
      if (!rating) {
        input.focus();
        input.style.borderColor = '#e74c3c';
        return;
      }
      // right 模式：不再选择"是否出现特殊情况"，直接进入三项判断；single 模式保持原有选择流程
      if (checkMode === 'right') {
        showSpecialDetail(container, rating);
      } else {
        showSpecialSituation(container, rating);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmBtn.click();
    });

    wrap.appendChild(input);
    wrap.appendChild(confirmBtn);
    container.appendChild(wrap);
    input.focus();
  }

  function showSpecialSituation(container, rating) {
    cleanupKeyHandler(container);
    container.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'cl-bar';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'cl-bar-left';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'cl-nav-btn';
    prevBtn.innerHTML = '&lsaquo;';
    prevBtn.title = '返回修改';
    prevBtn.addEventListener('click', () => showAestheticsRating(container));

    const title = document.createElement('span');
    title.className = 'cl-progress';
    title.textContent = '特殊情况';

    leftGroup.appendChild(prevBtn);
    leftGroup.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cl-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      container.remove();
      clearState();
    });

    bar.appendChild(leftGroup);
    bar.appendChild(closeBtn);
    container.appendChild(bar);
    addHideButton(container);

    const body = document.createElement('div');
    body.className = 'cl-body';
    body.innerHTML = '<span class="cl-content">是否出现特殊情况？</span>';
    container.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'cl-actions';

    const noBtn = document.createElement('button');
    noBtn.className = 'cl-btn cl-btn-pass';
    noBtn.textContent = checkMode === 'right' ? '否' : '未出现';
    noBtn.addEventListener('click', () => {
      showResult(container, rating, { occurred: false });
    });

    const yesBtn = document.createElement('button');
    yesBtn.className = 'cl-btn cl-btn-fail';
    yesBtn.textContent = checkMode === 'right' ? '是' : '出现';
    yesBtn.addEventListener('click', () => {
      showSpecialDetail(container, rating);
    });

    actions.appendChild(noBtn);
    actions.appendChild(yesBtn);
    container.appendChild(actions);
  }

  function showSpecialDetail(container, rating) {
    cleanupKeyHandler(container);
    container.innerHTML = '';

    const fields = checkMode === 'right'
      ? [
          { key: 'cannotAll', label: '都无法标注' },
          { key: 'aestheticsSame', label: '美观度基本相同' },
          { key: 'funcSame', label: '功能性基本相同' }
        ]
      : [
          { key: 'cannot', label: '无法标注' }
        ];
    const choices = {};
    const groupEls = {};

    const bar = document.createElement('div');
    bar.className = 'cl-bar';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'cl-bar-left';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'cl-nav-btn';
    prevBtn.innerHTML = '&lsaquo;';
    prevBtn.title = '返回';
    prevBtn.addEventListener('click', () => {
      if (checkMode === 'right') {
        showAestheticsRating(container);
      } else {
        showSpecialSituation(container, rating);
      }
    });

    const title = document.createElement('span');
    title.className = 'cl-progress';
    title.textContent = '特殊情况';

    leftGroup.appendChild(prevBtn);
    leftGroup.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cl-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      container.remove();
      clearState();
    });

    bar.appendChild(leftGroup);
    bar.appendChild(closeBtn);
    container.appendChild(bar);
    addHideButton(container);

    fields.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'cl-special-field';

      const label = document.createElement('span');
      label.className = 'cl-special-label';
      label.textContent = f.label;

      const group = document.createElement('div');
      group.className = 'cl-choice-group';

      ['有', '无'].forEach((val) => {
        const btn = document.createElement('button');
        btn.className = 'cl-choice-btn';
        btn.textContent = val;
        btn.addEventListener('click', () => {
          choices[f.key] = val;
          group.querySelectorAll('.cl-choice-btn').forEach(b => b.classList.remove('cl-choice-active'));
          btn.classList.add('cl-choice-active');
        });
        group.appendChild(btn);
      });

      groupEls[f.key] = group;
      row.appendChild(label);
      row.appendChild(group);
      container.appendChild(row);
    });

    const reasonRow = document.createElement('div');
    reasonRow.className = 'cl-special-field';

    const reasonLabel = document.createElement('span');
    reasonLabel.className = 'cl-special-label';
    reasonLabel.textContent = '特殊情况原因';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cl-reason-input';
    input.placeholder = '请输入原因';
    input.setAttribute('autocomplete', 'off');

    reasonRow.appendChild(reasonLabel);
    reasonRow.appendChild(input);
    container.appendChild(reasonRow);

    const actions = document.createElement('div');
    actions.className = 'cl-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'cl-btn cl-btn-confirm';
    confirmBtn.textContent = '确认';

    confirmBtn.addEventListener('click', () => {
      let missing = false;
      fields.forEach((f) => {
        if (!choices[f.key]) {
          groupEls[f.key].style.outline = '1px solid #e74c3c';
          setTimeout(() => { groupEls[f.key].style.outline = ''; }, 1500);
          missing = true;
        }
      });
      if (missing) return;

      const reason = input.value.trim();
      const reasonOptional = checkMode === 'right';
      if (!reasonOptional && !reason) {
        input.focus();
        input.style.borderColor = '#e74c3c';
        return;
      }
      // 组装特殊情况结果：right 模式"是否出现特殊情况"仅作固定描述、不参与判断；reason 可为空
      const special = Object.assign({ reason: reason }, choices);
      if (checkMode !== 'right') {
        special.occurred = true;
      }
      showResult(container, rating, special);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmBtn.click();
    });

    actions.appendChild(confirmBtn);
    container.appendChild(actions);
    input.focus();
  }

  function buildSpecialLines(special) {
    if (!special) return '';
    const lines = [];
    if (checkMode === 'right') {
      lines.push('是否出现特殊情况：');
      lines.push('都无法标注：' + special.cannotAll);
      lines.push('美观度基本相同：' + special.aestheticsSame);
      lines.push('功能性基本相同：' + special.funcSame);
      if (special.reason) {
        lines.push('特殊情况原因：' + special.reason);
      }
    } else {
      lines.push('是否出现特殊情况：' + (special.occurred ? '出现' : '未出现'));
      if (special.occurred) {
        lines.push('无法标注：' + special.cannot);
        lines.push('特殊情况原因：' + special.reason);
      }
    }
    return lines.join('\n');
  }

  function showResult(container, aestheticsRating, special) {
    cleanupKeyHandler(container);

    const failedItems = checkItems.filter(i => i.status === 'fail');
    const passedItems = checkItems.filter(i => i.status === 'pass');

    const portLine = portNumber && portNumber !== '__NONE__' ? `需要输入端口号${portNumber}进行获取预览\n` : '';
    let failText;

    if (checkMode === 'left') {
      // 左边check：无论有无不通过项都携带"第一次标注："；不通过原因仅在存在时追加
      failText = portLine + '第一次标注：' + (failedItems.length > 0
        ? '\n产物一checklist未通过原因：\n' + failedItems.map(i => `${i.index}. ${i.reason}`).join('\n')
        : '');
    } else if (checkMode === 'right') {
      // 右边check：首行"产物二checklist未通过原因："，无"第一次标注"，末行"美观度 GSB 原因"；全部通过时省略
      failText = failedItems.length > 0
        ? portLine + '产物二checklist未通过原因：\n' + failedItems.map(i => `${i.index}. ${i.reason}`).join('\n') + '\n美观度 GSB 原因：' + aestheticsRating
        : portLine + '美观度 GSB 原因：' + aestheticsRating;
    } else {
      // 单条check：当前逻辑；全部通过时省略"第一次标注"
      failText = failedItems.length > 0
        ? portLine + '第一次标注：\n' + failedItems.map(i => `${i.index}. ${i.reason}`).join('\n') + '\n美观度评分原因：' + aestheticsRating
        : portLine + '美观度评分原因：' + aestheticsRating;
    }

    const specialLines = buildSpecialLines(special);
    if (specialLines) {
      if (!failText || failText.endsWith('\n')) {
        failText = (failText || '') + specialLines;
      } else {
        failText = failText + '\n' + specialLines;
      }
    }

    let passText = passedItems.length > 0
      ? passedItems.map(i => i.index).join('、')
      : '（无）';

    container.innerHTML = '';
    container.classList.add('cl-result-mode');

    const header = document.createElement('div');
    header.className = 'cl-bar';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'cl-bar-left';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'cl-nav-btn';
    prevBtn.innerHTML = '&lsaquo;';
    prevBtn.title = '返回修改';
    prevBtn.addEventListener('click', () => {
      currentIndex = checkItems.length - 1;
      container.classList.remove('cl-result-mode');
      showCurrentItem();
    });

    const title = document.createElement('span');
    title.className = 'cl-progress';
    title.textContent = '检查完毕';

    leftGroup.appendChild(prevBtn);
    leftGroup.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cl-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      container.remove();
      clearState();
    });

    header.appendChild(leftGroup);
    header.appendChild(closeBtn);
    container.appendChild(header);
    addHideButton(container);

    // 不通过部分
    const failSection = document.createElement('div');
    failSection.className = 'cl-result-section';

    const failLabel = document.createElement('div');
    failLabel.className = 'cl-result-label';
    failLabel.textContent = '不通过项：';

    const failPre = document.createElement('pre');
    failPre.className = 'cl-result-text';
    failPre.textContent = failText;

    const failCopyBtn = document.createElement('button');
    failCopyBtn.className = 'cl-btn cl-btn-copy';
    failCopyBtn.textContent = '复制';
    failCopyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(failText).then(() => {
        failCopyBtn.textContent = '已复制';
        setTimeout(() => { failCopyBtn.textContent = '复制'; }, 1500);
      });
    });

    failSection.appendChild(failLabel);
    failSection.appendChild(failPre);
    failSection.appendChild(failCopyBtn);
    container.appendChild(failSection);

    // 通过部分
    const passSection = document.createElement('div');
    passSection.className = 'cl-result-section';

    const passLabel = document.createElement('div');
    passLabel.className = 'cl-result-label';
    passLabel.textContent = '通过的条目编号：';

    const passPre = document.createElement('pre');
    passPre.className = 'cl-result-text';
    passPre.textContent = passText;

    const passCopyBtn = document.createElement('button');
    passCopyBtn.className = 'cl-btn cl-btn-copy';
    passCopyBtn.textContent = '复制';
    passCopyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(passText).then(() => {
        passCopyBtn.textContent = '已复制';
        setTimeout(() => { passCopyBtn.textContent = '复制'; }, 1500);
      });
    });

    passSection.appendChild(passLabel);
    passSection.appendChild(passPre);
    passSection.appendChild(passCopyBtn);
    container.appendChild(passSection);

    clearState();
  }
})();
