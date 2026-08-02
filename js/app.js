/* ==================== 应用主逻辑 ==================== */

// ===== 全局状态 =====
let currentView = 'daily';
let currentDate = new Date();
let timerInterval = null;
let timerSeconds = 0;
let timerTaskId = null;
let calendarMonth = new Date();
let acctTab = 'expense'; // expense | income
let accountingCategory = '餐饮';
let momentsCategory = '专业科普';
let exerciseCategory = '全身';

// ===== LocalStorage 管理 =====
const Store = {
  get(key, def) {
    try { const v = localStorage.getItem('mm_' + key); return v ? JSON.parse(v) : def; }
    catch(e) { return def; }
  },
  set(key, val) { localStorage.setItem('mm_' + key, JSON.stringify(val)); },
  del(key) { localStorage.removeItem('mm_' + key); }
};

// 获取今日日期键
function todayKey() { return formatDate(new Date()); }

// ===== 初始化 =====
function init() {
  renderMenu();
  setupEvents();
  switchView('daily');
  checkReminders();
  // 每分钟检查提醒
  setInterval(checkReminders, 60000);
}

// ===== 菜单渲染 =====
function renderMenu() {
  const menuEl = document.getElementById('drawerMenu');
  menuEl.innerHTML = MENU.map(m => `
    <div class="menu-item ${m.id === currentView ? 'active' : ''}" data-view="${m.id}">
      <span class="menu-icon">${m.icon}</span>
      <span>${m.name}</span>
    </div>
  `).join('');
  menuEl.querySelectorAll('.menu-item').forEach(el => {
    el.addEventListener('click', () => {
      switchView(el.dataset.view);
      closeDrawer();
    });
  });
  updateDrawerStats();
}

function updateDrawerStats() {
  const tasks = getTasks();
  const completions = Store.get('completions', {});
  const today = todayKey();
  const done = (completions[today] || []).filter(id => tasks.some(t => t.id === id)).length;
  document.getElementById('todayProgress').textContent = `今日完成 ${done}/${tasks.length}`;
}

// ===== 抽屉控制 =====
function openDrawer() {
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('open');
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
}

// ===== 事件绑定 =====
function setupEvents() {
  document.getElementById('menuToggle').addEventListener('click', openDrawer);
  document.getElementById('drawerOverlay').addEventListener('click', closeDrawer);
  document.getElementById('dateToggle').addEventListener('click', () => {
    showToast('今天是 ' + formatDate(new Date()) + ' ' + getWeekday(new Date()));
  });
}

// ===== 视图切换 =====
function switchView(viewId) {
  currentView = viewId;
  document.querySelectorAll('.view').forEach(v => v.remove());
  const menu = MENU.find(m => m.id === viewId);
  document.getElementById('topbarTitle').textContent = menu ? menu.name : '';
  document.querySelectorAll('.menu-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewId);
  });
  const content = document.getElementById('content');
  const view = document.createElement('section');
  view.className = 'view active';
  view.id = 'view-' + viewId;
  content.appendChild(view);

  switch(viewId) {
    case 'daily': renderDaily(view); break;
    case 'customers': renderCustomers(view); break;
    case 'skin': renderKnowledge(view, SKIN_DATA, '皮肤专业知识'); break;
    case 'photoelectric': renderKnowledge(view, PHOTO_DATA, '光电专业知识'); break;
    case 'waterlight': renderKnowledge(view, WATER_DATA, '水光产品知识'); break;
    case 'injection': renderKnowledge(view, INJECT_DATA, '注射微整知识'); break;
    case 'ingredient': renderKnowledge(view, INGREDIENT_DATA, '护肤成分知识'); break;
    case 'aesthetic': renderKnowledge(view, AESTHETIC_DATA, '美学设计理念'); break;
    case 'moments': renderMoments(view); break;
    case 'exercise': renderExercise(view); break;
    case 'english': renderEnglish(view); break;
    case 'finance': renderFinance(view); break;
    case 'psychology': renderKnowledge(view, PSYCHOLOGY_DATA, '心理学知识'); break;
    case 'calendar': renderCalendar(view); break;
    case 'accounting': renderAccounting(view); break;
    case 'creation': renderCreation(view); break;
    case 'settings': renderSettings(view); break;
  }
}

// ===== 获取任务列表 =====
function getTasks() {
  return Store.get('tasks', DEFAULT_TASKS);
}

// ===== 每日工作视图 =====
function renderDaily(view) {
  const tasks = getTasks();
  const completions = Store.get('completions', {});
  const leaves = Store.get('leaves', {});
  const today = todayKey();
  const doneList = completions[today] || [];
  const isOnLeave = leaves[today] || false;

  const doneCount = doneList.filter(id => tasks.some(t => t.id === id)).length;
  const total = tasks.length;
  const progressPct = total > 0 ? (doneCount / total) : 0;
  const circumference = 2 * Math.PI * 26;
  const dashOffset = circumference * (1 - progressPct);

  let html = `
    <div class="date-banner">
      <div>
        <div class="date-num">${new Date().getDate()}</div>
        <div class="date-month">${new Date().getMonth() + 1}月 · ${getWeekday(new Date())}</div>
      </div>
      <div class="progress-ring">
        <svg width="60" height="60">
          <circle class="bg-circle" cx="30" cy="30" r="26"/>
          <circle class="fg-circle" cx="30" cy="30" r="26" stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"/>
        </svg>
        <div class="progress-text">${doneCount}/${total}</div>
      </div>
    </div>
  `;

  if (isOnLeave) {
    html += `
      <div class="leave-bar">
        <span class="leave-icon">🏖️</span>
        <span class="leave-text">今日已请假，任务自动顺延一天</span>
        <button class="btn btn-sm btn-outline leave-btn" onclick="cancelLeave()">取消请假</button>
      </div>
    `;
  } else {
    html += `
      <div class="leave-bar" style="border-color: var(--lavender); background: var(--lavender-light);">
        <span class="leave-icon">📋</span>
        <span class="leave-text" style="color: var(--lavender);">完成每项任务后打勾，未完成将12:00和16:00提醒</span>
        <button class="btn btn-sm btn-outline leave-btn" style="border-color: var(--lavender); color: var(--lavender);" onclick="takeLeave()">请假</button>
      </div>
    `;
  }

  html += '<div class="section-title">今日任务清单</div>';
  html += tasks.map(t => {
    const isDone = doneList.includes(t.id);
    return `
      <div class="task-item ${isDone ? 'completed' : ''}">
        <div class="task-check ${isDone ? 'checked' : ''}" onclick="toggleTask('${t.id}')">${isDone ? '✓' : ''}</div>
        <div class="task-body">
          <div class="task-title">${t.icon || ''} ${t.title}</div>
          <div class="task-desc">${t.desc || ''}</div>
        </div>
        ${t.timed ? `<button class="task-timer-btn" onclick="startTimer('${t.id}', '${t.title}')">⏱ 计时</button>` : ''}
      </div>
    `;
  }).join('');

  view.innerHTML = html;
  updateDrawerStats();
}

// ===== 任务勾选 =====
function toggleTask(taskId) {
  const completions = Store.get('completions', {});
  const today = todayKey();
  if (!completions[today]) completions[today] = [];
  const idx = completions[today].indexOf(taskId);
  if (idx >= 0) {
    completions[today].splice(idx, 1);
  } else {
    completions[today].push(taskId);
    speak('完成，继续加油');
    // 检查是否全部完成
    const tasks = getTasks();
    if (completions[today].length >= tasks.length) {
      setTimeout(() => speak('今天的任务全部完成啦，辛苦了'), 500);
    }
  }
  Store.set('completions', completions);
  renderDaily(document.getElementById('view-daily'));
}

// ===== 请假 =====
function takeLeave() {
  const leaves = Store.get('leaves', {});
  leaves[todayKey()] = true;
  Store.set('leaves', leaves);
  speak('已请假，好好休息');
  renderDaily(document.getElementById('view-daily'));
}
function cancelLeave() {
  const leaves = Store.get('leaves', {});
  delete leaves[todayKey()];
  Store.set('leaves', leaves);
  renderDaily(document.getElementById('view-daily'));
}

// ===== 提醒检查 =====
function checkReminders() {
  const now = new Date();
  const hour = now.getHours();
  const today = todayKey();
  const leaves = Store.get('leaves', {});
  if (leaves[today]) return; // 请假不提醒

  const tasks = getTasks();
  const completions = Store.get('completions', {});
  const doneList = completions[today] || [];
  const undone = tasks.filter(t => !doneList.includes(t.id));
  if (undone.length === 0) return;

  const reminders = Store.get('reminders', {});
  const reminderKey = today + '_' + hour;
  if (reminders[reminderKey]) return; // 已提醒过

  if (hour === 12) {
    reminders[reminderKey] = true;
    Store.set('reminders', reminders);
    speak('提醒你，还有' + undone.length + '个任务未完成，加油哦');
    showToast('⏰ 还有 ' + undone.length + ' 个任务未完成');
  } else if (hour === 16) {
    reminders[reminderKey] = true;
    Store.set('reminders', reminders);
    speak('下午提醒，还有' + undone.length + '个任务待完成');
    showToast('⏰ 还有 ' + undone.length + ' 个任务未完成');
  }
}

// ===== 计时器 =====
function startTimer(taskId, taskTitle) {
  // 如果已有计时器在运行，先停止
  if (timerInterval) { stopTimer(false); }
  timerTaskId = taskId;
  timerSeconds = 0;
  const floatEl = document.getElementById('timerFloat');
  floatEl.style.display = 'block';
  updateTimerDisplay(taskTitle);
  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay(taskTitle);
  }, 1000);
}

function updateTimerDisplay(taskTitle) {
  const h = String(Math.floor(timerSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((timerSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(timerSeconds % 60).padStart(2, '0');
  document.getElementById('timerFloatInner').innerHTML = `
    <div class="tf-label">${taskTitle.length > 12 ? taskTitle.slice(0,12) + '...' : taskTitle}</div>
    <div class="tf-time">${h}:${m}:${s}</div>
    <div class="tf-btns">
      <button class="tf-btn" onclick="stopTimer(true)">⏹</button>
    </div>
  `;
}

function stopTimer(speakResult) {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (speakResult && timerSeconds > 0) {
    const m = Math.floor(timerSeconds / 60);
    speak('计时结束，用时' + m + '分钟' + (timerSeconds % 60) + '秒');
    showToast('计时结束：' + Math.floor(timerSeconds/60) + '分' + (timerSeconds%60) + '秒');
  }
  timerSeconds = 0;
  timerTaskId = null;
  document.getElementById('timerFloat').style.display = 'none';
}

// ===== 知识推荐视图 =====
function renderKnowledge(view, data, title) {
  const items = getDailyItems(data, new Date(), 10);
  let html = `
    <div class="refresh-bar">
      <div class="rb-title">${title}</div>
      <button class="refresh-btn" id="refreshBtn" onclick="refreshKnowledge('${title}')">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 0 1-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        换一批
      </button>
    </div>
    <div class="section-title">今日推荐 ${items.length} 条</div>
  `;
  html += items.map(item => `
    <div class="knowledge-card">
      <img class="kc-image" src="${item.image}" alt="${item.title}">
      <div class="kc-body">
        <div class="kc-title">${item.title}</div>
        <div class="kc-summary">${item.summary}</div>
        <div class="kc-tags">${(item.tags||[]).map(t => `<span class="tag tag-${tagColor(t)}">${t}</span>`).join('')}</div>
        <div class="kc-footer">
          <span class="kc-source">📌 ${item.source || ''}</span>
          <div class="kc-actions">
            <button class="kc-action-btn" onclick="speak('${item.title.replace(/'/g, "\\'")}')">🔊 听</button>
            <button class="kc-action-btn" onclick="copyText('${(item.title + ' - ' + item.summary).replace(/'/g, "\\'").replace(/\n/g, '\\n')}')">📋 复制</button>
          </div>
        </div>
      </div>
    </div>
  `).join('');
  view.innerHTML = html;
}

function tagColor(tag) {
  const map = { '解剖学': 'purple', '病理': 'pink', '新品': 'orange', '国产': 'green', '射频': 'blue', '超声': 'blue' };
  return map[tag] || 'pink';
}

let knowledgeRefreshSeed = 0;
function refreshKnowledge(title) {
  const btn = document.getElementById('refreshBtn');
  if (btn) { btn.classList.add('spinning'); }
  knowledgeRefreshSeed++;
  setTimeout(() => {
    const view = document.getElementById('view-' + currentView);
    const dataMap = {
      '皮肤专业知识': SKIN_DATA, '光电专业知识': PHOTO_DATA, '水光产品知识': WATER_DATA,
      '注射微整知识': INJECT_DATA, '护肤成分知识': INGREDIENT_DATA, '美学设计理念': AESTHETIC_DATA,
      '心理学知识': PSYCHOLOGY_DATA
    };
    const data = dataMap[title];
    if (data) {
      const seed = new Date().getTime() + knowledgeRefreshSeed * 137;
      const items = [];
      const total = data.length;
      for (let i = 0; i < 10; i++) {
        items.push(data[(seed + i * 37) % total]);
      }
      renderKnowledgeItems(view, items, title);
    }
    if (btn) { btn.classList.remove('spinning'); }
    speak('已更新');
  }, 600);
}

function renderKnowledgeItems(view, items, title) {
  let html = `
    <div class="refresh-bar">
      <div class="rb-title">${title}</div>
      <button class="refresh-btn" id="refreshBtn" onclick="refreshKnowledge('${title}')">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 0 1-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        换一批
      </button>
    </div>
    <div class="section-title">今日推荐 ${items.length} 条</div>
  `;
  html += items.map(item => `
    <div class="knowledge-card">
      <img class="kc-image" src="${item.image}" alt="${item.title}">
      <div class="kc-body">
        <div class="kc-title">${item.title}</div>
        <div class="kc-summary">${item.summary}</div>
        <div class="kc-tags">${(item.tags||[]).map(t => `<span class="tag tag-${tagColor(t)}">${t}</span>`).join('')}</div>
        <div class="kc-footer">
          <span class="kc-source">📌 ${item.source || ''}</span>
          <div class="kc-actions">
            <button class="kc-action-btn" onclick="speak('${item.title.replace(/'/g, "\\'")}')">🔊 听</button>
            <button class="kc-action-btn" onclick="copyText('${(item.title + ' - ' + item.summary).replace(/'/g, "\\'").replace(/\n/g, '\\n')}')">📋 复制</button>
          </div>
        </div>
      </div>
    </div>
  `).join('');
  view.innerHTML = html;
}

// ===== 朋友圈文案视图 =====
function renderMoments(view) {
  const cats = Object.keys(MOMENTS_DATA);
  let html = `
    <div class="refresh-bar">
      <div class="rb-title">朋友圈文案图片</div>
      <button class="refresh-btn" id="momentsRefresh" onclick="refreshMoments()">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 0 1-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        换一批
      </button>
    </div>
  `;
  html += `<div class="category-bar">`;
  html += cats.map(c => `<div class="category-chip ${c === momentsCategory ? 'active' : ''}" onclick="switchMomentsCategory('${c}')">${c}</div>`).join('');
  html += `</div>`;
  html += renderMomentsList(momentsCategory);
  view.innerHTML = html;
}

function renderMomentsList(cat) {
  const items = getDailyMoments(cat, 10);
  return `<div id="momentsList">` + items.map(item => `
    <div class="moments-card">
      <img class="mc-image" src="${item.image}" alt="">
      <div class="mc-body">
        <div class="mc-text">${item.text}</div>
        <div class="mc-tags">${(item.tags||[]).map(t => `<span class="tag tag-pink">${t}</span>`).join('')}</div>
        <div class="mc-actions">
          <button class="kc-action-btn" onclick="speak('${item.text.replace(/'/g, "\\'").replace(/\n/g, ' ')}')">🔊 听</button>
          <button class="kc-action-btn" onclick="copyText('${item.text.replace(/'/g, "\\'").replace(/\n/g, '\\n')}')">📋 复制文案</button>
        </div>
      </div>
    </div>
  `).join('') + `</div>`;
}

let momentsRefreshSeed = 0;
function getDailyMoments(cat, count) {
  const all = MOMENTS_DATA[cat] || [];
  const seed = getDayOfYear(new Date()) + momentsRefreshSeed * 31 + cat.length * 7;
  const result = [];
  for (let i = 0; i < count; i++) {
    if (all.length === 0) break;
    result.push(all[(seed + i) % all.length]);
  }
  return result;
}

function switchMomentsCategory(cat) {
  momentsCategory = cat;
  momentsRefreshSeed = 0;
  const view = document.getElementById('view-moments');
  renderMoments(view);
}

function refreshMoments() {
  const btn = document.getElementById('momentsRefresh');
  if (btn) btn.classList.add('spinning');
  momentsRefreshSeed++;
  setTimeout(() => {
    const listEl = document.getElementById('momentsList');
    if (listEl) {
      listEl.outerHTML = renderMomentsList(momentsCategory);
    }
    if (btn) btn.classList.remove('spinning');
    speak('已更新');
  }, 500);
}

// ===== 运动视频视图 =====
function renderExercise(view) {
  const cats = Object.keys(EXERCISE_DATA);
  let html = `<div class="refresh-bar"><div class="rb-title">运动拉伸视频</div></div>`;
  html += `<div class="category-bar">`;
  html += cats.map(c => `<div class="category-chip ${c === exerciseCategory ? 'active' : ''}" onclick="switchExerciseCategory('${c}')">${c}</div>`).join('');
  html += `</div>`;
  html += `<div id="exerciseList">` + renderExerciseList(exerciseCategory) + `</div>`;
  view.innerHTML = html;
}

function renderExerciseList(cat) {
  const items = EXERCISE_DATA[cat] || [];
  return items.map(item => `
    <div class="exercise-card" onclick="playExercise('${item.title.replace(/'/g, "\\'")}')">
      <img class="ex-thumb" src="${item.thumb}" alt="${item.title}">
      <div class="ex-body">
        <div class="ex-title">${item.title}</div>
        <div class="ex-meta">⏱ ${item.duration} · 📊 ${item.level}</div>
      </div>
    </div>
  `).join('');
}

function switchExerciseCategory(cat) {
  exerciseCategory = cat;
  const view = document.getElementById('view-exercise');
  renderExercise(view);
}

function playExercise(title) {
  speak(title + '，开始运动吧');
  startTimer('exercise', title);
  showToast('▶️ ' + title);
}

// ===== 英语学习视图 =====
function renderEnglish(view) {
  const progress = Store.get('engProgress', { day: 1, phase: 1, wordsLearned: 0, sentencesLearned: 0 });
  const phase = ENGLISH_DATA.phases[0];
  let html = `
    <div class="eng-phase-banner">
      <div class="epb-title">${phase.name}</div>
      <div class="epb-desc">${phase.desc}</div>
      <div class="epb-day">第 ${progress.day} 天 / ${phase.duration}</div>
    </div>
  `;

  // 进度
  html += `
    <div class="card">
      <div class="eng-task-header">
        <span class="eng-task-icon">📊</span>
        <span class="eng-task-title">学习进度</span>
      </div>
      <div style="font-size:13px;color:var(--text-light);">已学单词 ${progress.wordsLearned} 个</div>
      <div class="eng-progress-bar"><div class="eng-progress-fill" style="width:${Math.min(progress.wordsLearned/100*100,100)}%"></div></div>
      <div style="font-size:13px;color:var(--text-light);margin-top:6px;">已学句型 ${progress.sentencesLearned} 个</div>
      <div class="eng-progress-bar"><div class="eng-progress-fill" style="width:${Math.min(progress.sentencesLearned/20*100,100)}%"></div></div>
    </div>
  `;

  // 每日任务
  html += `<div class="section-title">每日任务（35分钟拆分）</div>`;

  // 任务1: 字母学习
  html += `
    <div class="eng-task-card">
      <div class="eng-task-header">
        <span class="eng-task-icon">🔤</span>
        <span class="eng-task-title">26个字母大小写及标准读音</span>
        <span class="eng-task-time">5分钟</span>
      </div>
      <div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">听标准美式发音，跟读练习</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l,i) => `<button class="eng-audio-btn" onclick="speakLetter('${l}')">${l}</button>`).join('')}
      </div>
      <div style="margin-top:10px;">
        <button class="eng-record-btn" onclick="startRecording('字母朗读')">🎤 录音纠音</button>
        <button class="eng-audio-btn" onclick="startTimer('eng_letter','字母学习 5分钟')">⏱ 计时</button>
      </div>
    </div>
  `;

  // 任务2: 音标学习
  html += `
    <div class="eng-task-card">
      <div class="eng-task-header">
        <span class="eng-task-icon">🎵</span>
        <span class="eng-task-title">48个国际音标</span>
        <span class="eng-task-time">20分钟</span>
      </div>
      <div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">前14天：20个元音；后16天：28个辅音</div>
      <div class="section-title" style="margin-top:4px;">元音 (20个)</div>
      <div class="phonetic-grid">
        ${ENGLISH_DATA.phonetics.vowels.map(p => `
          <div class="phonetic-card" onclick="speakPhonetic('${p.word}')">
            <div class="ph-symbol">${p.symbol}</div>
            <div class="ph-example">${p.word}</div>
          </div>
        `).join('')}
      </div>
      <div class="section-title">辅音 (28个)</div>
      <div class="phonetic-grid">
        ${ENGLISH_DATA.phonetics.consonants.map(p => `
          <div class="phonetic-card" onclick="speakPhonetic('${p.word}')">
            <div class="ph-symbol">${p.symbol}</div>
            <div class="ph-example">${p.word}</div>
          </div>
        `).join('')}
      </div>
      <div style="margin-top:10px;">
        <button class="eng-audio-btn" onclick="startTimer('eng_phonetic','音标学习 20分钟')">⏱ 计时</button>
        <button class="eng-record-btn" onclick="startRecording('音标朗读')">🎤 录音纠音</button>
      </div>
    </div>
  `;

  // 任务3: 每日跟读单词
  html += `
    <div class="eng-task-card">
      <div class="eng-task-header">
        <span class="eng-task-icon">📖</span>
        <span class="eng-task-title">每日跟读3个基础单词</span>
        <span class="eng-task-time">10分钟</span>
      </div>
      <div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">从第10天起，用音标拼读</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${ENGLISH_DATA.vocab.basic.slice(0, 3).map(v => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--lavender-light);border-radius:8px;">
            <div style="flex:1;">
              <div style="font-size:16px;font-weight:700;">${v.word}</div>
              <div style="font-size:12px;color:var(--text-light);">${v.phon} · ${v.cn}</div>
            </div>
            <button class="eng-audio-btn" onclick="speakWord('${v.word}')">🔊 听</button>
            <button class="eng-record-btn" onclick="startRecording('${v.word}')">🎤 录</button>
          </div>
        `).join('')}
      </div>
      <div style="margin-top:10px;">
        <button class="eng-audio-btn" onclick="startTimer('eng_word','单词跟读 10分钟')">⏱ 计时</button>
        <button class="btn btn-sm btn-outline" onclick="markWordsLearned(3)">✓ 标记完成</button>
      </div>
    </div>
  `;

  // 月度目标
  html += `<div class="section-title">月度目标考核</div>`;
  html += `
    <div class="card">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px;">第一个月目标</div>
      <div style="font-size:13px;color:var(--text);line-height:1.8;">
        ✅ 熟练认读所有音标<br>
        ✅ 50天内掌握100个最基础生活单词<br>
        ✅ 能正确朗读短句，发音不跑偏
      </div>
    </div>
    <div class="card">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px;">第二阶段目标（50-120天）</div>
      <div style="font-size:13px;color:var(--text);line-height:1.8;">
        📌 第2月：累计400词+20句型，极简对话<br>
        📌 第3月：累计700词，自我介绍+基础沟通
      </div>
    </div>
  `;

  // 推荐课程
  html += `<div class="section-title">推荐学习资源</div>`;
  html += ENGLISH_DATA.courses.map(c => `
    <div class="card" onclick="window.open('${c.url}','_blank')">
      <div style="font-size:14px;font-weight:600;">${c.title}</div>
      <div style="font-size:12px;color:var(--text-light);margin-top:4px;">${c.desc}</div>
      <div style="margin-top:6px;"><span class="tag tag-green">${c.level}</span></div>
    </div>
  `).join('');

  // 请假跳过
  html += `
    <div class="card" style="text-align:center;">
      <div style="font-size:13px;color:var(--text-light);margin-bottom:10px;">请假可跳过当天，第二天正常接续</div>
      <button class="btn btn-outline btn-sm" onclick="engSkipDay()">📅 请假跳过今天</button>
    </div>
  `;

  view.innerHTML = html;
}

function speakLetter(letter) {
  speak(letter, 0.6);
}
function speakPhonetic(word) {
  speak(word, 0.75);
}
function speakWord(word) {
  speak(word, 0.8);
}
function startRecording(what) {
  // 使用 Web Speech API 录音
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showToast('⚠️ 浏览器不支持语音识别，请用Chrome');
    speak('浏览器不支持语音识别，请使用Chrome浏览器');
    return;
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  const hint = document.getElementById('voiceHint');
  hint.style.display = 'block';
  showToast('🎤 正在录音：' + what);
  rec.start();
  rec.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    showToast('🔊 你说了：' + transcript);
    speak('你说了' + transcript + '，发音还不错，继续加油');
  };
  rec.onerror = (e) => {
    showToast('⚠️ 录音出错，请重试');
  };
  rec.onend = () => {
    hint.style.display = 'none';
  };
}
function markWordsLearned(count) {
  const p = Store.get('engProgress', { day: 1, phase: 1, wordsLearned: 0, sentencesLearned: 0 });
  p.wordsLearned = (p.wordsLearned || 0) + count;
  p.day = (p.day || 1) + 1;
  Store.set('engProgress', p);
  speak('已记录，今天完成了单词学习');
  renderEnglish(document.getElementById('view-english'));
}
function engSkipDay() {
  const p = Store.get('engProgress', { day: 1, phase: 1, wordsLearned: 0, sentencesLearned: 0 });
  p.day = (p.day || 1) + 1;
  Store.set('engProgress', p);
  speak('已请假跳过，明天继续');
  renderEnglish(document.getElementById('view-english'));
}

// ===== 财经资讯视图 =====
function renderFinance(view) {
  const items = getDailyItems(FINANCE_DATA, new Date(), 10);
  let html = `
    <div class="refresh-bar">
      <div class="rb-title">财经资讯</div>
      <button class="refresh-btn" onclick="switchView('finance')">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 0 1-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        换一批
      </button>
    </div>
    <div class="section-title">今日资讯 ${items.length} 条</div>
  `;
  html += items.map(item => `
    <div class="knowledge-card">
      <img class="kc-image" src="${item.image}" alt="${item.title}">
      <div class="kc-body">
        <div class="kc-title">${item.title}</div>
        <div class="kc-summary">${item.summary}</div>
        <div class="kc-tags">${(item.tags||[]).map(t => `<span class="tag tag-orange">${t}</span>`).join('')}</div>
        <div class="kc-footer">
          <span class="kc-source">📌 ${item.source || ''}</span>
          <div class="kc-actions">
            <button class="kc-action-btn" onclick="speak('${item.title.replace(/'/g, "\\'")}${item.summary.replace(/'/g, "\\'").slice(0,60)}')">🔊 听解说</button>
          </div>
        </div>
      </div>
    </div>
  `).join('');
  view.innerHTML = html;
}

// ===== 日历视图 =====
function renderCalendar(view) {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();

  let html = `
    <div class="calendar-header">
      <button class="cal-nav-btn" onclick="calPrevMonth()">‹</button>
      <div class="calendar-title">${year}年${month + 1}月</div>
      <button class="cal-nav-btn" onclick="calNextMonth()">›</button>
    </div>
    <div class="calendar-grid">
      <div class="cal-weekdays">
        ${['日','一','二','三','四','五','六'].map(w => `<div class="cal-weekday">${w}</div>`).join('')}
      </div>
      <div class="cal-days">
  `;

  // 上月填充
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div class="cal-day other-month"><span class="cal-day-num">${daysInPrevMonth - i}</span></div>`;
  }

  const completions = Store.get('completions', {});
  const leaves = Store.get('leaves', {});
  const tasks = getTasks();

  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const doneList = completions[dateKey] || [];
    const doneCount = doneList.filter(id => tasks.some(t => t.id === id)).length;
    let status = '';
    if (leaves[dateKey]) {
      status = 'status-gray';
    } else if (doneCount === 0 && d < today.getDate() && isCurrentMonth) {
      status = 'status-red';
    } else if (doneCount > 0 && doneCount < tasks.length) {
      status = 'status-yellow';
    } else if (doneCount >= tasks.length && doneCount > 0) {
      status = 'status-pink';
    }
    const isToday = isCurrentMonth && d === today.getDate();
    html += `<div class="cal-day ${status} ${isToday ? 'today' : ''}" onclick="calSelectDay('${dateKey}')">
      <span class="cal-day-num">${d}</span>
    </div>`;
  }

  // 下月填充
  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= remaining; i++) {
    html += `<div class="cal-day other-month"><span class="cal-day-num">${i}</span></div>`;
  }

  html += `</div></div>`;

  // 图例
  html += `
    <div class="cal-legend">
      <div class="cal-legend-item"><span class="cal-legend-dot" style="background:var(--pink)"></span>完成</div>
      <div class="cal-legend-item"><span class="cal-legend-dot" style="background:var(--yellow)"></span>部分完成</div>
      <div class="cal-legend-item"><span class="cal-legend-dot" style="background:var(--red)"></span>缺卡</div>
      <div class="cal-legend-item"><span class="cal-legend-dot" style="background:var(--gray)"></span>请假</div>
    </div>
  `;

  // 当日详情
  const todayKeyStr = todayKey();
  const todayDone = completions[todayKeyStr] || [];
  html += `
    <div class="cal-detail">
      <div class="cal-detail-title">📋 ${todayKeyStr} ${getWeekday(today)} 任务详情</div>
      <div class="cal-detail-list">
        ${tasks.map(t => {
          const done = todayDone.includes(t.id);
          return `<div class="cdli"><span class="cdli-status">${done ? '✅' : '⬜'}</span> ${t.icon || ''} ${t.title}</div>`;
        }).join('')}
      </div>
    </div>
  `;

  view.innerHTML = html;
}

function calPrevMonth() {
  calendarMonth.setMonth(calendarMonth.getMonth() - 1);
  renderCalendar(document.getElementById('view-calendar'));
}
function calNextMonth() {
  calendarMonth.setMonth(calendarMonth.getMonth() + 1);
  renderCalendar(document.getElementById('view-calendar'));
}
function calSelectDay(dateKey) {
  const completions = Store.get('completions', {});
  const leaves = Store.get('leaves', {});
  const tasks = getTasks();
  const doneList = completions[dateKey] || [];
  const isLeave = leaves[dateKey];
  let detail = `<div class="modal-header"><div class="modal-title">📅 ${dateKey}</div><button class="modal-close" onclick="closeModal()">✕</button></div>`;
  if (isLeave) {
    detail += `<div style="text-align:center;padding:20px;"><div style="font-size:40px;">🏖️</div><div style="margin-top:10px;color:var(--text-light);">今日请假</div></div>`;
  } else {
    detail += `<div class="cal-detail-list" style="padding:10px;">`;
    detail += tasks.map(t => {
      const done = doneList.includes(t.id);
      return `<div class="cdli"><span class="cdli-status">${done ? '✅' : '⬜'}</span> ${t.icon || ''} ${t.title}</div>`;
    }).join('');
    detail += `</div>`;
    detail += `<div style="padding:10px;text-align:center;font-size:13px;color:var(--text-light);">完成 ${doneList.filter(id=>tasks.some(t=>t.id===id)).length}/${tasks.length}</div>`;
  }
  showModal(detail);
}

// ===== 记账视图 =====
const ACCT_CATS = {
  expense: ['餐饮', '交通', '购物', '医美', '美容', '运动健身', '学习', '日常', '娱乐', '其他'],
  income: ['工资', '兼职', '红包', '理财', '其他'],
};

function renderAccounting(view) {
  const records = Store.get('accounting', []);
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  const monthRecords = records.filter(r => r.date.startsWith(ym));
  const monthExpense = monthRecords.filter(r => r.type === 'expense').reduce((s,r) => s + r.amount, 0);
  const monthIncome = monthRecords.filter(r => r.type === 'income').reduce((s,r) => s + r.amount, 0);

  const allExpense = records.filter(r => r.type === 'expense').reduce((s,r) => s + r.amount, 0);
  const allIncome = records.filter(r => r.type === 'income').reduce((s,r) => s + r.amount, 0);

  // 按类别统计
  const catStats = {};
  monthRecords.filter(r => r.type === acctTab).forEach(r => {
    catStats[r.category] = (catStats[r.category] || 0) + r.amount;
  });
  const maxCat = Math.max(...Object.values(catStats), 1);

  let html = `
    <div class="acct-summary">
      <div class="acct-summary-card">
        <div class="acct-summary-label">本月支出</div>
        <div class="acct-summary-value expense">¥${monthExpense.toFixed(2)}</div>
      </div>
      <div class="acct-summary-card">
        <div class="acct-summary-label">本月收入</div>
        <div class="acct-summary-value income">¥${monthIncome.toFixed(2)}</div>
      </div>
    </div>
    <div class="acct-summary">
      <div class="acct-summary-card">
        <div class="acct-summary-label">累计总支出</div>
        <div class="acct-summary-value expense">¥${allExpense.toFixed(2)}</div>
      </div>
      <div class="acct-summary-card">
        <div class="acct-summary-label">累计总收入</div>
        <div class="acct-summary-value income">¥${allIncome.toFixed(2)}</div>
      </div>
    </div>
  `;

  // 输入区
  html += `
    <div class="acct-tabs">
      <div class="acct-tab ${acctTab === 'expense' ? 'active' : ''}" onclick="switchAcctTab('expense')">记支出</div>
      <div class="acct-tab ${acctTab === 'income' ? 'active' : ''}" onclick="switchAcctTab('income')">记收入</div>
    </div>
    <div class="card">
      <input class="input-field" type="number" id="acctAmount" placeholder="金额" step="0.01">
      <div class="acct-category-bar">
        ${(ACCT_CATS[acctTab] || []).map(c => `<button class="acct-cat-pill ${c === accountingCategory ? 'active' : ''}" onclick="selectAcctCat('${c}')">${c}</button>`).join('')}
      </div>
      <textarea class="input-field" id="acctNote" placeholder="备注（选写）" rows="2"></textarea>
      <button class="btn btn-primary btn-full" onclick="addAccounting()">➕ 记一笔</button>
    </div>
  `;

  // 分类统计图
  if (Object.keys(catStats).length > 0) {
    html += `<div class="section-title">${acctTab === 'expense' ? '支出' : '收入'}分类统计</div>`;
    html += `<div class="card">`;
    html += `<div class="acct-chart-bar">`;
    Object.entries(catStats).map(([cat, amt]) => {
      const h = (amt / maxCat * 80) + 10;
      return `<div class="acct-chart-col" style="height:${h}px"><div class="acct-chart-col-label">${cat}</div></div>`;
    }).join('');
    html += `</div>`;
    html += `<div style="margin-top:24px;">`;
    Object.entries(catStats).map(([cat, amt]) => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;"><span>${cat}</span><span style="font-weight:600;">¥${amt.toFixed(2)}</span></div>`).join('');
    html += `</div></div>`;
  }

  // 记录列表
  html += `<div class="section-title">最近记录</div>`;
  const recentRecords = [...records].reverse().slice(0, 30);
  if (recentRecords.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">📝</div><div class="es-text">还没有记录，开始记一笔吧</div></div>`;
  } else {
    html += recentRecords.map((r, idx) => {
      const realIdx = records.length - 1 - idx;
      const icon = r.type === 'expense' ? '💸' : '💰';
      return `
        <div class="acct-item">
          <span class="acct-item-icon">${icon}</span>
          <div class="acct-item-body">
            <div class="acct-item-cat">${r.category}${r.note ? ' · ' + r.note : ''}</div>
            <div class="acct-item-note">${r.date}</div>
          </div>
          <span class="acct-item-amount ${r.type}">${r.type === 'expense' ? '-' : '+'}¥${r.amount.toFixed(2)}</span>
          <button class="acct-item-del" onclick="delAccounting(${realIdx})">🗑</button>
        </div>
      `;
    }).join('');
  }

  view.innerHTML = html;
}

function switchAcctTab(tab) {
  acctTab = tab;
  accountingCategory = ACCT_CATS[tab][0];
  renderAccounting(document.getElementById('view-accounting'));
}
function selectAcctCat(cat) {
  accountingCategory = cat;
  renderAccounting(document.getElementById('view-accounting'));
}
function addAccounting() {
  const amount = parseFloat(document.getElementById('acctAmount').value);
  if (!amount || amount <= 0) { showToast('请输入金额'); return; }
  const note = document.getElementById('acctNote').value || '';
  const records = Store.get('accounting', []);
  records.push({ date: todayKey(), type: acctTab, amount, category: accountingCategory, note });
  Store.set('accounting', records);
  speak('已记录');
  renderAccounting(document.getElementById('view-accounting'));
}
function delAccounting(idx) {
  const records = Store.get('accounting', []);
  records.splice(idx, 1);
  Store.set('accounting', records);
  renderAccounting(document.getElementById('view-accounting'));
}

// ===== 内容创作视图 =====
function renderCreation(view) {
  const items = getDailyItems(CREATION_DATA, new Date(), 10);
  let html = `
    <div class="refresh-bar">
      <div class="rb-title">医美爆款热点视频</div>
      <button class="refresh-btn" onclick="switchView('creation')">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 0 1-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        换一批
      </button>
    </div>
    <div class="section-title">今日推荐 ${items.length} 条</div>
  `;
  html += items.map(item => `
    <div class="creation-card">
      <img class="cc-thumb" src="${item.thumb}" alt="${item.title}">
      <div class="cc-body">
        <div class="cc-title">${item.title}</div>
        <div class="cc-meta">
          <span class="hot">🔥 ${item.hot}</span>
          <span>⭐ ${item.collect}</span>
        </div>
        <div class="cc-tags">${(item.tags||[]).map(t => `<span class="tag tag-pink">${t}</span>`).join('')}</div>
        <div class="cc-reason">
          <div class="cc-reason-label">💡 获得原因/借鉴逻辑</div>
          ${item.reason}
        </div>
        <div class="cc-rewrite">
          <div class="cc-rewrite-label">✏️ 二创改编建议</div>
          ${item.rewrite}
        </div>
        <div class="kc-actions" style="margin-top:8px;">
          <button class="kc-action-btn" onclick="speak('${item.title.replace(/'/g, "\\'")}')">🔊 听</button>
          <button class="kc-action-btn" onclick="copyText('${item.title.replace(/'/g, "\\'")}\\n\\n借鉴逻辑：${item.reason.replace(/'/g, "\\'")}')">📋 复制</button>
        </div>
      </div>
    </div>
  `).join('');
  view.innerHTML = html;
}

// ===== 顾客跟进视图 =====
const PRIORITY = {
  urgent: { label: '7天紧急回访', tag: 'urgent', class: 'priority-urgent' },
  month:  { label: '1个月内回访', tag: 'month', class: 'priority-month' },
  long:   { label: '长期慢慢跟进', tag: 'long', class: 'priority-long' }
};

function renderCustomers(view) {
  const customers = Store.get('customers', []);

  // 统计
  const active = customers.filter(c => !c.completed);
  const urgentCount = active.filter(c => c.priority === 'urgent').length;
  const monthCount  = active.filter(c => c.priority === 'month').length;
  const longCount   = active.filter(c => c.priority === 'long').length;
  const doneCount   = customers.filter(c => c.completed).length;

  // 检查是否有到期回访
  const today = new Date();
  const todayStr = formatDate(today);
  let overdueCount = 0;
  active.forEach(c => {
    if (c.revisitDate && c.revisitDate <= todayStr) overdueCount++;
  });

  let html = `
    <div class="cust-stats">
      <div class="cust-stat-card">
        <div class="cust-stat-num red">${urgentCount}</div>
        <div class="cust-stat-label">7天紧急</div>
      </div>
      <div class="cust-stat-card">
        <div class="cust-stat-num yellow">${monthCount}</div>
        <div class="cust-stat-label">1个月内</div>
      </div>
      <div class="cust-stat-card">
        <div class="cust-stat-num pink">${longCount}</div>
        <div class="cust-stat-label">长期跟进</div>
      </div>
    </div>
  `;

  if (overdueCount > 0) {
    html += `
      <div class="leave-bar" style="border-color:var(--red);background:#FFEBEE;">
        <span class="leave-icon">⏰</span>
        <span class="leave-text" style="color:#C62828;">有 ${overdueCount} 位顾客到了约定回访时间，请尽快跟进</span>
      </div>
    `;
  }

  // 添加按钮
  html += `
    <button class="btn btn-primary btn-full" onclick="showAddCustomer()" style="margin-bottom:14px;">
      ➕ 新增顾客跟进
    </button>
  `;

  // 待跟进列表
  html += `<div class="section-title">待跟进顾客 (${active.length})</div>`;
  if (active.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">👥</div><div class="es-text">还没有待跟进的顾客，点击上方按钮添加</div></div>`;
  } else {
    // 按优先级排序：紧急 > 1个月 > 长期
    const order = { urgent: 0, month: 1, long: 2 };
    active.sort((a, b) => (order[a.priority] || 2) - (order[b.priority] || 2));
    html += active.map(c => renderCustomerItem(c)).join('');
  }

  // 已完成列表
  if (doneCount > 0) {
    html += `<div class="cust-done-section">`;
    html += `<div class="cust-done-header">✅ 已完成/已成交 (${doneCount})</div>`;
    html += customers.filter(c => c.completed).map(c => renderCustomerItem(c)).join('');
    html += `</div>`;
  }

  view.innerHTML = html;
}

function renderCustomerItem(c) {
  const p = PRIORITY[c.priority] || PRIORITY.long;
  const isOverdue = c.revisitDate && c.revisitDate <= formatDate(new Date()) && !c.completed;

  let followupHtml = '';
  if (c.followups && c.followups.length > 0) {
    followupHtml = '<div class="cust-followups">';
    c.followups.slice().reverse().forEach(f => {
      followupHtml += `
        <div class="cust-followup-item">
          <span class="cust-followup-date">${f.date}</span> ${f.content}
        </div>
      `;
    });
    followupHtml += '</div>';
  }

  return `
    <div class="cust-item ${c.completed ? 'completed' : p.class}">
      <div class="cust-item-header">
        <div class="cust-name">${c.name}</div>
        ${c.completed
          ? '<span class="cust-priority-tag" style="background:#E0E0E0;color:#757575;">已完成</span>'
          : `<span class="cust-priority-tag ${p.tag}">${p.label}</span>`
        }
      </div>
      ${c.project ? `<div class="cust-field"><span class="cust-field-label">铺垫项目：</span>${c.project}</div>` : ''}
      ${c.thought ? `<div class="cust-field"><span class="cust-field-label">顾客想法：</span>${c.thought}</div>` : ''}
      ${followupHtml}
      ${c.revisitDate ? `<div class="cust-revisit-date ${isOverdue ? 'overdue' : ''}">📅 回访时间：${c.revisitDate}${isOverdue ? ' ⚠已到期' : ''}</div>` : ''}
      <div class="cust-actions">
        ${!c.completed ? `<button class="cust-action-btn" onclick="showAddFollowup('${c.id}')">💬 记跟进</button>` : ''}
        <button class="cust-action-btn" onclick="showEditCustomer('${c.id}')">✏️ 编辑</button>
        ${!c.completed ? `<button class="cust-action-btn success" onclick="toggleCustomerDone('${c.id}')">✅ 完成成交</button>` : ''}
        ${c.completed ? `<button class="cust-action-btn" onclick="toggleCustomerDone('${c.id}')">↩️ 恢复跟进</button>` : ''}
        <button class="cust-action-btn danger" onclick="deleteCustomer('${c.id}')">🗑 删除</button>
      </div>
    </div>
  `;
}

function showAddCustomer() {
  const html = `
    <div class="modal-header">
      <div class="modal-title">新增顾客跟进</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="custName" placeholder="顾客姓名" autofocus>
    <input class="input-field" id="custProject" placeholder="铺垫的项目">
    <textarea class="input-field" id="custThought" placeholder="顾客想法" rows="2"></textarea>
    <input class="input-field" type="date" id="custRevisit" placeholder="约定回访时间">
    <div class="section-title">跟进优先级</div>
    <div class="cust-priority-selector">
      <div class="cust-priority-opt urgent active" data-priority="urgent" onclick="selectPriority(this)">7天紧急回访</div>
      <div class="cust-priority-opt month" data-priority="month" onclick="selectPriority(this)">1个月内回访</div>
      <div class="cust-priority-opt long" data-priority="long" onclick="selectPriority(this)">长期慢慢跟进</div>
    </div>
    <button class="btn btn-primary btn-full" onclick="saveNewCustomer()">保存</button>
  `;
  showModal(html);
}

let selectedPriority = 'urgent';
function selectPriority(el) {
  selectedPriority = el.dataset.priority;
  document.querySelectorAll('.cust-priority-opt').forEach(o => o.classList.remove('active'));
  el.classList.add('active');
}

function saveNewCustomer() {
  const name = document.getElementById('custName').value.trim();
  if (!name) { showToast('请输入顾客姓名'); return; }
  const project = document.getElementById('custProject').value.trim();
  const thought = document.getElementById('custThought').value.trim();
  const revisitDate = document.getElementById('custRevisit').value || '';

  const customers = Store.get('customers', []);
  customers.push({
    id: 'c' + Date.now(),
    name, project, thought, revisitDate,
    priority: selectedPriority,
    followups: [],
    completed: false,
    createdAt: formatDate(new Date())
  });
  Store.set('customers', customers);
  closeModal();
  speak('已添加顾客');
  renderCustomers(document.getElementById('view-customers'));
}

function showEditCustomer(cid) {
  const customers = Store.get('customers', []);
  const c = customers.find(cu => cu.id === cid);
  if (!c) return;

  selectedPriority = c.priority || 'long';
  const html = `
    <div class="modal-header">
      <div class="modal-title">编辑顾客</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="editCustName" value="${c.name.replace(/"/g,'&quot;')}" autofocus>
    <input class="input-field" id="editCustProject" value="${(c.project||'').replace(/"/g,'&quot;')}" placeholder="铺垫的项目">
    <textarea class="input-field" id="editCustThought" rows="2" placeholder="顾客想法">${c.thought||''}</textarea>
    <input class="input-field" type="date" id="editCustRevisit" value="${c.revisitDate||''}">
    <div class="section-title">跟进优先级</div>
    <div class="cust-priority-selector">
      <div class="cust-priority-opt urgent ${c.priority==='urgent'?'active':''}" data-priority="urgent" onclick="selectPriority(this)">7天紧急回访</div>
      <div class="cust-priority-opt month ${c.priority==='month'?'active':''}" data-priority="month" onclick="selectPriority(this)">1个月内回访</div>
      <div class="cust-priority-opt long ${c.priority==='long'?'active':''}" data-priority="long" onclick="selectPriority(this)">长期慢慢跟进</div>
    </div>
    <button class="btn btn-primary btn-full" onclick="saveEditCustomer('${cid}')">保存</button>
  `;
  showModal(html);
}

function saveEditCustomer(cid) {
  const name = document.getElementById('editCustName').value.trim();
  if (!name) { showToast('请输入顾客姓名'); return; }
  const project = document.getElementById('editCustProject').value.trim();
  const thought = document.getElementById('editCustThought').value.trim();
  const revisitDate = document.getElementById('editCustRevisit').value || '';

  const customers = Store.get('customers', []);
  const idx = customers.findIndex(cu => cu.id === cid);
  if (idx < 0) return;
  customers[idx] = { ...customers[idx], name, project, thought, revisitDate, priority: selectedPriority };
  Store.set('customers', customers);
  closeModal();
  speak('已更新');
  renderCustomers(document.getElementById('view-customers'));
}

function showAddFollowup(cid) {
  const html = `
    <div class="modal-header">
      <div class="modal-title">记录跟进内容</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <textarea class="input-field" id="followupContent" placeholder="本次聊天/跟进内容..." rows="4" autofocus></textarea>
    <input class="input-field" type="date" id="followupNextRevisit" placeholder="下次约定回访时间">
    <button class="btn btn-primary btn-full" onclick="saveFollowup('${cid}')">保存跟进记录</button>
  `;
  showModal(html);
}

function saveFollowup(cid) {
  const content = document.getElementById('followupContent').value.trim();
  if (!content) { showToast('请输入跟进内容'); return; }
  const nextRevisit = document.getElementById('followupNextRevisit').value;

  const customers = Store.get('customers', []);
  const idx = customers.findIndex(cu => cu.id === cid);
  if (idx < 0) return;
  if (!customers[idx].followups) customers[idx].followups = [];
  customers[idx].followups.push({ date: formatDate(new Date()), content });
  if (nextRevisit) customers[idx].revisitDate = nextRevisit;
  Store.set('customers', customers);
  closeModal();
  speak('已记录跟进');
  renderCustomers(document.getElementById('view-customers'));
}

function toggleCustomerDone(cid) {
  const customers = Store.get('customers', []);
  const idx = customers.findIndex(cu => cu.id === cid);
  if (idx < 0) return;
  customers[idx].completed = !customers[idx].completed;
  if (customers[idx].completed) {
    customers[idx].completedDate = formatDate(new Date());
    speak('已标记完成，恭喜成交');
  } else {
    delete customers[idx].completedDate;
    speak('已恢复跟进');
  }
  Store.set('customers', customers);
  renderCustomers(document.getElementById('view-customers'));
}

function deleteCustomer(cid) {
  if (!confirm('确定删除该顾客跟进记录吗？')) return;
  const customers = Store.get('customers', []);
  const filtered = customers.filter(cu => cu.id !== cid);
  Store.set('customers', filtered);
  speak('已删除');
  renderCustomers(document.getElementById('view-customers'));
}

// ===== 设置视图 =====
function renderSettings(view) {
  const tasks = getTasks();
  const voiceOn = Store.get('voiceOn', true);

  let html = `<div class="section-title">任务管理</div>`;
  html += tasks.map((t, idx) => `
    <div class="task-edit-item">
      <span class="tei-title">${t.icon || ''} ${t.title}</span>
      <button class="tei-edit" onclick="editTask(${idx})">✏️</button>
      <button class="tei-del" onclick="delTask(${idx})">🗑</button>
    </div>
  `).join('');
  html += `<button class="btn btn-primary btn-full" onclick="addTask()">➕ 添加新任务</button>`;

  html += `<div class="section-title">语音设置</div>`;
  html += `
    <div class="setting-row">
      <span class="sr-label">语音播报</span>
      <div class="sr-toggle ${voiceOn ? 'on' : ''}" onclick="toggleVoice()"></div>
    </div>
    <div class="setting-row">
      <span class="sr-label">试听语音</span>
      <button class="btn btn-sm btn-outline" onclick="speak('你好，我是你的工作助手，有什么可以帮你的吗')">🔊 试听</button>
    </div>
    <div class="card" style="margin-top:8px;">
      <div style="font-size:13px;color:var(--text-light);line-height:1.8;">
        🎵 语音采用柔和女声，语速舒缓<br>
        📱 所有数据保存在本地浏览器中<br>
        ⏰ 未完成任务12:00和16:00自动提醒
      </div>
    </div>
  `;

  html += `<div class="section-title">数据管理</div>`;
  html += `
    <div class="card">
      <button class="btn btn-outline btn-full btn-sm" onclick="exportData()" style="margin-bottom:8px;">📤 导出数据</button>
      <button class="btn btn-outline btn-full btn-sm" style="border-color:var(--red);color:var(--red);" onclick="resetData()">🗑 清空所有数据</button>
    </div>
  `;

  view.innerHTML = html;
}

function addTask() {
  const html = `
    <div class="modal-header">
      <div class="modal-title">添加任务</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="newTaskTitle" placeholder="任务标题">
    <textarea class="input-field" id="newTaskDesc" placeholder="任务描述" rows="2"></textarea>
    <label style="font-size:13px;display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <input type="checkbox" id="newTaskTimed" checked> 需要计时
    </label>
    <button class="btn btn-primary btn-full" onclick="saveNewTask()">保存</button>
  `;
  showModal(html);
}

function saveNewTask() {
  const title = document.getElementById('newTaskTitle').value.trim();
  if (!title) { showToast('请输入标题'); return; }
  const desc = document.getElementById('newTaskDesc').value.trim();
  const timed = document.getElementById('newTaskTimed').checked;
  const tasks = getTasks();
  tasks.push({ id: 't' + Date.now(), title, desc, icon: '📌', timed });
  Store.set('tasks', tasks);
  closeModal();
  renderSettings(document.getElementById('view-settings'));
  speak('已添加');
}

function editTask(idx) {
  const tasks = getTasks();
  const t = tasks[idx];
  const html = `
    <div class="modal-header">
      <div class="modal-title">编辑任务</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="editTaskTitle" value="${t.title.replace(/"/g, '&quot;')}">
    <textarea class="input-field" id="editTaskDesc" rows="2">${t.desc || ''}</textarea>
    <label style="font-size:13px;display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <input type="checkbox" id="editTaskTimed" ${t.timed ? 'checked' : ''}> 需要计时
    </label>
    <button class="btn btn-primary btn-full" onclick="saveEditTask(${idx})">保存</button>
  `;
  showModal(html);
}

function saveEditTask(idx) {
  const title = document.getElementById('editTaskTitle').value.trim();
  if (!title) { showToast('请输入标题'); return; }
  const desc = document.getElementById('editTaskDesc').value.trim();
  const timed = document.getElementById('editTaskTimed').checked;
  const tasks = getTasks();
  tasks[idx] = { ...tasks[idx], title, desc, timed };
  Store.set('tasks', tasks);
  closeModal();
  renderSettings(document.getElementById('view-settings'));
  speak('已修改');
}

function delTask(idx) {
  if (!confirm('确定删除这个任务吗？')) return;
  const tasks = getTasks();
  tasks.splice(idx, 1);
  Store.set('tasks', tasks);
  renderSettings(document.getElementById('view-settings'));
  speak('已删除');
}

function toggleVoice() {
  const v = !Store.get('voiceOn', true);
  Store.set('voiceOn', v);
  renderSettings(document.getElementById('view-settings'));
  if (v) speak('语音已开启');
}

function exportData() {
  const data = {};
  ['tasks', 'completions', 'leaves', 'reminders', 'accounting', 'engProgress', 'voiceOn', 'customers'].forEach(k => {
    data[k] = Store.get(k);
  });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '妙妙工作台_数据_' + todayKey() + '.json';
  a.click();
  speak('已导出');
}

function resetData() {
  if (!confirm('确定清空所有数据吗？此操作不可恢复！')) return;
  localStorage.clear();
  renderSettings(document.getElementById('view-settings'));
  speak('已清空');
}

// ===== 语音播报 =====
let voices = [];
function loadVoices() {
  voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
}
if (window.speechSynthesis) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text, rate) {
  if (!Store.get('voiceOn', true)) return;
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = rate || 0.85; // 舒缓语速
  u.pitch = 1.1; // 略高音调，更温柔
  // 尝试选择女声
  const femaleVoice = voices.find(v =>
    v.lang.startsWith('zh') && (v.name.includes('Female') || v.name.includes('female') || v.name.includes('女') || v.name.includes('Ting') || v.name.includes('Xiaoxiao'))
  );
  if (femaleVoice) u.voice = femaleVoice;
  window.speechSynthesis.speak(u);
}

// ===== Toast =====
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ===== 模态框 =====
function showModal(html) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('modalOverlay').style.display = 'flex';
}
function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
}
document.addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});

// ===== 复制文本 =====
function copyText(text) {
  // 去除转义
  text = text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'");
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 已复制');
      speak('已复制');
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast('📋 已复制'); } catch(e) { showToast('复制失败，请手动复制'); }
  document.body.removeChild(ta);
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);
