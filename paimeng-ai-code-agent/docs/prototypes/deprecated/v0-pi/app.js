/* Prototype interactions. No backend, no real generation — every async step is
   a scheduled piece of UI so the flow can be reviewed without the app running. */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobileQuery = window.matchMedia('(max-width: 980px)');

  const DEFAULT_PROMPT = '做一个卖手作陶瓷的独立小店，安静、温暖，商品列表和详情都要。像一本器物图录，不要常见的电商模板感。';
  const TECH_LABELS = {
    auto: '自动 · AI 选择',
    vue: 'Vue 3',
    react: 'React',
    html: 'HTML',
  };
  const TECH_SENTENCE = {
    auto: '这是一个内容型站点，我会按 Vue 3 工程模板起步。',
    vue: '按 Vue 3 工程模板起步，先搭好页面结构。',
    react: '按 React 工程模板起步，先搭好页面结构。',
    html: '先用单文件 HTML 把结构和样式立起来。',
  };
  const DEFAULT_TECH = 'auto';

  const state = {
    screen: 'home',
    theme: 'light',
    tech: 'auto',
    filter: 'all',
    view: 'preview',
    device: 'desktop',
    generating: false,
    chatRendered: false,
    lastPrompt: DEFAULT_PROMPT,
    lastTech: DEFAULT_TECH,
    overlay: null,
    sidebarOpen: false,
    timers: [],
    toastTimer: 0,
    trigger: null,
  };

  const els = {
    body: document.body,
    home: $('#screen-home'),
    workspace: $('#screen-workspace'),
    app: $('#screen-workspace'),
    appBody: $('#app-body'),
    appSidebar: $('#app-sidebar'),
    sidebarScrim: $('#sidebar-scrim'),
    scrim: $('#scrim'),
    drawer: $('#versions-drawer'),
    modal: $('#deploy-modal'),
    toast: $('#toast'),
    prompt: $('#prompt'),
    promptCount: $('#prompt-count'),
    createForm: $('#create-form'),
    techHint: $('#tech-hint'),
    chatScroll: $('#chat-scroll'),
    chatForm: $('#chat-form'),
    followup: $('#followup'),
    chatNote: $('#chat-note'),
    mock: $('#mock-site'),
    browser: $('#browser'),
    previewCanvas: $('#preview-canvas'),
    previewLoading: $('#preview-loading'),
    loadingCount: $('#loading-count'),
    previewMeta: $('#preview-meta'),
    codePane: $('#code-pane'),
    statusText: $('#status-text'),
    statusPill: $('#app-status'),
    appTitle: $('#app-title'),
    replay: $('#replay-btn'),
    protoButtons: $$('.proto-btn[data-screen-link]'),
    versionButton: $('.head-actions [data-open="versions"]'),
    navLinks: $('#nav-links'),
  };

  /* ---------------------------------------------------------------- */
  /* Utilities                                                        */
  /* ---------------------------------------------------------------- */
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function nowTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }

  function toast(message, duration = 2600) {
    window.clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => { els.toast.hidden = true; }, duration);
  }

  function clearTimers() {
    state.timers.forEach((timer) => window.clearTimeout(timer));
    state.timers = [];
  }

  function later(callback, delay) {
    state.timers.push(window.setTimeout(callback, delay));
  }

  function scrollChat() {
    els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
  }

  function setStatus(text, ok = true) {
    els.statusText.textContent = text;
    const dot = els.statusPill.querySelector('.dot');
    if (dot) dot.className = ok ? 'dot dot--ok' : 'dot';
  }

  function closeNav() {
    els.navLinks.classList.remove('is-open');
    const burger = $('.nav-burger');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  }

  function syncScrim() {
    els.scrim.hidden = !state.overlay;
  }

  function setSidebarOpen(open) {
    const visible = Boolean(open) && mobileQuery.matches;
    state.sidebarOpen = visible;
    els.app.classList.toggle('sidebar-open', visible);
    els.body.classList.toggle('sidebar-open', visible);
    if (els.sidebarScrim) els.sidebarScrim.hidden = !visible;
    if (visible) closeNav();
  }

  function collapseSidebarForMobile() {
    setSidebarOpen(false);
  }

  /* ---------------------------------------------------------------- */
  /* Theme                                                            */
  /* ---------------------------------------------------------------- */
  function applyTheme(theme, persist = true) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    if (persist) {
      try { localStorage.setItem('paimeng.prototype.theme', state.theme); } catch { /* file:// privacy mode */ }
    }
    $$('.theme-toggle').forEach((button) => {
      button.setAttribute('aria-label', state.theme === 'dark' ? '切换为浅色主题' : '切换为深色主题');
      button.setAttribute('title', state.theme === 'dark' ? '切换为浅色主题' : '切换为深色主题');
    });
  }

  function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem('paimeng.prototype.theme'); } catch { /* ignore */ }
    const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(stored === 'dark' || stored === 'light' ? stored : preferred, false);
  }

  /* ---------------------------------------------------------------- */
  /* Screens                                                          */
  /* ---------------------------------------------------------------- */
  function setScreen(screen) {
    if (screen !== 'home' && screen !== 'workspace') return;
    state.screen = screen;
    closeNav();
    closeOverlay();
    collapseSidebarForMobile();
    if (screen === 'workspace') {
      els.home.hidden = true;
      els.workspace.hidden = false;
      els.body.dataset.screen = 'workspace';
      els.replay.hidden = false;
      if (!state.chatRendered) {
        renderDefaultChat();
        state.chatRendered = true;
      }
    } else {
      els.workspace.hidden = true;
      els.home.hidden = false;
      els.body.dataset.screen = 'home';
      els.replay.hidden = true;
      window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }
    els.protoButtons.forEach((button) => {
      const active = button.dataset.screenLink === screen;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  /* ---------------------------------------------------------------- */
  /* Composer + prompts                                               */
  /* ---------------------------------------------------------------- */
  function selectTech(tech) {
    state.tech = tech;
    $$('.tech-tab').forEach((tab) => {
      const active = tab.dataset.tech === tech;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    els.techHint.textContent = tech === 'auto' ? 'AI 选择' : TECH_LABELS[tech];
  }

  function setPrompt(text, { focus = true } = {}) {
    els.prompt.value = text;
    updatePromptCount();
    if (focus) {
      els.prompt.focus();
      els.prompt.setSelectionRange(text.length, text.length);
    }
  }

  function updatePromptCount() {
    els.promptCount.textContent = `${els.prompt.value.length} / 1000`;
  }

  function usePrompt(text) {
    setPrompt(text);
    const composer = $('.composer');
    if (composer) {
      composer.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
    }
    toast('已填入提示词，可以接着修改再生成。', 2200);
  }

  function submitCreate(event) {
    event.preventDefault();
    const prompt = els.prompt.value.trim();
    if (!prompt) {
      toast('先写一句你想做的东西。', 2200);
      els.prompt.focus();
      return;
    }
    startGeneration(prompt, state.tech);
  }

  /* ---------------------------------------------------------------- */
  /* Chat rendering                                                   */
  /* ---------------------------------------------------------------- */
  function toolRow(name, path, meta = '', done = true) {
    return `<div class="tool">
      <span class="tool-icon" aria-hidden="true">${done ? '✓' : '·'}</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-path">${escapeHtml(path)}</span>
      ${meta ? `<span class="tool-meta">${escapeHtml(meta)}</span>` : ''}
    </div>`;
  }

  function progressCard(complete) {
    return `<div class="progress-card">
      <div class="progress-head"><strong>${complete ? '生成完成' : '生成中'}</strong><span>${complete ? '100%' : '08%'}</span></div>
      <div class="progress-bar"><i style="width:${complete ? 100 : 8}%"></i></div>
      <ol class="progress-list">
        <li data-step="understand" class="${complete ? 'is-done' : 'is-running'}"><span class="step-icon" aria-hidden="true">${complete ? '✓' : '◌'}</span><span class="step-label">理解需求</span><span class="step-time">${complete ? '0.6s' : '—'}</span></li>
        <li data-step="files" class="${complete ? 'is-done' : ''}"><span class="step-icon" aria-hidden="true">${complete ? '✓' : '·'}</span><span class="step-label">写入文件</span><span class="step-time">${complete ? '12 个文件' : '—'}</span></li>
        <li data-step="build" class="${complete ? 'is-done' : ''}"><span class="step-icon" aria-hidden="true">${complete ? '✓' : '·'}</span><span class="step-label">构建</span><span class="step-time">${complete ? '2.1s' : '—'}</span></li>
        <li data-step="preview" class="${complete ? 'is-done' : ''}"><span class="step-icon" aria-hidden="true">${complete ? '✓' : '·'}</span><span class="step-label">预览就绪</span><span class="step-time">${complete ? 'v4' : '—'}</span></li>
      </ol>
    </div>`;
  }

  const QUICK_REPLIES = [
    '把主色换成墨绿。',
    '加一个关于页，讲一讲工作室的故事。',
    '再安静一点，减少颜色，留更多空白。',
  ];

  function quickRepliesHtml() {
    return `<div class="quick-replies" aria-label="继续修改">${QUICK_REPLIES.map((text) => `<button type="button" data-fill="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join('')}</div>`;
  }

  function renderDefaultChat() {
    const time = nowTime();
    els.chatScroll.innerHTML = `
      <div class="chat-runhead"><span>GENERATION #112 · PI-DURABLE · ${time}</span><span>12 文件 · V4</span></div>
      <article class="msg msg--user">
        <div class="msg-body">
          <p class="msg-text">${escapeHtml(DEFAULT_PROMPT)}</p>
          <div class="attach-row"><span class="attach-thumb" aria-hidden="true"></span><span class="mono">moodboard.jpg · 128 KB</span></div>
          <p class="msg-meta mono">今天 ${time} · ${TECH_LABELS[DEFAULT_TECH]}</p>
        </div>
      </article>
      <article class="msg msg--ai">
        <div class="msg-body">
          <p class="msg-text">先把需求拆成四页：首页、器物、工作室、购物袋。视觉上用手作陶土色和宋体，避免常见的电商模板感。</p>
          <div class="tool-list" aria-label="工具调用">
            ${toolRow('read', 'templates/vue-ts', '12 个文件')}
            ${toolRow('write', 'src/App.vue', '+186')}
            ${toolRow('write', 'src/components/*.vue', '4 个组件')}
            ${toolRow('run', 'vite build', '2.1s')}
          </div>
          ${progressCard(true)}
          <p class="msg-text">v4 已经就绪。首页是器物陈列，详情页可以切换规格，购物袋做了侧边抽屉。右侧切到手机看看。</p>
          <div class="diff-line mono"><span class="add">+412</span><span class="del">−0</span><span>8 个文件</span><span>·</span><span>18.4s</span></div>
          ${quickRepliesHtml()}
          <p class="msg-meta mono">今天 ${time} · codegen.default · 18.4s</p>
        </div>
      </article>`;
    els.chatScroll.scrollTop = 0;
    enableChatComposer(true);
    setStatus('可预览 v4', true);
  }

  function renderLiveChat(prompt, tech, withAttachment) {
    const time = nowTime();
    els.chatScroll.innerHTML = `
      <div class="chat-runhead"><span>GENERATION #113 · JUST NOW</span><span>DEMO · 3.2s</span></div>
      <article class="msg msg--user">
        <div class="msg-body">
          <p class="msg-text">${escapeHtml(prompt)}</p>
          ${withAttachment ? '<div class="attach-row"><span class="attach-thumb" aria-hidden="true"></span><span class="mono">moodboard.jpg · 128 KB</span></div>' : ''}
          <p class="msg-meta mono">今天 ${time} · ${TECH_LABELS[tech]}</p>
        </div>
      </article>
      <article class="msg msg--ai">
        <div class="msg-body">
          <p class="msg-text" id="live-intro">${TECH_SENTENCE[tech] || TECH_SENTENCE.auto}</p>
          <div class="tool-list" id="live-tools" aria-label="工具调用"></div>
          <div class="progress-card" id="live-progress">
            <div class="progress-head"><strong>生成中</strong><span id="live-pct">08%</span></div>
            <div class="progress-bar"><i id="live-bar" style="width:8%"></i></div>
            <ol class="progress-list">
              <li data-step="understand" class="is-running"><span class="step-icon" aria-hidden="true">◌</span><span class="step-label">理解需求</span><span class="step-time">—</span></li>
              <li data-step="files"><span class="step-icon" aria-hidden="true">·</span><span class="step-label">写入文件</span><span class="step-time">—</span></li>
              <li data-step="build"><span class="step-icon" aria-hidden="true">·</span><span class="step-label">构建</span><span class="step-time">—</span></li>
              <li data-step="preview"><span class="step-icon" aria-hidden="true">·</span><span class="step-label">预览就绪</span><span class="step-time">—</span></li>
            </ol>
          </div>
          <div id="live-summary" hidden>
            <p class="msg-text">v4 已经就绪。首页是器物陈列，详情页可以切换规格，购物袋做了侧边抽屉。右侧切到手机看看。</p>
            <div class="diff-line mono"><span class="add">+412</span><span class="del">−0</span><span>8 个文件</span><span>·</span><span>18.4s</span></div>
            ${quickRepliesHtml()}
            <p class="msg-meta mono">今天 ${nowTime()} · codegen.default · 18.4s</p>
          </div>
        </div>
      </article>`;
    scrollChat();
  }

  function stepNode(name) {
    return els.chatScroll.querySelector(`[data-step="${name}"]`);
  }

  function setStep(name, mode, timeText) {
    const node = stepNode(name);
    if (!node) return;
    node.classList.toggle('is-running', mode === 'running');
    node.classList.toggle('is-done', mode === 'done');
    const icon = node.querySelector('.step-icon');
    if (icon) icon.textContent = mode === 'done' ? '✓' : mode === 'running' ? '◌' : '·';
    if (timeText !== undefined) {
      const time = node.querySelector('.step-time');
      if (time) time.textContent = timeText;
    }
    scrollChat();
  }

  function addLiveTool(name, path, meta = '') {
    const list = $('#live-tools');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'tool';
    row.innerHTML = `<span class="tool-icon" aria-hidden="true">✓</span><span class="tool-name">${escapeHtml(name)}</span><span class="tool-path">${escapeHtml(path)}</span>${meta ? `<span class="tool-meta">${escapeHtml(meta)}</span>` : ''}`;
    list.appendChild(row);
    scrollChat();
  }

  function setProgress(percent) {
    const bar = $('#live-bar');
    const pct = $('#live-pct');
    if (bar) bar.style.width = `${percent}%`;
    if (pct) pct.textContent = `${String(percent).padStart(2, '0')}%`;
  }

  function setBusy(busy) {
    state.generating = busy;
    els.followup.disabled = busy;
    const submit = $('#chat-form button[type="submit"]');
    if (submit) submit.disabled = busy;
    els.followup.placeholder = busy ? '正在生成，完成后可以继续改…' : '继续描述要改的地方，例如：把主色换成墨绿，再加一个关于页。';
    els.chatNote.textContent = busy
      ? '正在生成 v4 · 按 ESC 停止 · 关掉页面也不会丢任务'
      : 'Enter 发送 · Shift+Enter 换行 · 每 60 秒 1 次 · 断连不会取消任务';
  }

  function enableChatComposer(enabled) {
    setBusy(!enabled);
  }

  function setLoading(visible, count) {
    els.previewLoading.hidden = !visible;
    if (count) els.loadingCount.textContent = count;
  }

  function setVersionLabels(label) {
    const upper = label.toUpperCase();
    if (els.versionButton) {
      els.versionButton.innerHTML = `<span class="mono">版本</span> ${label} <span aria-hidden="true">▾</span>`;
    }
    const tools = $('.browser-tools');
    if (tools) tools.textContent = `${upper} · 200`;
    const right = $('.statusbar-right');
    if (right) right.textContent = `${upper} · 21:04`;
    const deployVersion = $('#deploy-version');
    if (deployVersion) deployVersion.textContent = upper;
  }

  function markVersionRow(index) {
    const rows = $$('.version');
    rows.forEach((row, i) => {
      row.classList.toggle('is-current', i === index);
      row.querySelectorAll('.tag--current').forEach((tag) => tag.remove());
      const restore = row.querySelector('[data-action="restore"]');
      if (restore) {
        restore.disabled = i === index;
        restore.textContent = i === index ? '当前版本' : '使用这一版本';
      }
    });
    const current = rows[index];
    if (current) {
      const titleRow = current.querySelector('.version-title');
      if (titleRow) {
        const tag = document.createElement('span');
        tag.className = 'tag tag--current';
        tag.textContent = '正在使用';
        titleRow.appendChild(tag);
      }
    }
  }

  function resetPreview() {
    setView('preview');
    setDevice('desktop');
    els.mock.removeAttribute('data-theme');
    els.mock.removeAttribute('data-vintage');
    els.browser.classList.remove('is-refreshing');
    setLoading(false);
    els.previewMeta.textContent = 'V4 · 1440 × 900 · 预览就绪';
    setVersionLabels('v4');
    markVersionRow(0);
  }

  /* ---------------------------------------------------------------- */
  /* Generation simulation                                            */
  /* ---------------------------------------------------------------- */
  function startGeneration(prompt, tech = 'auto') {
    const text = String(prompt || '').trim();
    if (!text) {
      toast('先写一句你想做的东西。', 2200);
      return;
    }
    if (state.generating) {
      toast('还在生成中，稍等片刻。', 2000);
      return;
    }

    clearTimers();
    state.chatRendered = true;
    state.lastPrompt = text;
    state.lastTech = tech;
    state.generating = true;

    // Start from a clean preview, then play the build sequence.
    resetPreview();
    setScreen('workspace');
    renderLiveChat(text, tech, /陶|陶器|手作|店|器物/.test(text));
    setBusy(true);
    setStatus('生成中', false);
    els.replay.disabled = true;
    setStatusbarState('构建中');
    els.previewMeta.textContent = 'V4 · 正在构建';
    setLoading(true, '00 / 12 FILES');
    setProgress(8);

    later(() => {
      setStep('understand', 'done', '0.6s');
      setProgress(26);
      addLiveTool('read', 'templates/vue-ts', '12 个文件');
      setStep('files', 'running', '3 / 12');
      setLoading(true, '03 / 12 FILES');
    }, 620);

    later(() => {
      addLiveTool('write', 'src/App.vue', '+186');
      setStep('files', 'running', '7 / 12');
      setProgress(46);
      setLoading(true, '07 / 12 FILES');
    }, 1080);

    later(() => {
      addLiveTool('write', 'src/components/*.vue', '4 个组件');
      setStep('files', 'running', '12 / 12');
      setProgress(60);
      setLoading(true, '12 / 12 FILES');
    }, 1600);

    later(() => {
      setStep('files', 'done', '2.0s');
      setStep('build', 'running', '构建中');
      addLiveTool('run', 'vite build');
      setProgress(76);
    }, 2050);

    later(() => {
      setStep('build', 'done', '2.1s');
      setStep('preview', 'running', '生成截图');
      setProgress(92);
      const head = $('#live-progress .progress-head strong');
      if (head) head.textContent = '生成完成';
    }, 2760);

    later(() => {
      setStep('preview', 'done', 'v4');
      setProgress(100);
      setLoading(false);
      const summary = $('#live-summary');
      if (summary) summary.hidden = false;
      els.previewMeta.textContent = 'V4 · 1440 × 900 · 预览就绪';
      setStatus('可预览 v4', true);
      setStatusbarState(state.view === 'code' ? '源码视图' : '预览就绪');
      setBusy(false);
      els.replay.disabled = false;
      scrollChat();
      toast('v4 已就绪。右侧可以切换预览、代码与手机视图。', 3200);
    }, 3240);
  }

  function cancelGeneration() {
    if (!state.generating) return false;
    clearTimers();
    state.generating = false;
    setBusy(false);
    setLoading(false);
    setStatus('可预览 v4', true);
    setStatusbarState(state.view === 'code' ? '源码视图' : '预览就绪');
    els.replay.disabled = false;
    setStep('build', 'done', '已停止');
    const summary = $('#live-summary');
    if (summary) summary.hidden = false;
    els.previewMeta.textContent = 'V4 · 1440 × 900 · 预览就绪';
    scrollChat();
    toast('已停止生成（原型演示）。', 2400);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Follow-up chat                                                   */
  /* ---------------------------------------------------------------- */
  function appendUserMessage(text) {
    const article = document.createElement('article');
    article.className = 'msg msg--user';
    article.innerHTML = `<div class="msg-body"><p class="msg-text">${escapeHtml(text)}</p><p class="msg-meta mono">今天 ${nowTime()} · 修改</p></div>`;
    els.chatScroll.appendChild(article);
    scrollChat();
  }

  function appendAssistantMessage(text, extra = '') {
    const article = document.createElement('article');
    article.className = 'msg msg--ai';
    article.innerHTML = `<div class="msg-body"><p class="msg-text">${escapeHtml(text)}</p>${extra}<p class="msg-meta mono">今天 ${nowTime()} · 原型演示</p></div>`;
    els.chatScroll.appendChild(article);
    scrollChat();
  }

  function handleFollowup(event) {
    event.preventDefault();
    const text = els.followup.value.trim();
    if (!text) {
      toast('写一句想改的地方，再发送。', 2000);
      return;
    }
    if (state.generating) {
      toast('生成中，先等这一轮完成（原型不排队）。', 2200);
      return;
    }
    els.followup.value = '';
    appendUserMessage(text);

    const green = /墨绿|绿色|绿/.test(text);
    const about = /关于|about/i.test(text);
    if (green) {
      els.mock.dataset.theme = 'moss';
      els.previewMeta.textContent = 'V4 · 1440 × 900 · 墨绿主题';
    }

    window.setTimeout(() => {
      if (green) {
        appendAssistantMessage(
          '已把主色换成墨绿，预览会立刻变色。',
          '<div class="diff-line mono"><span class="add">+18</span><span class="del">−6</span><span>src/styles/theme.css</span></div>'
        );
        toast('预览中的主色已改成墨绿。', 2400);
      } else if (about) {
        appendAssistantMessage(
          '会新增一个「关于」页，讲工作室的来处。',
          '<div class="diff-line mono"><span class="add">+86</span><span class="del">−0</span><span>src/views/About.vue</span></div>'
        );
        toast('原型只演示界面：真实产品会新增 About.vue。', 2800);
      } else {
        appendAssistantMessage('收到。这一版原型只演示界面，真实产品会从这里接着生成 v5。');
        toast('真实产品会继续生成 v5；原型停在演示层。', 2600);
      }
    }, 380);
  }

  /* ---------------------------------------------------------------- */
  /* Preview tabs, device, code                                       */
  /* ---------------------------------------------------------------- */
  function setStatusbarState(text) {
    const node = $('#statusbar-state');
    if (node) node.textContent = text;
  }

  function setView(view) {
    state.view = view === 'code' ? 'code' : 'preview';
    $$('.preview-tab').forEach((tab) => {
      const active = tab.dataset.view === state.view;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    els.previewCanvas.hidden = state.view !== 'preview';
    els.codePane.hidden = state.view !== 'code';
    const toggle = $('.device-toggle');
    if (toggle) toggle.style.display = state.view === 'preview' ? '' : 'none';
    setStatusbarState(state.view === 'code' ? '源码视图' : '预览就绪');
  }

  function setDevice(device) {
    state.device = device === 'mobile' ? 'mobile' : 'desktop';
    $$('.device-btn').forEach((button) => {
      const active = button.dataset.device === state.device;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    els.browser.classList.toggle('is-mobile', state.device === 'mobile');
    const size = state.device === 'mobile' ? '390 × 844' : '1440 × 900';
    els.previewMeta.textContent = `V4 · ${size} · 预览就绪`;
  }

  function refreshPreview() {
    els.browser.classList.add('is-refreshing');
    window.setTimeout(() => els.browser.classList.remove('is-refreshing'), 320);
    toast('已重新载入预览（原型）。', 1800);
  }

  /* ---------------------------------------------------------------- */
  /* Overlays                                                         */
  /* ---------------------------------------------------------------- */
  function openOverlay(name, trigger) {
    state.overlay = name;
    state.trigger = trigger || document.activeElement;
    collapseSidebarForMobile();
    els.scrim.hidden = false;
    if (name === 'versions') {
      els.drawer.hidden = false;
      $('#versions-drawer .drawer-head .icon-btn')?.focus();
    } else if (name === 'deploy') {
      els.modal.hidden = false;
      $('#copy-url')?.focus();
    }
  }

  function closeOverlay() {
    if (!state.overlay) return;
    state.overlay = null;
    els.drawer.hidden = true;
    els.modal.hidden = true;
    syncScrim();
    const trigger = state.trigger;
    state.trigger = null;
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('链接已复制。', 1800)).catch(() => legacyCopy(text));
    } else {
      legacyCopy(text);
    }
  }

  function legacyCopy(text) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    try {
      helper.select();
      const ok = document.execCommand('copy');
      toast(ok ? '链接已复制。' : '复制失败，请手动选择链接。', 2000);
    } catch {
      toast('复制失败，请手动选择链接。', 2000);
    } finally {
      document.body.removeChild(helper);
    }
  }

  function restoreVersion(button) {
    const row = button.closest('.version');
    if (!row) return;
    const rows = $$('.version');
    const index = rows.indexOf(row);
    const label = ['v4', 'v3', 'v2', 'v1'][index] || 'v4';

    markVersionRow(index);
    setVersionLabels(label);

    if (label === 'v4') {
      els.mock.removeAttribute('data-vintage');
      els.statusText.textContent = '可预览 v4';
      els.previewMeta.textContent = 'V4 · 1440 × 900 · 预览就绪';
    } else {
      els.mock.dataset.vintage = label;
      els.statusText.textContent = `可预览 ${label}`;
      els.previewMeta.textContent = `${label.toUpperCase()} · 1440 × 900 · 旧版本`;
    }
    toast(`已换成 ${label} 这一版（原型演示）。`, 2600);
  }

  /* ---------------------------------------------------------------- */
  /* Sidebar                                                          */
  /* ---------------------------------------------------------------- */
  function toggleSidebar() {
    if (mobileQuery.matches) {
      setSidebarOpen(!state.sidebarOpen);
      return;
    }
    els.app.classList.toggle('sidebar-collapsed');
  }

  function closeSidebar() {
    if (!state.sidebarOpen) return;
    setSidebarOpen(false);
  }

  function filterApps(query) {
    const needle = query.trim().toLowerCase();
    let visible = 0;
    $$('.app-list > li').forEach((item) => {
      const text = item.textContent.toLowerCase();
      const show = !needle || text.includes(needle);
      item.hidden = !show;
      if (show) visible += 1;
    });
    const count = $('#recent-count');
    if (count) count.textContent = String(visible);
  }

  /* ---------------------------------------------------------------- */
  /* Splitter drag                                                    */
  /* ---------------------------------------------------------------- */
  function initSplitter() {
    const splitter = $('.splitter');
    if (!splitter) return;
    splitter.addEventListener('pointerdown', (event) => {
      if (window.innerWidth <= 980) return;
      event.preventDefault();
      const rect = els.appBody.getBoundingClientRect();
      els.appBody.classList.add('is-resizing');
      const move = (moveEvent) => {
        const max = rect.width - 360;
        const next = Math.min(Math.max(moveEvent.clientX - rect.left, 300), Math.max(320, max));
        els.appBody.style.setProperty('--chat-w', `${Math.round(next)}px`);
      };
      const stop = () => {
        els.appBody.classList.remove('is-resizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
    });
    splitter.addEventListener('dblclick', () => els.appBody.style.removeProperty('--chat-w'));
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                           */
  /* ---------------------------------------------------------------- */
  function bindEvents() {
    // Theme
    $$('.theme-toggle').forEach((button) => button.addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    }));

    // Screen switches (nav, hero brand, prototype nav, "new app", sidebar brand)
    $$('[data-screen-link]').forEach((element) => {
      element.addEventListener('click', (event) => {
        event.preventDefault();
        const screen = element.dataset.screenLink;
        if (screen === 'home' && state.screen === 'home') {
          window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
          return;
        }
        setScreen(screen);
      });
    });

    // Nav sheet
    els.navLinks.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeNav));
    const burger = $('.nav-burger');
    if (burger) {
      burger.addEventListener('click', (event) => {
        event.stopPropagation();
        const open = !els.navLinks.classList.contains('is-open');
        els.navLinks.classList.toggle('is-open', open);
        burger.setAttribute('aria-expanded', String(open));
      });
    }
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.nav')) closeNav();
    });

    // Home composer
    els.prompt.addEventListener('input', updatePromptCount);
    els.prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        els.createForm.requestSubmit();
      }
    });
    els.createForm.addEventListener('submit', submitCreate);

    $$('.tech-tab').forEach((tab) => tab.addEventListener('click', () => selectTech(tab.dataset.tech)));
    $$('.chip[data-prompt]').forEach((chip) => chip.addEventListener('click', () => usePrompt(chip.dataset.prompt)));

    // Templates
    $$('.filter').forEach((button) => button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      $$('.filter').forEach((item) => {
        const active = item.dataset.filter === state.filter;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      $$('#template-grid .tcard').forEach((card) => {
        card.hidden = state.filter !== 'all' && card.dataset.category !== state.filter;
      });
    }));
    $$('.tcard').forEach((card) => {
      const use = card.querySelector('.tcard-use');
      if (use) use.addEventListener('click', () => usePrompt(card.dataset.prompt));
    });

    // Generic prototype toasts
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-toast]');
      if (target) {
        event.preventDefault();
        toast(target.dataset.toast, 2800);
      }
    });

    // Chat
    els.chatForm.addEventListener('submit', handleFollowup);
    els.followup.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        els.chatForm.requestSubmit();
      }
    });
    els.chatScroll.addEventListener('click', (event) => {
      const fill = event.target.closest('[data-fill]');
      if (fill) {
        els.followup.value = fill.dataset.fill;
        els.followup.focus();
        els.followup.setSelectionRange(els.followup.value.length, els.followup.value.length);
        toast('已填入修改描述，发送后会看到反馈。', 2000);
      }
    });

    // Preview tabs / devices / refresh
    $$('.preview-tab').forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.view)));
    $$('.device-btn').forEach((button) => button.addEventListener('click', () => setDevice(button.dataset.device)));
    $('[data-action="refresh"]')?.addEventListener('click', refreshPreview);

    // Mobile pane switch
    $$('.mobile-pane-toggle [data-pane]').forEach((button) => button.addEventListener('click', () => {
      const pane = button.dataset.pane;
      els.appBody.dataset.pane = pane;
      $$('.mobile-pane-toggle [data-pane]').forEach((item) => {
        const active = item.dataset.pane === pane;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
    }));

    // Sidebar
    $$('[data-action="toggle-sidebar"]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.classList.contains('sidebar-close')) {
          if (mobileQuery.matches) closeSidebar();
          else els.app.classList.add('sidebar-collapsed');
        } else {
          toggleSidebar();
        }
      });
    });
    $('[data-action="new-app"]')?.addEventListener('click', () => {
      closeSidebar();
      setScreen('home');
      window.setTimeout(() => {
        els.prompt.focus();
        els.prompt.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
    });
    $$('.app-row').forEach((row) => row.addEventListener('click', () => {
      toast(`原型只演示「陶土商店」这一条；${row.dataset.app} 未接入。`, 2600);
      closeSidebar();
    }));
    $('#app-search')?.addEventListener('input', (event) => filterApps(event.target.value));

    // Overlays
    $$('[data-open]').forEach((button) => button.addEventListener('click', () => openOverlay(button.dataset.open, button)));
    $$('[data-close]').forEach((button) => button.addEventListener('click', closeOverlay));
    els.scrim.addEventListener('click', () => {
      if (state.overlay) closeOverlay();
    });
    els.sidebarScrim?.addEventListener('click', closeSidebar);
    $$('[data-action="restore"]').forEach((button) => button.addEventListener('click', () => restoreVersion(button)));

    // Deploy copy
    $('#copy-url')?.addEventListener('click', () => {
      copyText($('#deploy-url').textContent.trim());
    });

    // Replay
    els.replay.addEventListener('click', () => {
      if (state.generating) {
        toast('正在生成，先让这一轮跑完。', 2000);
        return;
      }
      startGeneration(state.lastPrompt, state.lastTech);
    });

    // Global keys
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

      if (event.key === 'Escape') {
        if (state.overlay) { closeOverlay(); return; }
        if (els.navLinks.classList.contains('is-open')) { closeNav(); return; }
        if (state.sidebarOpen) { closeSidebar(); return; }
        if (state.generating) { cancelGeneration(); return; }
        if (els.toast.hidden === false) els.toast.hidden = true;
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (state.screen === 'workspace') $('#app-search')?.focus();
        else els.prompt.focus();
        return;
      }

      if (event.key === '/' && !typing && state.screen === 'workspace' && !state.overlay) {
        event.preventDefault();
        $('#app-search')?.focus();
      }
    });

    // Keep the mobile scrim honest when the viewport grows.
    mobileQuery.addEventListener?.('change', () => {
      if (!mobileQuery.matches) setSidebarOpen(false);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                             */
  /* ---------------------------------------------------------------- */
  initTheme();
  bindEvents();
  initSplitter();
  selectTech('auto');
  updatePromptCount();
  applyTheme(state.theme, false);

  // Deep link support for sharing a specific screen.
  if (location.hash === '#workspace') {
    startGeneration(DEFAULT_PROMPT, DEFAULT_TECH);
  }
})();
