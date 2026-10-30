/* ---------------------------------------------------------------
   派蒙应用工坊 · 暗房
   Static prototype. No network calls, no backend.
   --------------------------------------------------------------- */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const pad = n => String(n).padStart(2, '0');
  const DEMO_DATE = '2026.10.29';
  let demoClock = 21 * 60 + 6;
  const demoTime = () => {
    const h = Math.floor(demoClock / 60) % 24;
    const m = demoClock % 60;
    demoClock += 1;
    return `${pad(h)}:${pad(m)}`;
  };

  const setHash = hash => {
    try { history.replaceState(null, '', hash); } catch (err) { /* file:// can refuse; the prototype still works */ }
  };

  const state = {
    screen: 'home',
    sample: 'bookstore',
    version: 4,
    run: 4,
    view: 'preview',
    device: 'desktop',
    theme: 'amber',
    type: 'serif',
    extra: false,
    generating: false,
    timers: [],
    prevTheme: 'amber',
    prevType: 'serif',
    prevExtra: false,
    runTimes: [],
    toastTimer: 0,
    trigger: null,
    railOpen: false,
    pane: 'preview',
    navOpen: false,
    prevVersion: 4,
  };

  const els = {
    home: $('#home'),
    workspace: $('#screen-workspace'),
    ws: $('#ws'),
    title: $('#ws-title'),
    prompt: $('#prompt'),
    order: $('#order-form'),
    orderBtn: $('.btn--make', $('#order-form')),
    chatSeed: $('#chat-seed'),
    chatForm: $('#chat-form'),
    note: $('#note'),
    chatScroll: $('#chat-scroll'),
    develop: $('#develop'),
    steps: $$('#develop-steps .step'),
    quick: $('#quick-replies'),
    print: $('#print'),
    printScreen: $('#print-screen'),
    previewSite: $('#preview-site'),
    printLoading: $('#print-loading'),
    printBar: $('#print-bar'),
    printLoadingTitle: $('#print-loading-title'),
    printLoadingNote: $('#print-loading-note'),
    negative: $('#negative'),
    codeView: $('#code-view'),
    proofScreen: $('#proof-screen'),
    proofName: $('#proof-name'),
    proofMeta: $('#proof-meta'),
    proofOpen: $('#proof-open'),
    proofGrease: $('.proof-grease'),
    versions: $('#versions'),
    dispatch: $('#dispatch'),
    scrim: $('#scrim'),
    rail: $('#rail'),
    railScrim: $('#rail-scrim'),
    railMenu: $('.ws__menu'),
    toast: $('#toast'),
    splitter: $('#splitter'),
    wsBody: $('#ws-body'),
    navSheet: $('#nav-sheet'),
    menuBtn: $('.menu'),
    status: $('.js-status'),
    runNo: $('.js-run-no'),
    runLabel: $('.js-run-label'),
    proofNo: $('.js-proof-no'),
    printMeta: $('.js-print-meta'),
    developState: $('.js-develop-state'),
    ltState: $('.js-lt-state'),
    liveStamp: $('.js-live'),
    dispatchUrl: $('#dispatch-url'),
    dispatchVersion: $('#dispatch-version'),
    qr: $('#dispatch-qr'),
    toastText: null,
  };

  const SAMPLE_INFO = {
    bookstore: {
      name: '夜航书店',
      meta: '第 041 卷 / 深蓝 + 琥珀 / Vue 3',
      grease: '04 / 可拆改',
      open: true,
    },
    guesthouse: {
      name: '山雾民宿',
      meta: '第 041 卷 / 森林绿 + 石白 / Vue 3',
      grease: '04B / 样片',
      open: false,
    },
    toys: {
      name: '铁皮玩具',
      meta: '第 041 卷 / 红 + 黄 + 钴蓝 / React',
      grease: '04C / 样片',
      open: false,
    },
    tea: {
      name: '白露茶室',
      meta: '第 041 卷 / 青瓷 + 墨 / HTML',
      grease: '04D / 样片',
      open: false,
    },
    radio: {
      name: '声音档案',
      meta: '第 041 卷 / 黑 + 荧光绿 / React',
      grease: '04E / 样片',
      open: false,
    },
    exhibition: {
      name: '纸上展览',
      meta: '第 041 卷 / 纸白 + 钴蓝 + 朱红 / Vue 3',
      grease: '04F / 样片',
      open: false,
    },
  };

  const THEMES = {
    4: 'amber',
    3: 'moss',
    2: 'cobalt',
    1: 'paper',
  };

  const CODE = {
    'App.vue': [
      `<span class="tok-com">&lt;script setup lang="ts"&gt;</span>`,
      `<span class="tok-key">import</span> { computed, ref } <span class="tok-key">from</span> <span class="tok-str">'vue'</span>`,
      `<span class="tok-key">import</span> Hero <span class="tok-key">from</span> <span class="tok-str">'./components/Hero.vue'</span>`,
      `<span class="tok-key">import</span> { books } <span class="tok-key">from</span> <span class="tok-str">'./data/books'</span>`,
      ``,
      `<span class="tok-key">const</span> open = ref(<span class="tok-key">false</span>)`,
      `<span class="tok-key">const</span> shelf = computed(() =&gt; books.slice(<span class="tok-num">0</span>, <span class="tok-num">3</span>))`,
      `<span class="tok-key">const</span> edition = <span class="tok-str">'第 041 卷'</span>`,
      `<span class="tok-com">&lt;/script&gt;</span>`,
      ``,
      `<span class="tok-key">&lt;template&gt;</span>`,
      `  <span class="tok-key">&lt;main</span> <span class="tok-fn">class</span>=<span class="tok-str">"bookstore"</span><span class="tok-key">&gt;</span>`,
      `    <span class="tok-key">&lt;header</span> <span class="tok-fn">class</span>=<span class="tok-str">"top"</span><span class="tok-key">&gt;</span>`,
      `      <span class="tok-key">&lt;h1&gt;</span>夜航<span class="tok-key">&lt;em&gt;</span>书店<span class="tok-key">&lt;/em&gt;&lt;/h1&gt;</span>`,
      `      <span class="tok-key">&lt;p&gt;</span>{{ edition }} / 营业至 02:00<span class="tok-key">&lt;/p&gt;</span>`,
      `    <span class="tok-key">&lt;/header&gt;</span>`,
      `    <span class="tok-key">&lt;Hero</span> <span class="tok-fn">:books</span>=<span class="tok-str">"shelf"</span> <span class="tok-key">/&gt;</span>`,
      `    <span class="tok-key">&lt;section</span> <span class="tok-fn">class</span>=<span class="tok-str">"shelf"</span><span class="tok-key">&gt;</span>`,
      `      <span class="tok-key">&lt;article</span> <span class="tok-fn">v-for</span>=<span class="tok-str">"book in shelf"</span> <span class="tok-fn">:key</span>=<span class="tok-str">"book.isbn"</span><span class="tok-key">&gt;</span>`,
      `        <span class="tok-key">&lt;span&gt;</span>{{ book.no }}<span class="tok-key">&lt;/span&gt;</span>`,
      `        <span class="tok-key">&lt;strong&gt;</span>{{ book.title }}<span class="tok-key">&lt;/strong&gt;</span>`,
      `        <span class="tok-key">&lt;small&gt;</span>{{ book.author }} / {{ book.genre }}<span class="tok-key">&lt;/small&gt;</span>`,
      `      <span class="tok-key">&lt;/article&gt;</span>`,
      `    <span class="tok-key">&lt;/section&gt;</span>`,
      `  <span class="tok-key">&lt;/main&gt;</span>`,
      `<span class="tok-key">&lt;/template&gt;</span>`,
    ],
    'Hero.vue': [
      `<span class="tok-key">&lt;script setup lang="ts"&gt;</span>`,
      `<span class="tok-key">defineProps</span>&lt;{ books: Book[] }&gt;()`,
      `<span class="tok-com">&lt;/script&gt;</span>`,
      ``,
      `<span class="tok-key">&lt;template&gt;</span>`,
      `  <span class="tok-key">&lt;section</span> <span class="tok-fn">class</span>=<span class="tok-str">"hero"</span><span class="tok-key">&gt;</span>`,
      `    <span class="tok-key">&lt;p</span> <span class="tok-fn">class</span>=<span class="tok-str">"kicker"</span><span class="tok-key">&gt;</span>城市尽头 / 旧书与夜<span class="tok-key">&lt;/p&gt;</span>`,
      `    <span class="tok-key">&lt;h2&gt;</span>夜航<span class="tok-key">&lt;em&gt;</span>书店<span class="tok-key">&lt;/em&gt;&lt;/h2&gt;</span>`,
      `    <span class="tok-key">&lt;p</span> <span class="tok-fn">class</span>=<span class="tok-str">"lede"</span><span class="tok-key">&gt;</span>`,
      `      一家只卖旧书的店。没有畅销榜，只有从别人手里接过来的故事。`,
      `    <span class="tok-key">&lt;/p&gt;</span>`,
      `    <span class="tok-key">&lt;a</span> <span class="tok-fn">href</span>=<span class="tok-str">"#shelf"</span><span class="tok-key">&gt;</span>浏览本周书目 <span class="tok-key">&lt;span&gt;</span>→<span class="tok-key">&lt;/span&gt;&lt;/a&gt;</span>`,
      `  <span class="tok-key">&lt;/section&gt;</span>`,
      `<span class="tok-key">&lt;/template&gt;</span>`,
      ``,
      `<span class="tok-key">&lt;style scoped&gt;</span>`,
      `.hero { padding: 56px 44px; background: #0f1826; }`,
      `.hero h2 { font-family: "Noto Serif SC", serif; font-size: 88px; }`,
      `.hero em { color: #d8a24a; font-style: normal; }`,
      `<span class="tok-key">&lt;/style&gt;</span>`,
    ],
    'books.ts': [
      `<span class="tok-key">export interface</span> Book {`,
      `  no: <span class="tok-fn">string</span>`,
      `  title: <span class="tok-fn">string</span>`,
      `  author: <span class="tok-fn">string</span>`,
      `  genre: <span class="tok-fn">string</span>`,
      `  isbn: <span class="tok-fn">string</span>`,
      `}`,
      ``,
      `<span class="tok-key">export const</span> books: Book[] = [`,
      `  { no: <span class="tok-str">'01'</span>, title: <span class="tok-str">'夜航船'</span>, author: <span class="tok-str">'张岱'</span>, genre: <span class="tok-str">'文学'</span>, isbn: <span class="tok-str">'978-7-101'</span> },`,
      `  { no: <span class="tok-str">'02'</span>, title: <span class="tok-str">'看不见的城市'</span>, author: <span class="tok-str">'卡尔维诺'</span>, genre: <span class="tok-str">'小说'</span>, isbn: <span class="tok-str">'978-7-544'</span> },`,
      `  { no: <span class="tok-str">'03'</span>, title: <span class="tok-str">'漫长的告别'</span>, author: <span class="tok-str">'钱德勒'</span>, genre: <span class="tok-str">'小说'</span>, isbn: <span class="tok-str">'978-7-532'</span> },`,
      `]`,
    ],
  };

  /* screen ------------------------------------------------------------ */

  function setScreen(name) {
    state.screen = name;
    document.body.dataset.screen = name;
    els.home.hidden = name !== 'home';
    els.workspace.hidden = name !== 'workspace';
    closeNav();
    closeRail();
    closeDrawer(false);
    closeDispatch(false);
    if (name === 'workspace') {
      document.title = '夜航书店 · 派蒙暗房';
      if (location.hash !== '#workspace') setHash('#workspace');
      setPane(state.pane);
      requestAnimationFrame(() => els.title && els.title.focus({ preventScroll: true }));
    } else {
      document.title = '派蒙应用工坊 · 把想法，显影成东西。';
      if (location.hash === '#workspace') setHash(location.pathname + location.search);
      requestAnimationFrame(() => {
        const h = $('#hero-title');
        if (h) h.focus({ preventScroll: true });
      });
    }
  }

  function goHome() {
    setScreen('home');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function focusOrder() {
    if (state.screen !== 'home') setScreen('home');
    requestAnimationFrame(() => {
      const sheet = $('#contact-sheet');
      if (sheet) sheet.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        els.prompt.focus({ preventScroll: true });
        els.prompt.setSelectionRange(els.prompt.value.length, els.prompt.value.length);
      }, 260);
    });
  }

  /* nav sheet --------------------------------------------------------- */

  function openNav() {
    state.navOpen = true;
    els.navSheet.hidden = false;
    els.menuBtn.classList.add('is-open');
    els.menuBtn.setAttribute('aria-expanded', 'true');
    els.menuBtn.setAttribute('aria-label', '关闭菜单');
  }

  function closeNav() {
    if (!state.navOpen) return;
    state.navOpen = false;
    els.navSheet.hidden = true;
    els.menuBtn.classList.remove('is-open');
    els.menuBtn.setAttribute('aria-expanded', 'false');
    els.menuBtn.setAttribute('aria-label', '打开菜单');
  }

  function toggleNav() {
    if (state.navOpen) closeNav();
    else openNav();
  }

  /* samples ----------------------------------------------------------- */

  function cloneSample(name) {
    const source = document.querySelector(`.frame[data-sample="${name}"] .site`);
    if (!source) return null;
    const clone = source.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    clone.setAttribute('aria-hidden', 'true');
    return clone;
  }

  function selectSample(name, opts = {}) {
    const info = SAMPLE_INFO[name];
    if (!info) return;
    state.sample = name;
    $$('.film-item').forEach(btn => {
      const on = btn.dataset.sample === name;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    const clone = cloneSample(name);
    if (clone) {
      els.proofScreen.replaceChildren(clone);
      els.proofName.textContent = info.name;
      els.proofMeta.textContent = info.meta;
      els.proofGrease.textContent = info.grease;
      if (info.open) {
        els.proofOpen.href = '#workspace';
        els.proofOpen.dataset.screenLink = 'workspace';
        els.proofOpen.classList.remove('is-disabled');
        els.proofOpen.removeAttribute('aria-disabled');
        els.proofOpen.innerHTML = '打开第 041 卷 <span>→</span>';
      } else {
        els.proofOpen.removeAttribute('href');
        els.proofOpen.removeAttribute('data-screen-link');
        els.proofOpen.classList.add('is-disabled');
        els.proofOpen.setAttribute('aria-disabled', 'true');
        els.proofOpen.textContent = '样片仅展示';
      }
    }
    if (opts.scroll) {
      document.querySelector('#specimens').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* order + generation ------------------------------------------------ */

  function clearTimers() {
    state.timers.forEach(t => window.clearTimeout(t));
    state.timers = [];
  }

  function stampStatus(text, red = true) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.classList.toggle('stamp--red', red);
  }

  function updateVersionLabels(version) {
    const v = pad(version);
    $$('.js-run-no').forEach(n => { n.textContent = v; });
    $$('.js-proof-no').forEach(n => { n.textContent = v; });
    $$('.js-run-label').forEach(n => { n.textContent = `第 ${v} 次打样`; });
    $$('.js-rail-run').forEach(n => { n.textContent = `第 ${v} 次打样`; });
    const statusVersion = $('.js-current-version');
    if (statusVersion) statusVersion.textContent = `12 文件 / V${version}`;
    const composerVersion = $('.js-composer-version');
    if (composerVersion) composerVersion.textContent = `041 / V${version}`;
    if (els.printMeta) els.printMeta.textContent = state.view === 'code' ? 'VUE 3 / NEGATIVE' : state.device === 'mobile' ? '390 × 760 / 实时' : '1440 × 900 / 实时';
    const caption = $('.js-print-caption');
    if (caption) caption.textContent = `041-${pad(version)} / 夜航书店`;
    if (els.dispatchVersion) els.dispatchVersion.textContent = `V${version}`;
    $('.js-run-label')?.classList.add('is-new');
    window.setTimeout(() => $('.js-run-label')?.classList.remove('is-new'), 1000);
  }

  function resetSteps() {
    els.steps.forEach((step, i) => {
      step.classList.toggle('is-active', i === 0);
      step.classList.remove('is-done');
      const time = $('.step__time', step);
      if (time) time.textContent = i === 0 ? state.runTimes[0] : '—';
    });
    $('.js-develop-state').textContent = '显影中';
  }

  function setStep(index, done = true) {
    els.steps.forEach((step, i) => {
      step.classList.toggle('is-active', i === index && !done);
      if (i < index) step.classList.add('is-done');
      if (i === index && done) step.classList.add('is-done');
    });
    if (els.steps[index]) $('.step__time', els.steps[index]).textContent = state.runTimes[index] || '—';
  }

  function setProgress(pct) {
    if (els.printBar) els.printBar.style.width = `${pct}%`;
  }

  function applySite() {
    if (!els.previewSite) return;
    els.previewSite.dataset.theme = state.theme;
    els.previewSite.dataset.type = state.type;
    els.previewSite.dataset.extra = state.extra ? '1' : '0';
    const swatch = $('.file-card .swatch');
    const colors = {
      amber: ['#0f1826', '#d8a24a', '#f1e6d2'],
      moss: ['#12251d', '#b9caa4', '#edf0e2'],
      cobalt: ['#0c1730', '#7fa6ff', '#eef2ff'],
      paper: ['#efe8d9', '#a9543e', '#1b211d'],
    }[state.theme];
    if (swatch && colors) {
      $$('i', swatch).forEach((dot, i) => { dot.style.background = colors[i]; });
    }
  }

  function applyTheme(theme) {
    state.theme = theme;
    applySite();
  }

  function themeFromPrompt(prompt) {
    if (/墨绿|深绿|绿色|绿/.test(prompt)) return 'moss';
    if (/米白|浅色|白底|纸感/.test(prompt)) return 'paper';
    if (/蓝|深海|夜蓝/.test(prompt)) return 'cobalt';
    return state.theme || 'amber';
  }

  function addUserSlip(text) {
    const article = document.createElement('article');
    article.className = 'slip slip--user slip--dynamic';
    article.innerHTML = `
      <div class="slip__head"><span>委托方 / 苏</span><span class="mono">${demoTime()}</span></div>
      <p></p>
      <svg class="slip__clip" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 12.8V7.6a3.5 3.5 0 0 1 7 0v8.1a5.2 5.2 0 0 1-10.4 0V9.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
    $('p', article).textContent = text;
    els.develop.before(article);
    if (els.quick) els.chatScroll.insertBefore(els.develop, els.quick);
  }

  function addLabReply(text, facts = []) {
    const article = document.createElement('article');
    article.className = 'slip slip--lab slip--dynamic';
    article.innerHTML = `
      <div class="slip__head"><span><span class="seal seal--mini" aria-hidden="true">派</span>工坊 / 派蒙</span><span class="mono">${demoTime()}</span></div>
      <p></p>
      <div class="slip__facts"></div>
      <span class="slip__stamp" aria-hidden="true">第 ${pad(state.version)} 次</span>`;
    $('p', article).textContent = text;
    const factsEl = $('.slip__facts', article);
    facts.forEach(f => {
      const span = document.createElement('span');
      span.textContent = f;
      factsEl.appendChild(span);
    });
    els.develop.after(article);
    scrollChat();
  }

  function scrollChat() {
    if (!els.chatScroll) return;
    requestAnimationFrame(() => {
      els.chatScroll.scrollTo({ top: els.chatScroll.scrollHeight, behavior: 'smooth' });
    });
  }

  function startRun(prompt, { first = false } = {}) {
    if (state.generating) {
      toast('这一版还在显影，等它出来。');
      return;
    }
    clearTimers();
    state.prevVersion = state.version;
    state.prevTheme = state.theme;
    state.prevType = state.type;
    state.prevExtra = state.extra;
    state.generating = true;
    state.run += 1;
    state.version += 1;
    const prevTheme = state.theme;
    const prevType = state.type;
    const prevExtra = state.extra;
    state.theme = themeFromPrompt(prompt);
    if (/字体|衬线|无衬线/.test(prompt)) state.type = state.type === 'sans' ? 'serif' : 'sans';
    if (/活动|加一页/.test(prompt)) state.extra = true;
    applySite();
    stampStatus('制作中');
    if (els.liveStamp) {
      els.liveStamp.textContent = '制作中';
      els.liveStamp.classList.add('stamp--red');
    }
    updateVersionLabels(state.version);
    if (els.printMeta) els.printMeta.textContent = '显影中 / PROCESSING';
    state.runTimes = [demoTime(), demoTime(), demoTime(), demoTime()];
    resetSteps();
    $$('.roll.is-active .roll__state').forEach(n => { n.textContent = '制作中'; });
    setProgress(6);
    if (els.printLoading) {
      els.printLoading.hidden = false;
      els.printLoadingTitle.textContent = `第 ${pad(state.version)} 次打样`;
      els.printLoadingNote.textContent = '收到委托，准备曝光…';
    }
    if (els.printScreen) els.printScreen.scrollTop = 0;
    if (els.note) els.note.disabled = true;
    const send = $('.composer__send', els.chatForm);
    if (send) send.disabled = true;
    $$('#quick-replies button').forEach(b => { b.disabled = true; });

    const phase = [
      { delay: 520, step: 0, note: '收件，读取委托内容', pct: 22 },
      { delay: 1350, step: 1, note: '写入 12 个文件', pct: 48 },
      { delay: 2250, step: 2, note: '构建与校验通过', pct: 72 },
      { delay: 2950, step: 3, note: '预览已就绪，正在水洗', pct: 92 },
    ];
    phase.forEach((p, i) => {
      const t = window.setTimeout(() => {
        setStep(p.step, false);
        setProgress(p.pct);
        if (els.printLoadingNote) els.printLoadingNote.textContent = p.note;
        if (els.printLoading && p.step === 3) els.printLoadingNote.textContent = '水洗完成，抬出样张…';
      }, p.delay);
      state.timers.push(t);
    });

    const finish = window.setTimeout(() => {
      state.generating = false;
      setProgress(100);
      els.steps.forEach((step, i) => {
        step.classList.remove('is-active');
        step.classList.add('is-done');
        const time = $('.step__time', step);
        if (time && time.textContent === '—') time.textContent = state.runTimes[i] || '—';
      });
      if (els.printLoading) els.printLoading.hidden = true;
      stampStatus('已出片');
      if (els.liveStamp) {
        els.liveStamp.textContent = '实时';
      }
      if (els.printMeta) els.printMeta.textContent = state.device === 'mobile' ? '390 × 760 / 实时' : '1440 × 900 / 实时';
      if (els.developState) els.developState.textContent = '已定影';
      $$('.roll.is-active .roll__state').forEach(n => { n.textContent = '已出片'; });
      if (els.note) els.note.disabled = false;
      const sendBtn = $('.composer__send', els.chatForm);
      if (sendBtn) sendBtn.disabled = false;
      $$('#quick-replies button').forEach(b => { b.disabled = false; });
      addProofCard(state.version, state.theme, state.type !== prevType || (state.extra && !prevExtra) ? '按你的批注改了标题和活动页。' : state.theme !== prevTheme ? '按你的批注改了主色，书封和书目保留。' : '按你的批注重新显影。');
      const themeSentence = {
        amber: '底色保持夜蓝，书封的纸色不动。',
        moss: '主色换成了墨绿，书封的纸色保留。你看这一版是不是更沉一点。',
        paper: '换成米白纸感，夜里的对比会柔一些。书目页也一起调了。',
        cobalt: '底色用了深钴蓝，标题拉亮了一档。',
      };
      const changed = [];
      if (state.type !== prevType) changed.push(state.type === 'sans' ? '标题换成无衬线，字重拉满。' : '标题改回衬线，像旧书封面。');
      if (state.extra && !prevExtra) changed.push('在书目下面加了一页活动：10.31 深夜朗读。');
      if (state.theme !== prevTheme) changed.push(themeSentence[state.theme] || themeSentence.amber);
      if (!changed.length) changed.push('收到。这一版先把结构立住：首页、书目和到店信息都在，下一版再动细节。');
      const factTheme = { amber: '深蓝 / 琥珀', moss: '墨绿 / 书封', cobalt: '钴蓝 / 夜蓝', paper: '米白 / 纸感' }[state.theme] || '深蓝 / 琥珀';
      const facts = [factTheme];
      if (state.type === 'sans') facts.push('无衬线');
      if (state.extra) facts.push('活动页');
      facts.push('12 文件', `V${state.version}`);
      addLabReply(changed.join(' '), facts);
      if (state.extra && !prevExtra && els.printScreen) {
        requestAnimationFrame(() => els.printScreen.scrollTo({ top: els.printScreen.scrollHeight, behavior: 'smooth' }));
      }
      updateVersionLabels(state.version);
      updateVersionDrawer();
      scrollChat();
      toast(`第 ${pad(state.version)} 次打样好了。`);
    }, 3800);
    state.timers.push(finish);
  }

  function cancelRun() {
    if (!state.generating) return;
    clearTimers();
    state.generating = false;
    state.version = state.prevVersion;
    state.theme = state.prevTheme;
    state.type = state.prevType;
    state.extra = state.prevExtra;
    applySite();
    if (els.printLoading) els.printLoading.hidden = true;
    state.timers = [];
    stampStatus('已出片');
    if (els.liveStamp) els.liveStamp.textContent = '暂停';
    if (els.printMeta) els.printMeta.textContent = state.device === 'mobile' ? '390 × 760 / 已暂停' : '1440 × 900 / 已暂停';
    if (els.developState) els.developState.textContent = '已取消';
    $$('.roll.is-active .roll__state').forEach(n => { n.textContent = '已出片'; });
    if (els.note) els.note.disabled = false;
    const sendBtn = $('.composer__send', els.chatForm);
    if (sendBtn) sendBtn.disabled = false;
    $$('#quick-replies button').forEach(b => { b.disabled = false; });
    updateVersionLabels(state.version);
    setProgress(0);
    toast('已暂停这一版。上一版还在。');
  }

  function submitOrder(event) {
    event.preventDefault();
    const prompt = els.prompt.value.trim();
    if (!prompt) {
      toast('先写一句要做什么，再送洗。');
      els.prompt.focus();
      return;
    }
    if (els.order.classList.contains('is-stamping')) return;
    els.order.classList.add('is-stamping');
    els.orderBtn.disabled = true;
    state.theme = 'amber';
    state.type = 'serif';
    state.extra = false;
    applySite();
    els.chatSeed.textContent = prompt;
    setScreen('workspace');
    window.setTimeout(() => {
      els.order.classList.remove('is-stamping');
      els.orderBtn.disabled = false;
      startRun(prompt, { first: true });
    }, 720);
  }

  function addProofCard(version, theme, note) {
    const body = $('.drawer__body', els.versions);
    if (!body) return;
    const existing = body.querySelector(`.proof-card[data-version="${version}"]`);
    if (existing) {
      // Re-running the same version: keep the existing card, mark current.
      return;
    }
    const card = document.createElement('article');
    card.className = 'proof-card';
    card.dataset.version = String(version);
    card.dataset.theme = theme;
    card.dataset.type = state.type;
    card.dataset.extra = state.extra ? '1' : '0';
    const thumb = { amber: 'amber', moss: 'moss', cobalt: 'cobalt', paper: 'paper' }[theme] || 'amber';
    card.innerHTML = `
      <div class="proof-card__thumb"><div class="thumb thumb--${thumb}"><span>夜航</span><em>书店</em><small>NIGHT FLIGHT</small></div><span class="proof-card__current">当前</span></div>
      <div class="proof-card__meta">
        <header><strong>V${version}</strong><span class="mono">${DEMO_DATE} / ${demoTime()}</span></header>
        <p></p>
        <button type="button" data-restore="${version}">取回这一版</button>
      </div>`;
    $('p', card).textContent = note;
    body.prepend(card);
    $$('.proof-card').forEach(c => c.classList.remove('is-current'));
    card.classList.add('is-current');
    $$('.proof-card:not([data-void]) .proof-card__current').forEach(c => c.hidden = true);
    $('.proof-card__current', card).hidden = false;
    $$('.proof-card__meta button').forEach(b => { b.disabled = false; });
    $('.proof-card__meta button', card).disabled = true;
  }

  function updateVersionDrawer() {
    const count = $$('.proof-card:not([data-void])', els.versions).length;
    const countEl = $('.js-proof-count');
    if (countEl) countEl.textContent = `041 / 夜航书店 / ${count} 张 + 1 张废片`;
    $$('.proof-card', els.versions).forEach(card => {
      if (card.dataset.void) return;
      const v = Number(card.dataset.version);
      const current = v === state.version;
      card.classList.toggle('is-current', current);
      const mark = $('.proof-card__current', card);
      if (mark) mark.hidden = !current;
      const btn = $('.proof-card__meta button', card);
      if (btn) btn.disabled = current;
    });
  }

  function restoreVersion(version) {
    if (state.generating) { toast('等这一版定影，再取回旧样张。'); return; }
    const card = els.versions.querySelector(`.proof-card[data-version="${version}"]`);
    if (!card) return;
    state.version = version;
    const theme = THEMES[version] || card.dataset.theme || 'amber';
    state.type = card.dataset.type || 'serif';
    state.extra = card.dataset.extra === '1';
    applyTheme(theme);
    updateVersionLabels(version);
    stampStatus('已出片');
    if (els.liveStamp) els.liveStamp.textContent = '实时';
    if (els.printMeta) els.printMeta.textContent = state.device === 'mobile' ? '390 × 760 / 实时' : '1440 × 900 / 实时';
    if (els.developState) els.developState.textContent = '已定影';
    updateVersionDrawer();
    closeDrawer();
    toast(`已取回 V${version}。当前样张已经切换。`);
  }

  /* drawer, dispatch, toast ------------------------------------------ */

  function openDrawer(trigger) {
    if (state.generating) {
      // Keep the drawer reachable while a proof develops; no blocking.
    }
    state.trigger = trigger || document.activeElement;
    updateVersionDrawer();
    els.versions.classList.add('is-open');
    els.versions.setAttribute('aria-hidden', 'false');
    els.scrim.hidden = false;
    document.body.classList.add('has-overlay');
    const close = $('.drawer__close', els.versions);
    window.setTimeout(() => close && close.focus({ preventScroll: true }), 40);
    document.addEventListener('keydown', trapDrawer);
  }

  function closeDrawer(restore = true) {
    if (!els.versions.classList.contains('is-open')) return;
    els.versions.classList.remove('is-open');
    els.versions.setAttribute('aria-hidden', 'true');
    if (!state.dispatchOpen) els.scrim.hidden = true;
    document.body.classList.remove('has-overlay');
    document.removeEventListener('keydown', trapDrawer);
    if (restore && state.trigger && state.trigger.focus) {
      state.trigger.focus({ preventScroll: true });
    }
  }

  function trapDrawer(e) {
    if (e.key !== 'Tab') return;
    const nodes = $$('button, [href], textarea, input, [tabindex]:not([tabindex="-1"])', els.versions).filter(n => !n.disabled && n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openDispatch(trigger) {
    if (state.generating) { toast('等这一版定影，再寄出。'); return; }
    state.trigger = trigger || document.activeElement;
    state.dispatchOpen = true;
    els.dispatch.hidden = false;
    if (els.dispatchVersion) els.dispatchVersion.textContent = `V${state.version}`;
    if (els.dispatchUrl) els.dispatchUrl.textContent = `https://yewhang.paimeng.workshop${state.version > 4 ? '/v' + state.version : ''}`;
    buildQR();
    const close = $('.receipt__close', els.dispatch);
    window.setTimeout(() => close && close.focus({ preventScroll: true }), 40);
    document.addEventListener('keydown', trapModal);
  }

  function closeDispatch(restore = true) {
    if (els.dispatch.hidden) return;
    state.dispatchOpen = false;
    els.dispatch.hidden = true;
    document.removeEventListener('keydown', trapModal);
    if (restore && state.trigger && state.trigger.focus) state.trigger.focus({ preventScroll: true });
  }

  function trapModal(e) {
    if (e.key !== 'Tab') return;
    const nodes = $$('button, [href], textarea, input, [tabindex]:not([tabindex="-1"])', els.dispatch).filter(n => !n.disabled && n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function buildQR() {
    if (!els.qr || els.qr.childNodes.length) return;
    const size = 21;
    const cells = [];
    const seed = (x, y) => {
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      return n - Math.floor(n);
    };
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const finder =
          (x < 7 && y < 7) ||
          (x > 13 && y < 7) ||
          (x < 7 && y > 13);
        if (finder) {
          const lx = x > 13 ? x - 14 : x;
          const ly = y > 13 ? y - 14 : y;
          const ring = lx >= 1 && lx <= 5 && ly >= 1 && ly <= 5 && (lx === 1 || lx === 5 || ly === 1 || ly === 5);
          const core = lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4;
          if (ring || core) cells.push([x, y]);
          continue;
        }
        if (seed(x, y) > 0.54) cells.push([x, y]);
      }
    }
    const rects = cells.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1"/>`).join('');
    els.qr.innerHTML = `<rect width="21" height="21" fill="#fff"/>${rects}`;
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => els.toast.classList.remove('is-visible'), 2800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制。');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast('已复制。');
      } catch (e) {
        toast('复制失败，请手动选择地址。');
      }
      ta.remove();
    }
  }

  /* rail, panes, splitter --------------------------------------------- */

  function updateRailInert() {
    if (!els.rail) return;
    els.rail.inert = window.innerWidth <= 980 && !state.railOpen;
  }

  function setRail(open) {
    state.railOpen = open;
    updateRailInert();
    els.rail.classList.toggle('is-open', open);
    els.railScrim.hidden = !open;
    els.railMenu.setAttribute('aria-expanded', String(open));
    if (open) {
      const active = $('.roll.is-active', els.rail);
      window.setTimeout(() => active && active.focus({ preventScroll: true }), 60);
    }
  }

  function closeRail() { if (state.railOpen) setRail(false); }

  function setPane(pane) {
    state.pane = pane;
    els.workspace.dataset.pane = pane;
    $$('.ws__mobile-tabs button').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.pane === pane);
      btn.setAttribute('aria-pressed', String(btn.dataset.pane === pane));
    });
  }

  function setView(view) {
    state.view = view;
    $$('.lt__tab').forEach(btn => {
      const on = btn.dataset.view === view;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    const device = $('.lt__device');
    const ltStatus = $('#lt-status');
    if (view === 'code') {
      els.print.hidden = true;
      els.negative.hidden = false;
      if (device) device.hidden = true;
      renderCode('App.vue');
      if (els.ltState) els.ltState.textContent = '负片 / SRC';
      if (els.printMeta) els.printMeta.textContent = 'VUE 3 / NEGATIVE';
      if (els.liveStamp) els.liveStamp.textContent = '负片';
      if (ltStatus) ltStatus.innerHTML = '<i class="live-dot"></i>负片 / 源码';
    } else {
      els.print.hidden = false;
      els.negative.hidden = true;
      if (device) device.hidden = false;
      if (els.ltState) els.ltState.textContent = state.device === 'mobile' ? '390 × 760' : '1440 × 900';
      if (els.printMeta) els.printMeta.textContent = state.device === 'mobile' ? '390 × 760 / 实时' : '1440 × 900 / 实时';
      if (els.liveStamp) els.liveStamp.textContent = '实时';
      if (ltStatus) ltStatus.innerHTML = '<i class="live-dot"></i>预览就绪 / 21:05';
    }
  }

  function setDevice(device) {
    state.device = device;
    els.print.dataset.device = device;
    $$('.lt__device button').forEach(btn => {
      const on = btn.dataset.device === device;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    if (els.ltState && state.view === 'preview') els.ltState.textContent = device === 'mobile' ? '390 × 760' : '1440 × 900';
    if (els.printMeta && state.view === 'preview') els.printMeta.textContent = device === 'mobile' ? '390 × 760 / 实时' : '1440 × 900 / 实时';
  }

  function renderCode(file) {
    const lines = CODE[file] || [];
    els.codeView.innerHTML = lines.map((line, i) => `<span class="ln">${pad(i + 1)}</span>${line}`).join('\n');
    $$('.negative__files button').forEach(btn => btn.classList.toggle('is-active', btn.dataset.file === file));
  }

  function setupSplitter() {
    let dragging = false;
    const body = els.wsBody;
    const update = clientX => {
      const rect = body.getBoundingClientRect();
      const pct = clamp(((clientX - rect.left) / rect.width) * 100, 30, 55);
      body.style.setProperty('--chat-w', `${pct}%`);
      els.splitter.setAttribute('aria-valuenow', String(Math.round(pct)));
    };
    els.splitter.addEventListener('pointerdown', e => {
      dragging = true;
      els.splitter.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    els.splitter.addEventListener('pointermove', e => {
      if (!dragging) return;
      update(e.clientX);
    });
    const stop = () => {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    els.splitter.addEventListener('pointerup', stop);
    els.splitter.addEventListener('pointercancel', stop);
    els.splitter.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const current = Number(els.splitter.getAttribute('aria-valuenow')) || 42;
      const next = clamp(current + (e.key === 'ArrowRight' ? 2 : -2), 30, 55);
      body.style.setProperty('--chat-w', `${next}%`);
      els.splitter.setAttribute('aria-valuenow', String(next));
    });
  }

  /* events ------------------------------------------------------------ */

  document.addEventListener('click', e => {
    const screenLink = e.target.closest('[data-screen-link]');
    if (screenLink) {
      e.preventDefault();
      const target = screenLink.dataset.screenLink;
      if (target === 'workspace') {
        if (state.screen !== 'workspace') setScreen('workspace');
        closeNav();
      } else {
        setScreen('home');
      }
      return;
    }
    const close = e.target.closest('[data-close]');
    if (close) {
      e.preventDefault();
      if (state.dispatchOpen) closeDispatch();
      else closeDrawer();
      return;
    }
    const fill = e.target.closest('[data-fill]');
    if (fill) {
      e.preventDefault();
      els.note.value = fill.dataset.fill;
      els.note.focus();
      els.note.setSelectionRange(els.note.value.length, els.note.value.length);
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.preventDefault();
      copyText(els.dispatchUrl.textContent.trim());
      return;
    }
    const retry = e.target.closest('[data-retry]');
    if (retry) {
      e.preventDefault();
      closeDrawer(false);
      if (state.screen !== 'workspace') setScreen('workspace');
      els.note.value = '按上一版的批注重新打样，不换主色。';
      els.note.focus();
      toast('上一版的批注放回输入框；发送就重开一版。');
      return;
    }
    const restore = e.target.closest('[data-restore]');
    if (restore && !restore.disabled) {
      e.preventDefault();
      restoreVersion(Number(restore.dataset.restore));
      return;
    }
    const testToast = e.target.closest('[data-toast]');
    if (testToast) {
      e.preventDefault();
      toast(testToast.dataset.toast);
      return;
    }
    const action = e.target.closest('[data-action]');
    if (action) {
      const kind = action.dataset.action;
      if (kind === 'focus-order') { e.preventDefault(); closeNav(); focusOrder(); }
      if (kind === 'nav') { e.preventDefault(); toggleNav(); }
      if (kind === 'versions') { e.preventDefault(); openDrawer(action); }
      if (kind === 'dispatch') { e.preventDefault(); openDispatch(action); }
      if (kind === 'dispatch-go') { e.preventDefault(); toast('演示地址，不会打开真实站点。'); }
      if (kind === 'new-order') { e.preventDefault(); closeRail(); focusOrder(); }
      if (kind === 'rail') { e.preventDefault(); setRail(!state.railOpen); }
      return;
    }
    if (e.target === els.scrim) closeDrawer();
    if (e.target === els.railScrim) closeRail();
    if (e.target === els.dispatch) closeDispatch();
    if (state.navOpen && !e.target.closest('.letterhead') && !e.target.closest('.nav-sheet')) closeNav();
  });

  els.order.addEventListener('submit', submitOrder);
  els.prompt.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      els.order.requestSubmit();
    }
  });

  $$('.film-item').forEach(btn => {
    btn.addEventListener('click', () => selectSample(btn.dataset.sample));
    btn.addEventListener('keydown', e => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const items = $$('.film-item');
      const i = items.indexOf(btn);
      const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
      selectSample(items[next].dataset.sample);
    });
  });

  $$('.nav-sheet a').forEach(link => link.addEventListener('click', () => window.setTimeout(closeNav, 0)));

  $$('.roll').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('is-active')) return;
      toast('演示只展开第 041 卷。其他工单是样品。');
    });
  });

  $$('.archive tbody tr').forEach(row => {
    row.addEventListener('click', () => {
      if (row.dataset.app === '041') setScreen('workspace');
      else toast('演示档案，只有第 041 卷可以打开。');
    });
    row.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      row.click();
    });
  });

  $$('.lt__tab').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $$('.lt__device button').forEach(btn => btn.addEventListener('click', () => setDevice(btn.dataset.device)));
  $$('.negative__files button').forEach(btn => btn.addEventListener('click', () => renderCode(btn.dataset.file)));
  $$('.ws__mobile-tabs button').forEach(btn => btn.addEventListener('click', () => setPane(btn.dataset.pane)));

  els.chatForm.addEventListener('submit', e => {
    e.preventDefault();
    if (state.generating) { toast('这一版还在显影，等它出来。'); return; }
    const text = els.note.value.trim();
    if (!text) { toast('写一句要改的地方。'); els.note.focus(); return; }
    addUserSlip(text);
    els.note.value = '';
    startRun(text);
  });

  els.note.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.chatForm.requestSubmit();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      els.chatForm.requestSubmit();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (state.dispatchOpen) { closeDispatch(); return; }
      if (els.versions.classList.contains('is-open')) { closeDrawer(); return; }
      if (state.railOpen) { closeRail(); return; }
      if (state.navOpen) { closeNav(); return; }
      if (state.generating) { cancelRun(); return; }
      els.toast.classList.remove('is-visible');
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      focusOrder();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 980 && state.railOpen) setRail(false);
    updateRailInert();
  });

  window.addEventListener('hashchange', () => {
    if (location.hash === '#workspace' && state.screen !== 'workspace') setScreen('workspace');
  });

  /* boot -------------------------------------------------------------- */

  function boot() {
    selectSample('bookstore');
    setView('preview');
    setDevice('desktop');
    setPane('preview');
    updateRailInert();
    updateVersionDrawer();
    setupSplitter();
    renderCode('App.vue');
    buildQR();
    if (location.hash === '#workspace') setScreen('workspace');
    else setScreen('home');
    // The circled frame gets a small develop-in after the circle draws.
    window.setTimeout(() => {
      const picked = $('.frame--picked .site');
      if (picked) picked.classList.add('is-developed');
    }, 700);
  }

  boot();
})();
