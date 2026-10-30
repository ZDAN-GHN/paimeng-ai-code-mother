/* 派蒙 · 应用工坊 — prototype interactions
   Every state here is front-end demo only: no model, no build, no deploy. */

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const app = $('#app');

  /* ---------------- theme ---------------- */
  const protoTheme = $('#proto-theme');
  const sunIcons = () => $$('.ic-sun'), moonIcons = () => $$('.ic-moon');

  function applyTheme(t, save = true) {
    document.documentElement.dataset.theme = t;
    if (save) localStorage.setItem('paimeng-theme', t);
    const dark = t === 'dark';
    sunIcons().forEach(e => e.style.display = dark ? 'block' : 'none');
    moonIcons().forEach(e => e.style.display = dark ? 'none' : 'block');
    if (protoTheme) { protoTheme.textContent = dark ? '浅色' : '深色'; protoTheme.setAttribute('aria-pressed', String(dark)); }
  }
  const saved = localStorage.getItem('paimeng-theme');
  applyTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), false);
  const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#theme-btn')?.addEventListener('click', toggleTheme);
  protoTheme?.addEventListener('click', toggleTheme);
  $('[data-action="theme-inline"]')?.addEventListener('click', toggleTheme);
  applyTheme(document.documentElement.dataset.theme, false);

  /* ---------------- toast ---------------- */
  let toastTimer;
  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /* ---------------- views ---------------- */
  const viewHome = $('#view-home'), viewWork = $('#view-work');

  function go(view) {
    const isWork = view === 'work';
    app.dataset.view = isWork ? 'work' : 'home';
    viewHome.hidden = isWork;
    viewWork.hidden = !isWork;
    $$('.nav button').forEach(b => b.removeAttribute('aria-current'));
    $(`.nav button[data-goto="${isWork ? 'work' : 'home'}"]`)?.setAttribute('aria-current', 'page');
    $$('.proto [data-goto]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.goto === (isWork ? 'work' : 'home'))));
    document.body.dataset.screen = isWork ? 'work' : 'home';
    if (!isWork) { app.dataset.ins = 'off'; }
  }
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => {
    const g = b.dataset.goto;
    if (g === 'work' || g === 'home') { go(g); document.body.dataset.nav = 'off'; }
    else toast(g === 'templates' ? '模板页不在本原型范围内' : '设置页不在本原型范围内');
  }));

  /* sidebar + home rows: keyboard reachable */
  $$('[data-open],[data-tpl],.shot').forEach(el => {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest?.('[data-open],[data-tpl],.shot');
    if (!t || t.tagName === 'BUTTON' || t.tagName === 'A') return;
    e.preventDefault();
    t.click();
  });

  /* sidebar app rows + home rows open the workspace */
  $$('[data-open]').forEach(r => r.addEventListener('click', () => {
    go('work');
    if (r.dataset.open !== 'taoci') toast('本原型只完整演示「紫笋茶铺」这一条');
  }));

  document.body.addEventListener('click', e => {
    const t = e.target.closest('[data-action="nav"]');
    if (t) document.body.dataset.nav = document.body.dataset.nav === 'on' ? 'off' : 'on';
    if (e.target.id === 'scrim' || e.target.closest('[data-close]')) closeOverlays();
  });

  /* ---------------- composer (home) ---------------- */
  const prompt = $('#prompt'), tally = $('#tally'), createBtn = $('#create-btn');
  let stack = 'auto';

  function syncPrompt() {
    const n = prompt.value.length;
    tally.textContent = `${n} / 1000`;
    createBtn.disabled = n === 0;
  }
  prompt.addEventListener('input', syncPrompt);
  prompt.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!createBtn.disabled) create(); }
  });

  const STACK_LABEL = { auto: '自动', vue: 'Vue 3', react: 'React', html: 'HTML' };
  const stackBtn = $('#stack-btn'), stackMenu = $('#stack-menu');
  function closeMenu() { stackMenu.hidden = true; stackBtn.setAttribute('aria-expanded', 'false'); }
  stackBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const open = stackMenu.hidden;
    stackMenu.hidden = !open;
    stackBtn.setAttribute('aria-expanded', String(open));
  });
  $$('#stack-menu [data-stack]').forEach(b => b.addEventListener('click', () => {
    stack = b.dataset.stack;
    $$('#stack-menu [data-stack]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    $('#stack-hint').textContent = STACK_LABEL[stack];
    closeMenu();
    prompt.focus();
  }));
  document.addEventListener('click', e => { if (!e.target.closest('.stackmenu')) closeMenu(); });

  $$('#sugg button').forEach(b => b.addEventListener('click', () => {
    const text = `一个${b.textContent}：`;
    prompt.value = text;
    prompt.focus();
    prompt.setSelectionRange(text.length, text.length);
    syncPrompt();
  }));

  $$('[data-tpl]').forEach(r => r.addEventListener('click', () => {
    prompt.value = r.dataset.tpl;
    prompt.focus();
    syncPrompt();
    toast('模板已填进输入框');
  }));

  /* ---------------- generation ---------------- */
  const chatInner = $('#chat-inner'), chatScroll = $('#chat-scroll');
  let running = null;

  const PHASES = [
    ['理解需求', '拆成页面、读出关键词、挑技术栈', 600],
    ['写入文件', 'read templates/vue-ts · write src/App.vue', 9200],
    ['构建与校核', 'vite build · 0 个错误', 2100],
    ['打开预览', '桌面与手机都已就位', 400],
  ];
  const TOTAL = PHASES.reduce((n, p) => n + p[2], 0);   // 12300ms, the number the card prints
  const SPEED = 0.25;                                    // the demo fast-forwards; the numbers do not

  function scrollChat() { chatScroll.scrollTop = chatScroll.scrollHeight; }

  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }

  function userMsg(text) {
    return el(`<div class="msg msg--user"><div class="msg-h"><b>你</b><span>刚刚</span></div><div class="body"></div></div>`);
  }

  function buildGenCard() {
    return el(`
      <div class="gen">
        <div class="gen-h"><b>生成</b><span>·</span><span>派蒙引擎</span><span>·</span><span>刚刚</span>
          <span class="sp"></span><span class="num" data-files>0 个文件</span></div>
        <div class="gen-body">
          <div class="gen-metabar">
            <span class="st st--run" data-st><i></i><span data-st-t>生成中</span></span>
            <span class="pbar"><i data-pbar style="width:0%"></i></span>
            <span data-pbar-t>0%</span>
          </div>
          <div class="phases" data-phases>
            ${PHASES.map(([n, s]) => `
              <div class="ph" data-state="idle">
                <span class="ph-spine"><span class="ph-dot"></span></span>
                <span><span class="ph-n">${n}</span><span class="ph-sub">${s}</span></span>
                <span class="ph-t">—</span>
              </div>`).join('')}
          </div>
        </div>
      </div>`);
  }

  function setCard(card, i, state) {
    const ph = card.querySelectorAll('.ph')[i];
    if (!ph) return;
    ph.dataset.state = state;
    if (state === 'done') ph.querySelector('.ph-t').textContent = (PHASES[i][2] / 1000).toFixed(1) + 's';
    if (state === 'run') ph.querySelector('.ph-t').textContent = '进行中';
  }

  function status(state, label) {
    const map = { run: 'st--run', done: 'st--ok', fail: 'st--err', idle: '' };
    const topState = $('#top-state'), t = $('#top-state-t');
    const insState = $('#ins-state'), it = $('#ins-state-t');
    [topState, insState].forEach((el2, k) => {
      if (!el2) return;
      el2.className = 'st ' + (map[state] || '');
      const lab = k === 0 ? topState : insState;
      (k === 0 ? t : it).textContent = label;
    });
  }

  function veil(on, label) {
    const v = $('#veil');
    if (on) { $('#veil-t').textContent = label || '正在构建预览'; v.hidden = false; }
    else v.hidden = true;
  }

  function startGeneration(text) {
    clearTimeout(running);
    chatInner.innerHTML = '';
    const um = userMsg(text);
    um.querySelector('.body').textContent = text;
    chatInner.appendChild(um);
    const card = buildGenCard();
    chatInner.appendChild(card);
    scrollChat();

    status('run', '生成中');
    veil(true, '正在构建第一版');
    setWorkChip('—');

    let i = 0;
    const step = () => {
      if (i > 0) setCard(card, i - 1, 'done');
      if (i >= PHASES.length) {
        card.querySelector('[data-pbar]').style.width = '100%';
        card.querySelector('[data-pbar-t]').textContent = '100%';
        card.querySelector('[data-st]').className = 'st st--ok';
        card.querySelector('[data-st-t]').textContent = '已完成';
        card.querySelector('[data-files]').textContent = '12 个文件 · v1';
        status('ok', '可预览');
        veil(false);
        setWorkChip('v1');
        toast('第一版好了。右侧是真的能点的');
        const done = el(`<div class="msg"><div class="msg-h"><b>派蒙</b><span>刚刚 · 共 ${(TOTAL / 1000).toFixed(1)}s</span></div>
          <div class="prose"><p><strong>v1 已经就绪。</strong>先按你描述的四页做了第一版，能用鼠标点了。哪里不对直接说，我改。</p></div>
          <div class="follows" style="margin-top:12px">
            <button type="button" data-say="把主色换成墨绿">把主色换成墨绿</button>
            <button type="button" data-say="再安静一点，减少颜色，留更多空白">更安静一点</button>
            <button type="button" data-say="加一个关于页">加一个关于页</button>
          </div></div>`);
        bindFollows(done);
        chatInner.appendChild(done);
        scrollChat();
        running = null;
        return;
      }
      setCard(card, i, 'run');
      card.querySelector('[data-pbar]').style.width = Math.round((i / PHASES.length) * 100) + '%';
      card.querySelector('[data-pbar-t]').textContent = Math.round((i / PHASES.length) * 100) + '%';
      i++;
      running = setTimeout(step, PHASES[i - 1][2] * SPEED);
    };
    step();
  }

  function setWorkChip(v) {
    $('#ver-chip').textContent = v;
    const fv = $('#frame-v'); if (fv) fv.textContent = v;
    const st = $('#ins-status');
    if (st) st.lastElementChild.textContent = `${v} · 刚刚`;
  }

  function create() {
    const text = prompt.value.trim();
    if (!text) return;
    go('work');
    startGeneration(text);
  }
  $('#create-form').addEventListener('submit', e => { e.preventDefault(); create(); });

  /* ---------------- chat ---------------- */
  const followup = $('#followup'), chatSend = $('#chat-send'), chatTally = $('#chat-tally');
  function syncChat() {
    const n = followup.value.length;
    chatTally.textContent = `${n} / 1000`;
    chatSend.disabled = n === 0;
  }
  followup.addEventListener('input', syncChat);
  followup.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!chatSend.disabled) sendChat(); }
  });

  function bindFollows(scope) {
    $$('[data-say]', scope).forEach(b => b.addEventListener('click', () => { followup.value = b.dataset.say; syncChat(); sendChat(); }));
  }
  bindFollows(document);

  function sendChat() {
    const text = followup.value.trim();
    if (!text) return;
    followup.value = '';
    syncChat();

    const um = userMsg(text);
    um.querySelector('.body').textContent = text;
    chatInner.appendChild(um);

    const think = el(`<div class="msg"><div class="msg-h"><b>派蒙</b><span>刚刚</span></div>
      <div class="prose"><p class="muted">在改。这一轮只动你提到的地方，其它保持不动。</p></div></div>`);
    chatInner.appendChild(think);
    scrollChat();

    setTimeout(() => {
      think.remove();
      const green = /绿|墨绿/.test(text);
      if (green) $('#demo').classList.add('is-green');
      const reply = el(`<div class="msg"><div class="msg-h"><b>派蒙</b><span>刚刚 · 改完</span></div>
        <div class="prose"><p>${green ? '<strong>主色换成墨绿了。</strong>只在色板上动了一处，版式和文案没有变。' : '<strong>改好了。</strong>这一版只动了你提到的地方，其余照旧。'}旧的 <b>v4</b> 还在版本里，随时能回去。</p></div></div>`);
      chatInner.appendChild(reply);
      scrollChat();
      status('run', '校核中');
      veil(true, '正在重新构建');
      setTimeout(() => { veil(false); status('ok', '可预览'); toast('已保存为新版本'); }, 900);
    }, 1100);
  }
  $('#chat-form').addEventListener('submit', e => { e.preventDefault(); sendChat(); });

  /* ---------------- demo interactions ---------------- */
  const cart = [];
  const cartEl = $('#d-cart'), cartList = $('#d-cart-list'), cartCount = $('#d-count'), cartTotal = $('#d-total');
  function renderCart() {
    cartCount.textContent = cart.length;
    cartList.innerHTML = cart.map(i => `<li><span>${i.name}</span><span>¥ ${i.price}</span></li>`).join('')
      || '<li style="border:0;color:var(--d-ink-2)">还没有选茶。</li>';
    cartTotal.textContent = '¥ ' + cart.reduce((n, i) => n + i.price, 0);
  }
  $$('#d-list .d-row').forEach(b => b.addEventListener('click', () => {
    cart.push({ name: b.dataset.name, price: Number(b.dataset.price) });
    renderCart();
    cartEl.hidden = false;
  }));
  $('#d-bag')?.addEventListener('click', () => { cartEl.hidden = false; });
  $('#d-cart-x')?.addEventListener('click', () => { cartEl.hidden = true; });
  $('#d-cta')?.addEventListener('click', () => {
    $('#d-list').scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  renderCart();

  /* ---------------- inspector ---------------- */
  $$('[data-pane]').forEach(b => b.addEventListener('click', () => {
    $$('[data-pane]').forEach(x => x.setAttribute('aria-selected', 'false'));
    b.setAttribute('aria-selected', 'true');
    const code = b.dataset.pane === 'code';
    $('#canvas').hidden = code;
    $('#code-pane').hidden = !code;
  }));

  $$('.ins-top [data-w]').forEach(b => b.addEventListener('click', () => {
    $$('[data-w]').forEach(x => x.setAttribute('aria-selected', 'false'));
    b.setAttribute('aria-selected', 'true');
    const y = b.dataset.w;
    $('#frame').dataset.w = y;
    cartEl.hidden = true;
    toast(y === 'phone' ? '375px：站点换成窄屏版式' : '桌面宽度：站点换成宽屏版式');
  }));

  $('[data-action="reload"]').addEventListener('click', () => {
    veil(true, '重新加载预览');
    status('run', '构建中');
    setTimeout(() => { veil(false); status('ok', '预览就绪'); }, 700);
  });
  $('[data-action="open-url"]')?.addEventListener('click', () => toast('原型里没有真实网址'));
  $('[data-action="export"]')?.addEventListener('click', () => toast('导出打包：原型中未实现'));
  $$('[data-action="toggle-ins"]').forEach(b => b.addEventListener('click', () => {
    app.dataset.ins = app.dataset.ins === 'on' ? 'off' : 'on';
  }));
  $('[data-action="versions"]')?.addEventListener('click', openVersions);
  $('#new-app').addEventListener('click', () => { go('home'); prompt.value = ''; syncPrompt(); prompt.focus(); });
  $('.search input')?.addEventListener('input', e => {
    const q = e.target.value.trim();
    let shown = 0;
    $$('#recent-list .item').forEach(it => {
      const hit = !q || it.textContent.includes(q);
      it.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    $('#search-empty').hidden = shown > 0 || !q;
  });

  /* ---------------- overlays ---------------- */
  const scrim = $('#scrim'), versions = $('#versions'), deploy = $('#deploy');
  function closeOverlays() {
    scrim.hidden = true; versions.hidden = true; deploy.hidden = true;
    document.body.dataset.nav = 'off';
  }
  function openVersions() { scrim.hidden = false; versions.hidden = false; }
  $('[data-action="deploy"]')?.addEventListener('click', () => {
    scrim.hidden = false; deploy.hidden = false;
    $('#d-url').textContent = 'https://zisun.paimeng.app';
  });

  $$('#vlist .v').forEach(v => v.addEventListener('click', () => {
    $$('#vlist .v').forEach(x => x.removeAttribute('aria-current'));
    v.setAttribute('aria-current', 'true');
    $('#use-version').disabled = v.dataset.v === $('#ver-chip').textContent.slice(1);
  }));
  $('#use-version').addEventListener('click', () => {
    const v = $('#vlist .v[aria-current="true"]');
    const id = v.dataset.v;
    setWorkChip('v' + id);
    closeOverlays();
    toast(`已切到 v${id}。可以在这里继续改，也可以发布`);
  });

  $('#d-copy').addEventListener('click', async () => {
    const url = $('#d-url').textContent;
    try { await navigator.clipboard.writeText(url); toast('地址已复制'); }
    catch { toast('复制失败，请手动选中'); }
  });

  /* ---------------- keyboard ---------------- */
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === 'Escape') { closeOverlays(); if (running) { clearTimeout(running); running = null; toast('已停止演示'); } return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); go('home'); prompt.focus(); return; }
    if (typing) return;
    if (e.key.toLowerCase() === 't') toggleTheme();
    if (e.key.toLowerCase() === 'r') $('[data-action="reload"]').click();
  });

  /* ---------------- prototype bar ---------------- */
  $('#proto-replay').addEventListener('click', () => {
    go('work');
    startGeneration(prompt.value.trim() || '做一个卖手作陶瓷的独立小店，安静、温暖。');
  });

  /* init */
  syncPrompt();
  syncChat();
  status('ok', '可预览');
})();
