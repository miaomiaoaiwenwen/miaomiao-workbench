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
let _backupTimer = null;
let _cloudSyncTimer = null;
const DATA_KEYS = ['tasks', 'completions', 'leaves', 'reminders', 'accounting', 'engProgress', 'voiceOn', 'customers', 'consumption', 'recordings', 'voicePrefs', 'reviewReports', 'notes'];

const Store = {
  get(key, def) {
    try { const v = localStorage.getItem('mm_' + key); return v ? JSON.parse(v) : def; }
    catch(e) { return def; }
  },
  set(key, val) {
    localStorage.setItem('mm_' + key, JSON.stringify(val));
    // 延迟自动备份（防抖，避免频繁写入）
    if (_backupTimer) clearTimeout(_backupTimer);
    _backupTimer = setTimeout(() => autoBackup(), 2000);
    // 延迟云端同步（防抖，避免频繁请求）
    if (_cloudSyncTimer) clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = setTimeout(() => pushToCloud(), 5000);
  },
  del(key) { localStorage.removeItem('mm_' + key); }
};

// ===== 云端同步模块 =====
const CLOUD_OWNER = 'miaomiaoaiwenwen';
const CLOUD_REPO = 'miaomiao-workbench';
const CLOUD_BRANCH = 'main';
const CLOUD_ENCRYPT_KEY = 'mm-workbench-2026-cloud-aes-secure';
const CLOUD_CURRENT = 'cloud-data/current.json';
const CLOUD_BACKUP_DIR = 'cloud-data/backups';

const CloudSync = {
  // ===== Token 管理 =====
  getToken() {
    return Store.get('cloudToken', '');
  },
  setToken(t) {
    if (t) { Store.set('cloudToken', t); }
  },
  isConnected() {
    return !!this.getToken();
  },

  // ===== 加密/解密 =====
  encrypt(obj) {
    try {
      const json = JSON.stringify(obj);
      return CryptoJS.AES.encrypt(json, CLOUD_ENCRYPT_KEY).toString();
    } catch(e) { console.error('加密失败:', e); return null; }
  },
  decrypt(encrypted) {
    try {
      let ciphertext = String(encrypted).replace(/[\n\r]/g, '');
      const bytes = CryptoJS.AES.decrypt(ciphertext, CLOUD_ENCRYPT_KEY);
      const json = bytes.toString(CryptoJS.enc.Utf8);
      if (!json) throw new Error('空解密');
      return JSON.parse(json);
    } catch(e) { console.error('解密失败:', e); return null; }
  },

  // ===== 数据打包/恢复 =====
  packAll() {
    const data = {};
    DATA_KEYS.forEach(k => { data[k] = Store.get(k); });
    data._timestamp = Date.now();
    data._version = '1.0';
    return data;
  },
  restoreAll(data) {
    let count = 0;
    DATA_KEYS.forEach(k => {
      if (data[k] !== undefined && data[k] !== null) {
        Store.set(k, data[k]);
        count++;
      }
    });
    return count;
  },

  // ===== GitHub API 封装 =====
  async _api(method, path, body) {
    const token = this.getToken();
    if (!token) throw new Error('TOKEN_NOT_SET');
    const url = `https://api.github.com/repos/${CLOUD_OWNER}/${CLOUD_REPO}/contents/${path}`;
    const headers = { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' };
    const opts = { method, headers };
    if (body) {
      opts.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) { Store.del('cloudToken'); throw new Error('TOKEN_INVALID'); }
      if (res.status === 404) return null;
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // ===== 推送到云端 =====
  async push() {
    if (!this.isConnected()) return { ok: false, reason: '未设置Token' };
    try {
      const data = this.packAll();
      const encrypted = this.encrypt(data);
      if (!encrypted) return { ok: false, reason: '加密失败' };

      let sha = null;
      try {
        const file = await this._api('GET', CLOUD_CURRENT);
        if (file) sha = file.sha;
      } catch(e) { /* 首次上传 */ }

      const b64 = btoa(unescape(encodeURIComponent(encrypted)));
      await this._api('PUT', CLOUD_CURRENT, {
        message: `☁️ 增量同步 ${new Date().toLocaleString('zh-CN')}`,
        content: b64, sha: sha, branch: CLOUD_BRANCH
      });

      Store.set('cloudLastSync', Date.now());
      console.log('☁️ 云端同步成功', new Date().toLocaleString('zh-CN'));
      return { ok: true };
    } catch(e) {
      console.error('云端推送失败:', e.message);
      return { ok: false, reason: e.message };
    }
  },

  // ===== 从云端拉取 =====
  async pull() {
    if (!this.isConnected()) return { ok: false, reason: '未设置Token' };
    try {
      const file = await this._api('GET', CLOUD_CURRENT);
      if (!file) return { ok: false, reason: '云端无数据' };

      const b64 = String(file.content).replace(/[\n\r]/g, '');
      const encrypted = decodeURIComponent(escape(atob(b64)));
      const data = this.decrypt(encrypted);
      if (!data) return { ok: false, reason: '解密失败' };

      return { ok: true, data, cloudTime: file.sha };
    } catch(e) {
      return { ok: false, reason: e.message };
    }
  },

  // ===== 备份列表 =====
  async listBackups() {
    if (!this.isConnected()) return [];
    try {
      const files = await this._api('GET', CLOUD_BACKUP_DIR);
      if (!files || !Array.isArray(files)) return [];
      return files
        .filter(f => f.name.endsWith('.json'))
        .sort((a, b) => b.name.localeCompare(a.name))
        .map(f => ({
          name: f.name,
          path: f.path,
          size: f.size,
          label: f.name.replace('.json', ''),
          sha: f.sha
        }));
    } catch(e) {
      return [];
    }
  },

  // ===== 创建备份 =====
  async createBackup() {
    if (!this.isConnected()) return { ok: false, reason: '未设置Token' };
    try {
      const data = this.packAll();
      const encrypted = this.encrypt(data);
      if (!encrypted) return { ok: false, reason: '加密失败' };

      const now = new Date();
      const ts = [now.getFullYear(),
        String(now.getMonth()+1).padStart(2,'0'),
        String(now.getDate()).padStart(2,'0')].join('-') + '-' +
        String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
      const filename = `${CLOUD_BACKUP_DIR}/${ts}.json`;

      const b64 = btoa(unescape(encodeURIComponent(encrypted)));
      await this._api('PUT', filename, {
        message: `📦 全量备份 ${ts}`,
        content: b64, branch: CLOUD_BRANCH
      });

      return { ok: true, name: ts };
    } catch(e) {
      return { ok: false, reason: e.message };
    }
  },

  // ===== 从指定备份恢复 =====
  async restore(filepath) {
    if (!this.isConnected()) return { ok: false, reason: '未设置Token' };
    try {
      const file = await this._api('GET', filepath);
      if (!file) return { ok: false, reason: '备份不存在' };

      const b64 = String(file.content).replace(/[\n\r]/g, '');
      const encrypted = decodeURIComponent(escape(atob(b64)));
      const data = this.decrypt(encrypted);
      if (!data) return { ok: false, reason: '解密失败' };

      const count = this.restoreAll(data);
      await this.push(); // 恢复后立即同步到 current
      return { ok: true, count };
    } catch(e) {
      return { ok: false, reason: e.message };
    }
  },

  // ===== 每日自动备份（启动时检查）=====
  async dailyAutoBackup() {
    if (!this.isConnected()) return;
    const today = [new Date().getFullYear(),
      String(new Date().getMonth()+1).padStart(2,'0'),
      String(new Date().getDate()).padStart(2,'0')].join('-');
    const lastDaily = Store.get('cloudDailyBackup', '');
    if (lastDaily === today) return; // 今天已备份

    // 检查云端是否已有今天的备份
    const backups = await this.listBackups();
    const hasToday = backups.some(b => b.label.startsWith(today));
    if (hasToday) {
      Store.set('cloudDailyBackup', today);
      return;
    }
    // 创建每日备份
    const r = await this.createBackup();
    if (r.ok) {
      Store.set('cloudDailyBackup', today);
      console.log('📦 每日备份已完成:', r.name);
    }
  },

  // ===== 验证 Token =====
  async verifyToken(token) {
    try {
      const url = `https://api.github.com/user`;
      const res = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
      if (!res.ok) return false;
      const user = await res.json();
      return user.login === CLOUD_OWNER;
    } catch(e) { return false; }
  }
};

// ===== 云端同步对外接口（非async, 由调用方处理） =====
function pushToCloud() {
  if (!CloudSync.isConnected()) return;
  CloudSync.push().then(r => {
    if (r.ok) updateCloudSyncUI();
  }).catch(() => {});
}

async function pullFromCloud() {
  if (!CloudSync.isConnected()) return;
  const r = await CloudSync.pull();
  if (r.ok && r.data) {
    // 比较时间戳
    const cloudTime = r.data._timestamp || 0;
    const localSyncTime = Store.get('cloudLastSync', 0);
    if (!localSyncTime || cloudTime > localSyncTime) {
      const count = CloudSync.restoreAll(r.data);
      return { updated: true, count };
    }
  }
  return { updated: false };
}

// ===== 启动时云端检查 =====
async function initCloudSync() {
  if (!CloudSync.isConnected()) return;
  try {
    // 每日自动备份（如果今天还没有）
    CloudSync.dailyAutoBackup();

    // 检查本地是否有实质数据
    let hasLocal = false;
    const customers = Store.get('customers', []);
    const consumption = Store.get('consumption', []);
    const accounting = Store.get('accounting', []);
    if ((customers && customers.length > 0) || (consumption && consumption.length > 0) || (accounting && accounting.length > 0)) {
      hasLocal = true;
    }

    const r = await CloudSync.pull();
    if (r.ok && r.data) {
      if (!hasLocal) {
        // 本地无数据，从云端恢复
        const count = CloudSync.restoreAll(r.data);
        showToast(`☁️ 已从云端恢复 ${count} 项数据`);
        setTimeout(() => location.reload(), 1500);
      } else {
        // 本地有数据，推送到云端
        await CloudSync.push();
      }
    } else if (hasLocal) {
      // 云端无数据但本地有，首次推送
      await CloudSync.push();
    }
  } catch(e) {
    console.warn('启动云端同步失败:', e);
  }
}

// 获取今日日期键
function todayKey() { return formatDate(new Date()); }

// ===== 初始化 =====
function init() {
  renderMenu();
  setupEvents();
  switchView('daily');
  checkReminders();
  // 启动时自动备份 + 检查备份状态
  autoBackup();
  // 启动时从云端拉取数据
  initCloudSync();
  // 每分钟检查提醒
  setInterval(checkReminders, 60000);
  // 每5分钟自动备份一次
  setInterval(autoBackup, 300000);
}

// ===== 折叠分类菜单渲染 =====
function renderMenu() {
  const menuEl = document.getElementById('drawerMenu');
  let html = '';
  MENU_CATEGORIES.forEach(cat => {
    const isExpanded = cat.expanded;
    html += `<div class="menu-category" data-cat="${cat.id}">`;
    html += `<div class="menu-cat-header" data-cat="${cat.id}">`;
    html += `<span class="menu-cat-icon">${cat.icon}</span>`;
    html += `<span class="menu-cat-name">${cat.name}</span>`;
    html += `<span class="menu-cat-arrow ${isExpanded ? 'expanded' : ''}">▶</span>`;
    html += `</div>`;
    html += `<div class="menu-cat-children ${isExpanded ? 'expanded' : ''}">`;
    cat.children.forEach(m => {
      html += `<div class="menu-item ${m.id === currentView ? 'active' : ''}" data-view="${m.id}">`;
      html += `<span class="menu-icon">${m.icon}</span>`;
      html += `<span>${m.name}</span>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  });
  menuEl.innerHTML = html;

  // 分类头点击 → 折叠/展开
  menuEl.querySelectorAll('.menu-cat-header').forEach(header => {
    header.addEventListener('click', () => {
      const catId = header.dataset.cat;
      const category = MENU_CATEGORIES.find(c => c.id === catId);
      if (category) {
        category.expanded = !category.expanded;
        renderMenu(); // 重新渲染以更新箭头和子菜单状态
      }
    });
  });

  // 子菜单项点击
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
  const menu = MENU_FLAT[viewId];
  document.getElementById('topbarTitle').textContent = menu ? menu.name : '';
  // 更新菜单激活状态
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
    case 'consumption': renderConsumption(view); break;
    case 'recording_review': renderRecordingReview(view); break;
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
    case 'learning': renderLearning(view); break;
    case 'dashboard': renderDashboard(view); break;
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

  // ===== 快捷入口卡片 =====
  html += `<div class="section-title">快捷入口</div>`;
  html += `<div class="quick-cards">
    <div class="quick-card" onclick="switchView('daily')">
      <div class="quick-card-icon qc-pink">📋</div>
      <div class="quick-card-name">每日工作</div>
    </div>
    <div class="quick-card" onclick="switchView('customers')">
      <div class="quick-card-icon qc-purple">👥</div>
      <div class="quick-card-name">顾客跟进</div>
    </div>
    <div class="quick-card" onclick="switchView('consumption')">
      <div class="quick-card-icon qc-gold">💳</div>
      <div class="quick-card-name">顾客消费</div>
    </div>
    <div class="quick-card" onclick="switchView('recording_review')">
      <div class="quick-card-icon qc-teal">🎙️</div>
      <div class="quick-card-name">录音复盘</div>
    </div>
  </div>`;

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
            <button class="kc-action-btn kc-video-btn" onclick="showKnowledgeVideo('${item.title.replace(/'/g, "\\'")}', '${(item.video||'').replace(/'/g, "\\'")}', '${item.summary.replace(/'/g, "\\'").replace(/\n/g, '\\n')}')">▶️ 视频</button>
            <button class="kc-action-btn" onclick="speak('${item.title.replace(/'/g, "\\'")}')">🔊 听</button>
            <button class="kc-action-btn" onclick="copyText('${(item.title + ' - ' + item.summary).replace(/'/g, "\\'").replace(/\n/g, '\\n')}')">📋 复制</button>
          </div>
        </div>
      </div>
    </div>
  `).join('');
  view.innerHTML = html;
}

function showKnowledgeVideo(title, videoUrl, summary) {
  const contentHtml = `
    <div class="vp-section">
      <div class="vp-section-title">📖 知识内容</div>
      <div class="vp-summary">${summary}</div>
    </div>
  `;
  showVideoPlayer(title, videoUrl, contentHtml);
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
            <button class="kc-action-btn kc-video-btn" onclick="showKnowledgeVideo('${item.title.replace(/'/g, "\\'")}', '${(item.video||'').replace(/'/g, "\\'")}', '${item.summary.replace(/'/g, "\\'").replace(/\n/g, '\\n')}')">▶️ 视频</button>
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
  const allCount = (MOMENTS_DATA[momentsCategory] || []).length;
  const state = getMomentsState(momentsCategory);
  const totalBatches = Math.ceil(allCount / 10);
  const currentBatch = Math.floor(state.shownCount / 10) + 1;

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
  html += `<div class="moments-batch-info">第 ${currentBatch} 批 / 共 ${totalBatches} 批 · 本分类共 ${allCount} 条 · 今日已展示 ${state.shownCount + 10 > allCount ? allCount : state.shownCount + 10} 条</div>`;
  html += renderMomentsList(momentsCategory);
  view.innerHTML = html;
}

function renderMomentsList(cat) {
  const items = getMomentsBatch(cat, 10, false);
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

// 获取或初始化文案状态（每日重置，跨天不同排序）
function getMomentsState(cat) {
  const today = formatDate(new Date());
  const key = `moments_state_${cat}`;
  let state = Store.get(key, null);

  if (!state || state.date !== today) {
    // 新的一天：创建当日洗牌顺序
    const all = MOMENTS_DATA[cat] || [];
    const dayIdx = getDayOfYear(new Date());
    const seed = dayIdx * 1000 + cat.length * 7 + (cat.charCodeAt(0) || 0);
    const order = [];
    for (let i = 0; i < all.length; i++) order.push(i);
    // Fisher-Yates 洗牌（确定性种子，每天不同）
    let s = seed;
    for (let i = order.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    state = { date: today, order: order, shownCount: 0, reshuffleCount: 0 };
    Store.set(key, state);
  }

  return state;
}

// 创建洗牌顺序
function createShuffleOrder(length, seed) {
  const order = [];
  for (let i = 0; i < length; i++) order.push(i);
  let s = seed;
  for (let i = order.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// 获取文案批次（isRefresh=true 时前进到下一批）
function getMomentsBatch(cat, count, isRefresh) {
  const all = MOMENTS_DATA[cat] || [];
  if (all.length === 0) return [];

  let state = getMomentsState(cat);

  if (isRefresh) {
    state.shownCount += count;
    // 全部展示完毕，重新洗牌
    if (state.shownCount >= all.length) {
      state.shownCount = 0;
      state.reshuffleCount = (state.reshuffleCount || 0) + 1;
      const dayIdx = getDayOfYear(new Date());
      const seed = dayIdx * 1000 + cat.length * 7 + (cat.charCodeAt(0) || 0) + state.reshuffleCount * 9999 + 1;
      state.order = createShuffleOrder(all.length, seed);
    }
    Store.set(`moments_state_${cat}`, state);
  }

  const result = [];
  for (let i = 0; i < count; i++) {
    const idx = state.order[(state.shownCount + i) % all.length];
    result.push(all[idx]);
  }

  return result;
}

function switchMomentsCategory(cat) {
  momentsCategory = cat;
  const view = document.getElementById('view-moments');
  renderMoments(view);
}

function refreshMoments() {
  const btn = document.getElementById('momentsRefresh');
  if (btn) btn.classList.add('spinning');

  // 前进到下一批（自动跳过已展示的）
  getMomentsBatch(momentsCategory, 10, true);

  setTimeout(() => {
    const view = document.getElementById('view-moments');
    if (view) renderMoments(view);
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
  return items.map((item, idx) => `
    <div class="exercise-card">
      <img class="ex-thumb" src="${item.thumb}" alt="${item.title}" onclick="playExercise(${idx}, '${cat}')">
      <div class="ex-body">
        <div class="ex-title">${item.title}</div>
        <div class="ex-meta">⏱ ${item.duration} · 📊 ${item.level}</div>
        <div class="ex-actions">
          <button class="ex-video-btn" onclick="playExercise(${idx}, '${cat}')">▶️ 视频跟练</button>
          <button class="ex-text-btn" onclick="showExerciseSteps(${idx}, '${cat}')">📖 动作步骤</button>
        </div>
      </div>
    </div>
  `).join('');
}

function switchExerciseCategory(cat) {
  exerciseCategory = cat;
  const view = document.getElementById('view-exercise');
  renderExercise(view);
}

function playExercise(idx, cat) {
  const item = EXERCISE_DATA[cat][idx];
  if (!item) return;
  const stepsHtml = `
    <div class="vp-section">
      <div class="vp-section-title">📋 动作步骤详解</div>
      <div class="vp-steps">${(item.steps || '').replace(/\n/g, '<br>')}</div>
    </div>
    <div class="vp-section">
      <div class="vp-section-title">⏱ 时长：${item.duration} · 难度：${item.level}</div>
    </div>
    <button class="btn btn-primary btn-full" onclick="startTimer('exercise', '${item.title.replace(/'/g, "\\'")}'); closeModal();" style="margin-top:12px;">⏱ 开始计时跟练</button>
  `;
  showVideoPlayer(item.title, item.video, stepsHtml);
  speak(item.title + '，开始运动吧');
}

function showExerciseSteps(idx, cat) {
  const item = EXERCISE_DATA[cat][idx];
  if (!item) return;
  const html = `
    <div class="modal-header">
      <div class="modal-title">${item.title}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="vp-section">
      <div class="vp-section-title">📋 动作步骤详解</div>
      <div class="vp-steps">${(item.steps || '').replace(/\n/g, '<br>')}</div>
    </div>
    <div class="vp-section">
      <div class="vp-section-title">⏱ 时长：${item.duration} · 难度：${item.level}</div>
    </div>
    <button class="btn btn-primary btn-full" onclick="startTimer('exercise', '${item.title.replace(/'/g, "\\'")}'); closeModal();" style="margin-top:12px;">⏱ 开始计时跟练</button>
  `;
  showModal(html);
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
  html += items.map((item, idx) => {
    const safeTitle = item.title.replace(/'/g, "\\'");
    const safeVideo = (item.video||'').replace(/'/g, "\\'");
    const safeAnalysis = (item.analysis||'').replace(/'/g, "\\'").replace(/\n/g, '\\n');
    const safeReason = item.reason.replace(/'/g, "\\'");
    const safeRewrite = item.rewrite.replace(/'/g, "\\'");
    return `
    <div class="creation-card">
      <img class="cc-thumb" src="${item.thumb}" alt="${item.title}" onclick="showCreationVideo('${safeTitle}', '${safeVideo}', '${safeAnalysis}')">
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
        <div class="cc-analysis-toggle" onclick="toggleAnalysis(this)">
          <span class="cc-analysis-arrow">▶</span> 查看完整拆解（拍摄思路/镜头/文案/剪辑）
        </div>
        <div class="cc-analysis-detail" style="display:none;">${(item.analysis||'').replace(/\n/g, '<br>')}</div>
        <div class="kc-actions" style="margin-top:8px;">
          <button class="kc-action-btn kc-video-btn" onclick="showCreationVideo('${safeTitle}', '${safeVideo}', '${safeAnalysis}')">▶️ 观看原视频</button>
          <button class="kc-action-btn" onclick="speak('${safeTitle}')">🔊 听</button>
          <button class="kc-action-btn" onclick="copyText('${safeTitle}\\n\\n借鉴逻辑：${safeReason}\\n\\n二创建议：${safeRewrite}')">📋 复制</button>
        </div>
      </div>
    </div>
  `}).join('');
  view.innerHTML = html;
}

function toggleAnalysis(el) {
  const detail = el.nextElementSibling;
  const arrow = el.querySelector('.cc-analysis-arrow');
  if (detail.style.display === 'none') {
    detail.style.display = 'block';
    arrow.textContent = '▼';
  } else {
    detail.style.display = 'none';
    arrow.textContent = '▶';
  }
}

function showCreationVideo(title, videoUrl, analysis) {
  const contentHtml = `
    <div class="vp-section">
      <div class="vp-section-title">🎬 完整拆解分析</div>
      <div class="vp-analysis">${analysis.replace(/\\n/g, '<br>')}</div>
    </div>
  `;
  showVideoPlayer(title, videoUrl, contentHtml);
}

// ===== 顾客跟进视图 =====
const PRIORITY = {
  urgent: { label: '7天紧急回访', tag: 'urgent', class: 'priority-urgent' },
  month:  { label: '1个月内回访', tag: 'month', class: 'priority-month' },
  long:   { label: '长期慢慢跟进', tag: 'long', class: 'priority-long' }
};

// 数据迁移：将旧格式转换为新格式（多项目归集）
function migrateCustomers(customers) {
  return customers.map(c => {
    if (!c.projects) {
      c.projects = [];
      if (c.project) {
        c.projects.push({
          id: 'p' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
          name: c.project,
          thought: c.thought || '',
          date: c.createdAt || formatDate(new Date()),
          completed: c.completed || false
        });
      }
      delete c.project;
      delete c.thought;
    }
    if (!c.entries) c.entries = [];
    return c;
  });
}

let custSearchKeyword = '';

function renderCustomers(view) {
  let customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  Store.set('customers', customers);

  // 搜索过滤
  const keyword = custSearchKeyword.toLowerCase().trim();
  let filtered = customers;
  if (keyword) {
    filtered = customers.filter(c => {
      if (c.name.toLowerCase().includes(keyword)) return true;
      if (c.projects && c.projects.some(p => p.name.toLowerCase().includes(keyword))) return true;
      if (c.followups && c.followups.some(f => f.content.toLowerCase().includes(keyword))) return true;
      return false;
    });
  }

  // 统计
  const active = filtered.filter(c => !c.completed);
  const urgentCount = active.filter(c => c.priority === 'urgent').length;
  const monthCount  = active.filter(c => c.priority === 'month').length;
  const longCount   = active.filter(c => c.priority === 'long').length;
  const doneCount   = filtered.filter(c => c.completed).length;

  // 检查到期回访
  const todayStr = formatDate(new Date());
  let overdueCount = 0;
  active.forEach(c => {
    if (c.revisitDate && c.revisitDate <= todayStr) overdueCount++;
  });

  let html = `
    <div class="cust-search-bar">
      <input class="cust-search-input" id="custSearch" placeholder="🔍 搜索顾客姓名/项目名称/跟进内容..." value="${custSearchKeyword}" oninput="onCustSearch(this.value)">
    </div>
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

  html += `
    <button class="btn btn-primary btn-full" onclick="showAddCustomer()" style="margin-bottom:14px;">
      ➕ 新增顾客跟进
    </button>
  `;

  if (keyword) {
    html += `<div class="section-title">搜索结果 (${filtered.length})</div>`;
  } else {
    html += `<div class="section-title">待跟进顾客 (${active.length})</div>`;
  }

  if (filtered.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">👥</div><div class="es-text">${keyword ? '没有找到匹配的顾客' : '还没有待跟进的顾客，点击上方按钮添加'}</div></div>`;
  } else {
    // 按优先级排序
    const order = { urgent: 0, month: 1, long: 2 };
    active.sort((a, b) => (order[a.priority] || 2) - (order[b.priority] || 2));
    html += active.map(c => renderCustomerItem(c)).join('');
  }

  // 已完成列表
  if (doneCount > 0 && !keyword) {
    html += `<div class="cust-done-section">`;
    html += `<div class="cust-done-header">✅ 已完成/已成交 (${doneCount})</div>`;
    html += filtered.filter(c => c.completed).map(c => renderCustomerItem(c)).join('');
    html += `</div>`;
  }

  view.innerHTML = html;
}

function onCustSearch(val) {
  custSearchKeyword = val;
  const view = document.getElementById('view-customers');
  if (view) renderCustomers(view);
}

function renderCustomerItem(c) {
  const p = PRIORITY[c.priority] || PRIORITY.long;
  const isOverdue = c.revisitDate && c.revisitDate <= formatDate(new Date()) && !c.completed;

  // 项目标签
  let projectTagsHtml = '';
  if (c.projects && c.projects.length > 0) {
    projectTagsHtml = '<div class="cust-project-tags">';
    c.projects.forEach(proj => {
      projectTagsHtml += `<span class="cust-project-tag ${proj.completed ? 'done' : ''}">${proj.name}</span>`;
    });
    projectTagsHtml += '</div>';
  }

  // 最新动态
  let latestActivity = '';
  const allEntries = getAllEntries(c);
  if (allEntries.length > 0) {
    const latest = allEntries[0]; // already sorted newest first
    latestActivity = `<div class="cust-latest-activity"><span class="cla-label">${latest.typeLabel}</span> ${latest.date}：${latest.summary}</div>`;
  }

  return `
    <div class="cust-item ${c.completed ? 'completed' : p.class}" onclick="showCustomerDetail('${c.id}')">
      <div class="cust-item-header">
        <div class="cust-name">${c.name}</div>
        ${c.completed
          ? '<span class="cust-priority-tag" style="background:#E0E0E0;color:#757575;">已完成</span>'
          : `<span class="cust-priority-tag ${p.tag}">${p.label}</span>`
        }
      </div>
      ${c.contact ? `<div class="cust-field"><span class="cust-field-label">联系方式：</span>${c.contact}</div>` : ''}
      ${projectTagsHtml}
      ${latestActivity}
      ${c.revisitDate ? `<div class="cust-revisit-date ${isOverdue ? 'overdue' : ''}">📅 回访时间：${c.revisitDate}${isOverdue ? ' ⚠已到期' : ''}</div>` : ''}
      <div class="cust-actions" onclick="event.stopPropagation()">
        ${!c.completed ? `<button class="cust-action-btn" onclick="showAddFollowup('${c.id}')">💬 记跟进</button>` : ''}
        ${!c.completed ? `<button class="cust-action-btn" onclick="showAddProject('${c.id}')">📌 新增项目</button>` : ''}
        <button class="cust-action-btn" onclick="showCustomerDetail('${c.id}')">📋 详情</button>
        <button class="cust-action-btn" onclick="showEditCustomer('${c.id}')">✏️ 编辑</button>
        ${!c.completed ? `<button class="cust-action-btn success" onclick="toggleCustomerDone('${c.id}')">✅ 完成成交</button>` : ''}
        ${c.completed ? `<button class="cust-action-btn" onclick="toggleCustomerDone('${c.id}')">↩️ 恢复跟进</button>` : ''}
        <button class="cust-action-btn danger" onclick="deleteCustomer('${c.id}')">🗑 删除</button>
      </div>
    </div>
  `;
}

// 获取顾客所有记录条目（项目+跟进），按时间倒序排列
function getAllEntries(c) {
  const entries = [];
  if (c.projects) {
    c.projects.forEach(p => {
      entries.push({
        id: p.id,
        type: 'project',
        typeLabel: '📌 项目铺垫',
        date: p.date || '',
        summary: p.name + (p.thought ? ' - ' + p.thought : ''),
        projectName: p.name,
        thought: p.thought,
        completed: p.completed,
        sortDate: p.date || ''
      });
    });
  }
  if (c.followups) {
    c.followups.forEach(f => {
      const proj = c.projects ? c.projects.find(p => p.id === f.projectId) : null;
      entries.push({
        id: f.id || ('f' + f.date),
        type: 'followup',
        typeLabel: '💬 跟进记录',
        date: f.date || '',
        summary: f.content + (proj ? ' [' + proj.name + ']' : ''),
        content: f.content,
        projectName: proj ? proj.name : '',
        revisitDate: f.revisitDate || '',
        completed: false,
        sortDate: f.date || ''
      });
    });
  }
  // 按日期倒序排列
  entries.sort((a, b) => (b.sortDate || '').localeCompare(a.sortDate || ''));
  return entries;
}

// 顾客详情（时间线视图）
function showCustomerDetail(cid) {
  let customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const c = customers.find(cu => cu.id === cid);
  if (!c) return;

  const p = PRIORITY[c.priority] || PRIORITY.long;
  const allEntries = getAllEntries(c);
  const activeEntries = allEntries.filter(e => !e.completed);
  const completedEntries = allEntries.filter(e => e.completed);

  // 检查是否有消费记录
  const consumption = Store.get('consumption', []);
  const custConsumption = consumption.filter(r => r.name === c.name);

  let html = `
    <div class="modal-header">
      <div class="modal-title">📋 ${c.name} 档案</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="margin-bottom:10px;">
      ${c.contact ? `<div class="cust-field"><span class="cust-field-label">联系方式：</span>${c.contact}</div>` : ''}
      <div class="cust-field"><span class="cust-field-label">优先级：</span><span class="cust-priority-tag ${p.tag}">${p.label}</span></div>
      ${c.revisitDate ? `<div class="cust-revisit-date ${c.revisitDate <= formatDate(new Date()) && !c.completed ? 'overdue' : ''}">📅 回访时间：${c.revisitDate}${c.revisitDate <= formatDate(new Date()) && !c.completed ? ' ⚠已到期' : ''}</div>` : ''}
    </div>
    <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
      ${!c.completed ? `<button class="cust-action-btn" onclick="closeModal();showAddFollowup('${c.id}')">💬 记跟进</button>` : ''}
      ${!c.completed ? `<button class="cust-action-btn" onclick="closeModal();showAddProject('${c.id}')">📌 新增项目</button>` : ''}
      ${custConsumption.length > 0 ? `<button class="cust-cross-link" onclick="closeModal();switchView('consumption');setTimeout(()=>{document.getElementById('consumptionSearch').value='${c.name}';onConsumptionSearch('${c.name}');},100)">💳 查看消费记录(${custConsumption.length})</button>` : ''}
      <button class="cust-cross-link" onclick="closeModal();switchView('consumption');setTimeout(()=>{document.getElementById('consumptionSearch').value='${c.name}';onConsumptionSearch('${c.name}');},100)">💳 消费管理</button>
    </div>
  `;

  // 时间线
  html += `<div class="section-title">沟通全周期轨迹 (${allEntries.length})</div>`;
  html += `<div class="cust-timeline">`;
  if (activeEntries.length === 0 && completedEntries.length === 0) {
    html += `<div style="text-align:center;padding:20px;color:var(--text-light);font-size:13px;">暂无记录，点击上方按钮新增项目或跟进</div>`;
  } else {
    activeEntries.forEach(e => {
      html += renderTimelineEntry(e);
    });
    if (completedEntries.length > 0) {
      html += `<div style="font-size:12px;color:var(--text-light);margin-top:10px;padding:4px 0;border-top:1px dashed #E0E0E0;">已完成项目</div>`;
      completedEntries.forEach(e => {
        html += renderTimelineEntry(e);
      });
    }
  }
  html += `</div>`;

  showModal(html);
}

function renderTimelineEntry(e) {
  return `
    <div class="cust-timeline-entry type-${e.type} ${e.completed ? 'completed' : ''}">
      <span class="te-type">${e.typeLabel}</span>
      <span class="te-date">${e.date}</span>
      ${e.projectName ? `<span class="te-project-name">[${e.projectName}]</span>` : ''}
      <div class="te-content">${e.type === 'project' ? (e.thought || e.projectName) : e.content}</div>
      ${e.revisitDate ? `<div style="font-size:11px;color:var(--text-light);margin-top:2px;">📅 约定回访：${e.revisitDate}</div>` : ''}
    </div>
  `;
}

function showAddCustomer() {
  const html = `
    <div class="modal-header">
      <div class="modal-title">新增顾客跟进</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="custName" placeholder="顾客姓名" autofocus oninput="checkCustName(this.value)">
    <div id="custNameHint" style="font-size:12px;margin-top:-6px;margin-bottom:8px;display:none;"></div>
    <input class="input-field" id="custContact" placeholder="联系方式（手机号/微信号）">
    <input class="input-field" id="custProject" placeholder="铺垫项目（如：热玛吉/水光针）">
    <textarea class="input-field" id="custThought" placeholder="顾客想法/分析" rows="2"></textarea>
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

// 检查顾客姓名是否已存在（一人一档）
function checkCustName(name) {
  const hint = document.getElementById('custNameHint');
  if (!name.trim()) { hint.style.display = 'none'; return; }
  const customers = Store.get('customers', []);
  const existing = customers.find(c => c.name === name.trim());
  if (existing) {
    hint.style.display = 'block';
    hint.style.color = '#F44336';
    hint.innerHTML = '⚠️ 该顾客已存在档案，新内容将归集到现有档案中';
  } else {
    hint.style.display = 'none';
  }
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
  const contact = document.getElementById('custContact').value.trim();
  const project = document.getElementById('custProject').value.trim();
  const thought = document.getElementById('custThought').value.trim();
  const revisitDate = document.getElementById('custRevisit').value || '';

  const customers = Store.get('customers', []);
  // 一人一档：检查是否已有该顾客
  const existingIdx = customers.findIndex(c => c.name === name);

  if (existingIdx >= 0) {
    // 归集到现有档案
    const c = customers[existingIdx];
    if (!c.projects) c.projects = [];
    if (project) {
      c.projects.push({
        id: 'p' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
        name: project,
        thought: thought,
        date: formatDate(new Date()),
        completed: false
      });
    }
    if (contact) c.contact = contact;
    if (revisitDate) c.revisitDate = revisitDate;
    c.priority = selectedPriority;
    c.completed = false;
    Store.set('customers', customers);
    closeModal();
    speak('已归集到现有顾客档案');
    renderCustomers(document.getElementById('view-customers'));
  } else {
    // 新建档案
    const newCust = {
      id: 'c' + Date.now(),
      name, contact,
      priority: selectedPriority,
      followups: [],
      completed: false,
      createdAt: formatDate(new Date()),
      revisitDate: revisitDate,
      projects: []
    };
    if (project) {
      newCust.projects.push({
        id: 'p' + Date.now() + '_1',
        name: project,
        thought: thought,
        date: formatDate(new Date()),
        completed: false
      });
    }
    customers.push(newCust);
    Store.set('customers', customers);
    closeModal();
    speak('已添加顾客');
    renderCustomers(document.getElementById('view-customers'));
  }
}

function showEditCustomer(cid) {
  let customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const c = customers.find(cu => cu.id === cid);
  if (!c) return;

  selectedPriority = c.priority || 'long';
  const html = `
    <div class="modal-header">
      <div class="modal-title">编辑顾客基础信息</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="editCustName" value="${c.name.replace(/"/g,'&quot;')}" autofocus>
    <input class="input-field" id="editCustContact" value="${(c.contact||'').replace(/"/g,'&quot;')}" placeholder="联系方式">
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
  const contact = document.getElementById('editCustContact').value.trim();
  const revisitDate = document.getElementById('editCustRevisit').value || '';

  const customers = Store.get('customers', []);
  const idx = customers.findIndex(cu => cu.id === cid);
  if (idx < 0) return;
  customers[idx].name = name;
  customers[idx].contact = contact;
  customers[idx].revisitDate = revisitDate;
  customers[idx].priority = selectedPriority;
  Store.set('customers', customers);
  closeModal();
  speak('已更新');
  renderCustomers(document.getElementById('view-customers'));
}

// 新增项目到已有顾客
function showAddProject(cid) {
  let customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const c = customers.find(cu => cu.id === cid);
  if (!c) return;

  let existingProjectsHtml = '';
  if (c.projects && c.projects.length > 0) {
    existingProjectsHtml = '<div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">已有项目：' + 
      c.projects.map(p => `<span class="cust-project-tag ${p.completed?'done':''}">${p.name}</span>`).join('') + '</div>';
  }

  const html = `
    <div class="modal-header">
      <div class="modal-title">📌 为 ${c.name} 新增项目</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    ${existingProjectsHtml}
    <input class="input-field" id="newProjectName" placeholder="新增铺垫项目名称" autofocus>
    <textarea class="input-field" id="newProjectThought" placeholder="顾客想法/分析" rows="2"></textarea>
    <button class="btn btn-primary btn-full" onclick="saveAddProject('${cid}')">保存</button>
  `;
  showModal(html);
}

function saveAddProject(cid) {
  const projectName = document.getElementById('newProjectName').value.trim();
  if (!projectName) { showToast('请输入项目名称'); return; }
  const thought = document.getElementById('newProjectThought').value.trim();

  const customers = Store.get('customers', []);
  const idx = customers.findIndex(cu => cu.id === cid);
  if (idx < 0) return;
  if (!customers[idx].projects) customers[idx].projects = [];
  customers[idx].projects.push({
    id: 'p' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    name: projectName,
    thought: thought,
    date: formatDate(new Date()),
    completed: false
  });
  Store.set('customers', customers);
  closeModal();
  speak('已添加新项目');
  renderCustomers(document.getElementById('view-customers'));
}

function showAddFollowup(cid) {
  let customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const c = customers.find(cu => cu.id === cid);
  if (!c) return;

  // 生成项目选择下拉
  let projectSelectHtml = '';
  if (c.projects && c.projects.length > 0) {
    projectSelectHtml = '<select class="input-field" id="followupProject"><option value="">不关联项目</option>' +
      c.projects.map(p => `<option value="${p.id}">${p.name}${p.completed?' (已完成)':''}</option>`).join('') +
      '</select>';
  }

  const html = `
    <div class="modal-header">
      <div class="modal-title">记录跟进内容 - ${c.name}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    ${projectSelectHtml}
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
  const projectId = document.getElementById('followupProject') ? document.getElementById('followupProject').value : '';

  const customers = Store.get('customers', []);
  const idx = customers.findIndex(cu => cu.id === cid);
  if (idx < 0) return;
  if (!customers[idx].followups) customers[idx].followups = [];
  customers[idx].followups.push({
    id: 'f' + Date.now(),
    projectId: projectId || null,
    content,
    date: formatDate(new Date()),
    revisitDate: nextRevisit || ''
  });
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
    // 标记所有项目为完成
    if (customers[idx].projects) {
      customers[idx].projects.forEach(p => p.completed = true);
    }
    speak('已标记完成，恭喜成交');
  } else {
    delete customers[idx].completedDate;
    if (customers[idx].projects) {
      customers[idx].projects.forEach(p => p.completed = false);
    }
    speak('已恢复跟进');
  }
  Store.set('customers', customers);
  renderCustomers(document.getElementById('view-customers'));
}

function deleteCustomer(cid) {
  if (!confirm('确定删除该顾客全部档案吗？所有项目和跟进记录将被清除。')) return;
  const customers = Store.get('customers', []);
  const filtered = customers.filter(cu => cu.id !== cid);
  Store.set('customers', filtered);
  speak('已删除');
  renderCustomers(document.getElementById('view-customers'));
}

// ===== 顾客消费管理视图 =====
let consumptionSearchKeyword = '';
let consumptionFilterProject = '';
let consumptionFilterStatus = '';
let consumptionShowArchived = false;

function renderConsumption(view) {
  const records = Store.get('consumption', []);

  // 搜索过滤
  const keyword = consumptionSearchKeyword.toLowerCase().trim();
  let filtered = records;
  if (keyword) {
    filtered = filtered.filter(r =>
      r.name.toLowerCase().includes(keyword) ||
      (r.contact && r.contact.toLowerCase().includes(keyword)) ||
      (r.project && r.project.toLowerCase().includes(keyword))
    );
  }
  if (consumptionFilterProject) {
    filtered = filtered.filter(r => r.project === consumptionFilterProject);
  }
  if (consumptionFilterStatus) {
    filtered = filtered.filter(r => r.status === consumptionFilterStatus);
  }
  if (!consumptionShowArchived) {
    filtered = filtered.filter(r => !r.archived);
  }

  // 统计
  const totalAmount = filtered.filter(r => !r.archived).reduce((s,r) => s + (r.amount||0), 0);
  const totalRecords = filtered.filter(r => !r.archived).length;
  const uniqueCustomers = new Set(filtered.filter(r => !r.archived).map(r => r.name)).size;

  // 获取所有项目名称（用于筛选下拉）
  const allProjects = [...new Set(records.map(r => r.project).filter(Boolean))].sort();

  let html = `
    <div class="consumption-stats">
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">${totalRecords}</div>
        <div class="consumption-stat-label">消费笔数</div>
      </div>
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">${uniqueCustomers}</div>
        <div class="consumption-stat-label">消费顾客</div>
      </div>
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">¥${totalAmount.toFixed(0)}</div>
        <div class="consumption-stat-label">消费总额</div>
      </div>
    </div>
    <div class="consumption-search-bar">
      <input class="consumption-search-input" id="consumptionSearch" placeholder="🔍 搜索顾客姓名/手机号/消费项目..." value="${consumptionSearchKeyword}" oninput="onConsumptionSearch(this.value)">
    </div>
    <div class="consumption-filter-bar">
      <select class="consumption-filter-select" onchange="onConsumptionFilterProject(this.value)">
        <option value="">所有项目</option>
        ${allProjects.map(p => `<option value="${p}" ${consumptionFilterProject===p?'selected':''}>${p}</option>`).join('')}
      </select>
      <select class="consumption-filter-select" onchange="onConsumptionFilterStatus(this.value)">
        <option value="">所有状态</option>
        <option value="paid" ${consumptionFilterStatus==='paid'?'selected':''}>已付款未操作</option>
        <option value="done" ${consumptionFilterStatus==='done'?'selected':''}>已做完项目</option>
        <option value="aftercare" ${consumptionFilterStatus==='aftercare'?'selected':''}>售后保养阶段</option>
      </select>
      <label class="consumption-archive-toggle">
        <input type="checkbox" ${consumptionShowArchived?'checked':''} onchange="onConsumptionToggleArchived(this.checked)"> 显示已归档
      </label>
    </div>
    <button class="btn btn-primary btn-full" onclick="showAddConsumption()" style="margin-bottom:12px;">
      ➕ 新增消费记录
    </button>
  `;

  // 按顾客分组，每个顾客内按时间倒序
  const byCustomer = {};
  filtered.forEach(r => {
    if (!byCustomer[r.name]) byCustomer[r.name] = [];
    byCustomer[r.name].push(r);
  });

  // 每组内按日期倒序
  Object.keys(byCustomer).forEach(name => {
    byCustomer[name].sort((a,b) => (b.date||'').localeCompare(a.date||''));
  });

  const customerNames = Object.keys(byCustomer).sort();
  if (customerNames.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">💳</div><div class="es-text">${keyword ? '没有找到匹配的消费记录' : '还没有消费记录，点击上方按钮添加'}</div></div>`;
  } else {
    html += `<div class="section-title">消费记录 (${customerNames.length} 位顾客)</div>`;
    customerNames.forEach(name => {
      const custRecords = byCustomer[name];
      html += custRecords.map(r => renderConsumptionItem(r)).join('');
    });
  }

  view.innerHTML = html;
}

function renderConsumptionItem(r) {
  const statusMap = {
    paid: { label: '已付款未操作', class: 'status-paid' },
    done: { label: '已做完项目', class: 'status-done' },
    aftercare: { label: '售后保养阶段', class: 'status-aftercare' }
  };
  const st = statusMap[r.status] || statusMap.paid;

  // 跨表联动：检查是否有跟进记录
  const customers = Store.get('customers', []);
  const hasFollowup = customers.some(c => c.name === r.name);

  return `
    <div class="consumption-item ${st.class} ${r.archived ? 'archived' : ''}">
      <div class="consumption-item-header">
        <div class="consumption-item-name">${r.name}</div>
        <span class="consumption-item-status ${st.class}">${st.label}</span>
      </div>
      ${r.contact ? `<div class="consumption-item-field"><span class="cif-label">联系方式：</span>${r.contact}</div>` : ''}
      <div class="consumption-item-field"><span class="cif-label">消费项目：</span>${r.project || '-'}</div>
      <div class="consumption-item-amount">¥${(r.amount||0).toFixed(2)}</div>
      <div class="consumption-item-field"><span class="cif-label">成交日期：</span>${r.date || '-'}</div>
      ${r.notes ? `<div class="consumption-item-field"><span class="cif-label">售后备注：</span>${r.notes}</div>` : ''}
      ${r.archived ? '<div class="consumption-item-field" style="color:var(--gray);">📦 已归档</div>' : ''}
      <div class="consumption-item-actions">
        <button onclick="showEditConsumption('${r.id}')">✏️ 编辑</button>
        ${hasFollowup ? `<button onclick="jumpToFollowup('${r.name.replace(/'/g, "\\'")}')">👥 查看跟进档案</button>` : ''}
        ${!r.archived ? `<button class="archive" onclick="archiveConsumption('${r.id}')">📦 归档</button>` : `<button class="archive" onclick="unarchiveConsumption('${r.id}')">📤 取消归档</button>`}
        <button class="danger" onclick="deleteConsumption('${r.id}')">🗑 删除</button>
      </div>
    </div>
  `;
}

function onConsumptionSearch(val) {
  consumptionSearchKeyword = val;
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}
function onConsumptionFilterProject(val) {
  consumptionFilterProject = val;
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}
function onConsumptionFilterStatus(val) {
  consumptionFilterStatus = val;
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}
function onConsumptionToggleArchived(checked) {
  consumptionShowArchived = checked;
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}

// 跨表联动：从消费跳转到跟进
function jumpToFollowup(name) {
  custSearchKeyword = name;
  switchView('customers');
}

function showAddConsumption() {
  // 获取已有顾客名用于自动联想提示
  const customers = Store.get('customers', []);
  const custNames = customers.map(c => c.name);

  const html = `
    <div class="modal-header">
      <div class="modal-title">新增消费记录</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="consName" placeholder="顾客姓名" autofocus list="custNameList" oninput="checkConsName(this.value)">
    <datalist id="custNameList">
      ${custNames.map(n => `<option value="${n}">`).join('')}
    </datalist>
    <div id="consNameHint" style="font-size:12px;margin-top:-6px;margin-bottom:8px;display:none;"></div>
    <input class="input-field" id="consContact" placeholder="联系方式（手机号/微信号）">
    <input class="input-field" id="consProject" placeholder="消费项目名称（如：双眼皮/胶原水光）">
    <input class="input-field" type="number" id="consAmount" placeholder="实际消费金额" step="0.01">
    <input class="input-field" type="date" id="consDate" value="${formatDate(new Date())}">
    <div class="section-title">操作完成状态</div>
    <select class="input-field" id="consStatus">
      <option value="paid">已付款未操作</option>
      <option value="done">已做完项目</option>
      <option value="aftercare">售后保养阶段</option>
    </select>
    <textarea class="input-field" id="consNotes" placeholder="售后备注（术后反应/复诊约定/顾客反馈等）" rows="2"></textarea>
    <button class="btn btn-primary btn-full" onclick="saveNewConsumption()">保存</button>
  `;
  showModal(html);
}

function checkConsName(name) {
  const hint = document.getElementById('consNameHint');
  if (!name.trim()) { hint.style.display = 'none'; return; }
  const customers = Store.get('customers', []);
  const existing = customers.find(c => c.name === name.trim());
  if (existing) {
    hint.style.display = 'block';
    hint.style.color = '#4CAF50';
    hint.innerHTML = '✅ 已关联跟进档案';
  } else {
    hint.style.display = 'block';
    hint.style.color = '#FF9800';
    hint.innerHTML = '💡 该顾客暂无跟进档案，将独立记录';
  }
}

function saveNewConsumption() {
  const name = document.getElementById('consName').value.trim();
  if (!name) { showToast('请输入顾客姓名'); return; }
  const contact = document.getElementById('consContact').value.trim();
  const project = document.getElementById('consProject').value.trim();
  const amount = parseFloat(document.getElementById('consAmount').value);
  if (!amount || amount <= 0) { showToast('请输入有效金额'); return; }
  const date = document.getElementById('consDate').value || formatDate(new Date());
  const status = document.getElementById('consStatus').value;
  const notes = document.getElementById('consNotes').value.trim();

  const records = Store.get('consumption', []);
  records.push({
    id: 'r' + Date.now(),
    name, contact, project, amount, date, status, notes,
    archived: false,
    createdAt: formatDate(new Date())
  });
  Store.set('consumption', records);
  closeModal();
  speak('已记录消费');
  renderConsumption(document.getElementById('view-consumption'));
}

function showEditConsumption(rid) {
  const records = Store.get('consumption', []);
  const r = records.find(rec => rec.id === rid);
  if (!r) return;

  const html = `
    <div class="modal-header">
      <div class="modal-title">编辑消费记录</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="editConsName" value="${r.name.replace(/"/g,'&quot;')}" autofocus>
    <input class="input-field" id="editConsContact" value="${(r.contact||'').replace(/"/g,'&quot;')}" placeholder="联系方式">
    <input class="input-field" id="editConsProject" value="${(r.project||'').replace(/"/g,'&quot;')}" placeholder="消费项目">
    <input class="input-field" type="number" id="editConsAmount" value="${r.amount||0}" step="0.01">
    <input class="input-field" type="date" id="editConsDate" value="${r.date||''}">
    <div class="section-title">操作完成状态</div>
    <select class="input-field" id="editConsStatus">
      <option value="paid" ${r.status==='paid'?'selected':''}>已付款未操作</option>
      <option value="done" ${r.status==='done'?'selected':''}>已做完项目</option>
      <option value="aftercare" ${r.status==='aftercare'?'selected':''}>售后保养阶段</option>
    </select>
    <textarea class="input-field" id="editConsNotes" rows="2" placeholder="售后备注">${r.notes||''}</textarea>
    <button class="btn btn-primary btn-full" onclick="saveEditConsumption('${rid}')">保存</button>
  `;
  showModal(html);
}

function saveEditConsumption(rid) {
  const name = document.getElementById('editConsName').value.trim();
  if (!name) { showToast('请输入顾客姓名'); return; }
  const contact = document.getElementById('editConsContact').value.trim();
  const project = document.getElementById('editConsProject').value.trim();
  const amount = parseFloat(document.getElementById('editConsAmount').value);
  if (!amount || amount <= 0) { showToast('请输入有效金额'); return; }
  const date = document.getElementById('editConsDate').value || formatDate(new Date());
  const status = document.getElementById('editConsStatus').value;
  const notes = document.getElementById('editConsNotes').value.trim();

  const records = Store.get('consumption', []);
  const idx = records.findIndex(r => r.id === rid);
  if (idx < 0) return;
  records[idx] = { ...records[idx], name, contact, project, amount, date, status, notes };
  Store.set('consumption', records);
  closeModal();
  speak('已更新');
  renderConsumption(document.getElementById('view-consumption'));
}

function archiveConsumption(rid) {
  const records = Store.get('consumption', []);
  const idx = records.findIndex(r => r.id === rid);
  if (idx < 0) return;
  records[idx].archived = true;
  Store.set('consumption', records);
  speak('已归档');
  renderConsumption(document.getElementById('view-consumption'));
}

function unarchiveConsumption(rid) {
  const records = Store.get('consumption', []);
  const idx = records.findIndex(r => r.id === rid);
  if (idx < 0) return;
  records[idx].archived = false;
  Store.set('consumption', records);
  speak('已取消归档');
  renderConsumption(document.getElementById('view-consumption'));
}

function deleteConsumption(rid) {
  if (!confirm('确定删除该消费记录吗？')) return;
  const records = Store.get('consumption', []);
  const filtered = records.filter(r => r.id !== rid);
  Store.set('consumption', filtered);
  speak('已删除');
  renderConsumption(document.getElementById('view-consumption'));
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
    <button class="btn btn-outline btn-full btn-sm" onclick="showVoicePresetModal()" style="margin-bottom:8px;">🎵 12款音色选择与调节</button>
    <div class="card" style="margin-top:8px;">
      <div style="font-size:13px;color:var(--text-light);line-height:1.8;">
        🎵 已内置12款原创合规音色（男声6款 + 女声6款）<br>
        📱 所有数据保存在本地浏览器中<br>
        ⏰ 未完成任务12:00和16:00自动提醒
      </div>
    </div>
  `;

  html += `<div class="section-title">数据管理</div>`;
  html += `
    <div class="card" style="margin-bottom:8px;border:1px solid #FFD1DC;background:#FFF5F8;">
      <div style="font-size:13px;color:var(--text-light);line-height:1.8;">
        ⚠️ <b>重要提醒</b><br>
        ☁️ 已开启云端同步，数据实时备份至独立云空间<br>
        💾 建议<span style="color:var(--pink);font-weight:bold;">每周导出一次</span>本地备份到手机
      </div>
    </div>
  `;

  // 云端同步区域
  html += `<div class="section-title">☁️ 云端同步</div>`;
  const isConnected = CloudSync.isConnected();
  const lastSync = Store.get('cloudLastSync', 0);
  html += `
    <div class="card" id="cloudSyncCard">
      <div id="cloudStatus" style="font-size:13px;margin-bottom:10px;">
        ${isConnected
          ? `✅ 已连接 · 上次同步：${lastSync ? new Date(lastSync).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '暂无'}`
          : `⚠️ 未连接 · 请设置GitHub Token开启云端同步</div>`
        }
      </div>
      <button class="btn btn-outline btn-full btn-sm" onclick="showCloudTokenModal()" style="margin-bottom:8px;">🔑 设置云端Token</button>
      <button class="btn btn-primary btn-full btn-sm" onclick="cloudSyncNow()" style="margin-bottom:8px;">☁️ 立即同步</button>
      <button class="btn btn-outline btn-full btn-sm" onclick="cloudCreateBackup()" style="margin-bottom:8px;">📦 创建备份包</button>
      ${isConnected ? '<button class="btn btn-outline btn-full btn-sm" onclick="loadCloudBackups()">📋 查看备份记录</button>' : ''}
    </div>
    <div id="cloudBackupList" style="margin-top:8px;"></div>
  `;

  html += `
    <div class="card">
      <button class="btn btn-primary btn-full btn-sm" onclick="exportData()" style="margin-bottom:8px;">📤 导出本地备份</button>
      <button class="btn btn-outline btn-full btn-sm" onclick="importData()" style="margin-bottom:8px;">📥 导入数据恢复</button>
      <div id="backupInfo" style="font-size:12px;color:var(--text-light);text-align:center;margin:8px 0;">检查中...</div>
      <button class="btn btn-outline btn-full btn-sm" style="border-color:var(--red);color:var(--red);" onclick="resetData()">🗑 清空所有数据</button>
    </div>
  `;

  view.innerHTML = html;
  checkBackup();
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
  ['tasks', 'completions', 'leaves', 'reminders', 'accounting', 'engProgress', 'voiceOn', 'customers', 'consumption'].forEach(k => {
    data[k] = Store.get(k);
  });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '妙妙工作台_数据_' + todayKey() + '.json';
  a.click();
  speak('已导出');
}

// ===== 自动备份（双重存储）=====
const BACKUP_KEY = 'mm_backup';
const BACKUP_TIME_KEY = 'mm_backup_time';

function autoBackup() {
  try {
    const data = {};
    let hasData = false;
    DATA_KEYS.forEach(k => {
      data[k] = Store.get(k);
      if (data[k] !== null && data[k] !== undefined) hasData = true;
    });
    if (hasData) {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(data));
      localStorage.setItem(BACKUP_TIME_KEY, new Date().toISOString());
    }
  } catch(e) { console.warn('Auto backup failed:', e); }
}

// 检查备份状态并尝试恢复
function checkBackup() {
  const backupInfo = document.getElementById('backupInfo');
  if (!backupInfo) return;

  const backupRaw = localStorage.getItem(BACKUP_KEY);
  const backupTime = localStorage.getItem(BACKUP_TIME_KEY);

  // 检查当前是否有数据
  let currentDataCount = 0;
  DATA_KEYS.forEach(k => {
    const v = Store.get(k);
    if (v && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
      currentDataCount++;
    }
  });

  if (backupRaw && backupTime) {
    const time = new Date(backupTime);
    const timeStr = time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const backupSize = backupRaw.length;

    if (currentDataCount === 0) {
      // 当前无数据但有备份 → 提示恢复
      backupInfo.innerHTML = `⚠️ 发现备份（${timeStr}，${(backupSize/1024).toFixed(1)}KB）<br><button class="btn btn-sm btn-primary" style="margin-top:6px;" onclick="restoreFromBackup()">🔄 恢复备份数据</button>`;
    } else {
      backupInfo.innerHTML = `✅ 上次备份：${timeStr}（${(backupSize/1024).toFixed(1)}KB）`;
    }
  } else {
    backupInfo.innerHTML = '📭 暂无备份记录，建议立即导出';
  }
}

function restoreFromBackup() {
  const backupRaw = localStorage.getItem(BACKUP_KEY);
  if (!backupRaw) { showToast('未找到备份数据'); return; }
  try {
    const data = JSON.parse(backupRaw);
    let restored = 0;
    DATA_KEYS.forEach(k => {
      if (data[k] !== null && data[k] !== undefined) {
        Store.set(k, data[k]);
        restored++;
      }
    });
    showToast('✅ 已从备份恢复 ' + restored + ' 项数据');
    speak('数据已恢复');
    setTimeout(() => location.reload(), 1500);
  } catch(e) {
    showToast('备份文件损坏，无法恢复');
  }
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const data = JSON.parse(ev.target.result);
        let restored = 0;
        DATA_KEYS.forEach(k => {
          if (data[k] !== null && data[k] !== undefined) {
            Store.set(k, data[k]);
            restored++;
          }
        });
        autoBackup(); // 立即备份
        showToast('✅ 成功导入 ' + restored + ' 项数据');
        speak('数据已导入');
        setTimeout(() => location.reload(), 1500);
      } catch(err) {
        showToast('❌ 文件格式错误，无法导入');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function resetData() {
  if (!confirm('确定清空所有数据吗？此操作不可恢复！')) return;
  localStorage.clear();
  renderSettings(document.getElementById('view-settings'));
  speak('已清空');
}

// ===== 云端同步 UI 函数 =====
function updateCloudSyncUI() {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  const lastSync = Store.get('cloudLastSync', 0);
  if (CloudSync.isConnected()) {
    el.innerHTML = `✅ 已连接 · 上次同步：${lastSync ? new Date(lastSync).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '初始同步中...'}`;
  } else {
    el.innerHTML = '⚠️ 未连接 · 请设置GitHub Token开启云端同步';
  }
}

function showCloudTokenModal() {
  const currentToken = CloudSync.getToken();
  const html = `
    <div class="modal-header">
      <div class="modal-title">🔑 设置云端同步</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:13px;color:var(--text-light);margin-bottom:12px;line-height:1.6;">
      设置GitHub Personal Access Token 开启云端同步。<br>
      数据将以 <b style="color:var(--pink);">AES加密</b> 存储至专属独立云空间，仅本账号可访问。<br><br>
      📌 获取方式：<br>
      1. 访问 <a href="https://github.com/settings/tokens" target="_blank" style="color:var(--pink);">github.com/settings/tokens</a><br>
      2. 生成 classic token，勾选 <b>repo</b> 权限<br>
      3. 复制 token 粘贴到下方<br>
      <span style="color:var(--red);">⚠️ Token仅保存在浏览器本地，不会泄露</span>
    </div>
    <input class="input-field" id="cloudTokenInput" type="password" placeholder="${currentToken ? '已设置Token（不显示）' : '粘贴GitHub Token'}" value="">
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary" style="flex:1;" onclick="saveCloudToken()">💾 保存并验证</button>
      ${currentToken ? '<button class="btn btn-outline" style="flex:1;color:var(--red);" onclick="disconnectCloud()">🔌 断开连接</button>' : ''}
    </div>
    <div id="cloudTokenStatus" style="margin-top:10px;font-size:13px;text-align:center;"></div>
  `;
  showModal(html);
}

async function saveCloudToken() {
  const input = document.getElementById('cloudTokenInput');
  const token = input.value.trim();
  const statusEl = document.getElementById('cloudTokenStatus');
  if (!token) {
    if (statusEl) statusEl.innerHTML = '⚠️ 请输入Token';
    return;
  }
  statusEl.innerHTML = '⏳ 验证中...';
  const valid = await CloudSync.verifyToken(token);
  if (valid) {
    CloudSync.setToken(token);
    statusEl.innerHTML = '✅ 验证成功！';
    setTimeout(() => {
      closeModal();
      renderSettings(document.getElementById('view-settings'));
      speak('云端同步已开启');
      // 首次连接，立即推送
      CloudSync.push().then(() => updateCloudSyncUI());
    }, 800);
  } else {
    statusEl.innerHTML = '❌ Token无效或账号不匹配';
  }
}

function disconnectCloud() {
  if (!confirm('确定断开云端连接吗？本地数据不会丢失。')) return;
  Store.del('cloudToken');
  Store.del('cloudLastSync');
  closeModal();
  renderSettings(document.getElementById('view-settings'));
  speak('云端连接已断开');
}

async function cloudSyncNow() {
  if (!CloudSync.isConnected()) { showToast('请先设置Token'); showCloudTokenModal(); return; }
  showToast('⏳ 同步中...');
  const r = await CloudSync.push();
  if (r.ok) {
    showToast('✅ 同步完成');
    updateCloudSyncUI();
    speak('同步完成');
  } else {
    showToast('❌ 同步失败: ' + (r.reason || '未知错误'));
  }
}

async function cloudCreateBackup() {
  if (!CloudSync.isConnected()) { showToast('请先设置Token'); showCloudTokenModal(); return; }
  showToast('⏳ 创建备份中...');
  const r = await CloudSync.createBackup();
  if (r.ok) {
    showToast('✅ 备份已创建: ' + r.name);
    speak('备份创建完成');
  } else {
    showToast('❌ 备份失败: ' + (r.reason || '未知错误'));
  }
}

async function loadCloudBackups() {
  if (!CloudSync.isConnected()) { showToast('请先设置Token'); return; }
  showToast('⏳ 加载备份列表...');
  const list = await CloudSync.listBackups();
  const container = document.getElementById('cloudBackupList');
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = `<div class="card"><div style="text-align:center;color:var(--text-light);font-size:13px;">📭 暂无云端备份记录<br><small>每次打开APP时自动创建每日备份</small></div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="section-title" style="margin-top:4px;">📋 备份记录 (${list.length})</div>
    <div class="card">
      <div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">选择时间节点恢复数据</div>
      ${list.slice(0, 15).map(b => `
        <div class="backup-row" style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:13px;">📦 ${b.label}</span>
          <span style="font-size:11px;color:var(--text-light);">${(b.size/1024).toFixed(1)}KB</span>
          <button class="btn btn-sm btn-outline" onclick="cloudRestore('${b.path}')">恢复</button>
        </div>
      `).join('')}
      ${list.length > 15 ? `<div style="text-align:center;color:var(--text-light);font-size:12px;margin-top:6px;">...仅显示最近15条备份</div>` : ''}
    </div>
  `;
}

async function cloudRestore(filepath) {
  if (!confirm('确定从云端恢复此备份吗？当前本地数据将被覆盖！')) return;
  showToast('⏳ 恢复中...');
  const r = await CloudSync.restore(filepath);
  if (r.ok) {
    showToast(`✅ 成功恢复 ${r.count} 项数据`);
    speak('数据已恢复');
    setTimeout(() => location.reload(), 1500);
  } else {
    showToast('❌ 恢复失败: ' + (r.reason || '未知错误'));
  }
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

function speak(text, rate, volume, pitch) {
  if (!Store.get('voiceOn', true)) return;
  if (!window.speechSynthesis) return;
  try { window.speechSynthesis.cancel(); } catch(e) {}
  const prefs = Store.get('voicePrefs', { presetId: 'v_female_elegant', rate: 0.85, volume: 1.0 });
  const preset = typeof VOICE_PRESETS !== 'undefined' ? (VOICE_PRESETS.find(p => p.id === prefs.presetId) || VOICE_PRESETS[6]) : null;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = rate || (preset ? preset.rate : 0.85);
  u.pitch = pitch || (preset ? preset.pitch : 1.1);
  u.volume = volume || (preset ? preset.volume : 1.0);
  // 根据预设性别选择音色
  const availableVoices = speechSynthesis.getVoices();
  if (availableVoices.length > 0 && preset) {
    const genderMatch = availableVoices.filter(v => v.lang.startsWith('zh') && (
      preset.gender === 'female' ? (v.name.includes('Female') || v.name.includes('Tingting') || v.name.includes('Xiaoxiao') || v.name.includes('Yaoyao') || v.name.includes('女')) :
      (v.name.includes('Male') || v.name.includes('男'))
    ));
    if (genderMatch.length > 0) u.voice = genderMatch[0];
    else {
      const zhVoice = availableVoices.find(v => v.lang.startsWith('zh'));
      if (zhVoice) u.voice = zhVoice;
    }
  }
  u.onerror = (e) => { if (e.error !== 'canceled' && e.error !== 'interrupted') console.log('语音错误:', e.error); };
  speechSynthesis.speak(u);
  // 语音提示
  const hint = document.getElementById('voiceHint');
  if (hint) { hint.style.display = 'block'; setTimeout(() => { hint.style.display = 'none'; }, 1000); }
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
  // 停止所有视频播放
  const videos = document.querySelectorAll('#modal video, #modal iframe');
  videos.forEach(v => { if (v.pause) v.pause(); v.src = ''; });
}
document.addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});

// ===== IndexedDB 音频存储 =====
const AudioDB = {
  _db: null,
  async _open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('mm_audio', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('audio', { keyPath: 'id' }); };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async save(id, blob) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').put({ id, blob });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  },
  async get(id) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readonly');
      const req = tx.objectStore('audio').get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => reject(req.error);
    });
  },
  async del(id) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').delete(id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
};

// ===== 录音状态 =====
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimer = null;
let isRecording = false;

// ===== 录音模块 =====
// ===== 录音复盘合并视图 =====
let reviewTab = 'recording'; // 'recording' | 'review'
function renderRecordingReview(view) {
  let html = `<div class="section-title">🎙️ 录音复盘</div>`;
  // Tab 切换
  html += `<div class="review-tabs">
    <div class="review-tab ${reviewTab === 'recording' ? 'active' : ''}" onclick="switchReviewTab('recording')">🎙️ 录音转写</div>
    <div class="review-tab ${reviewTab === 'review' ? 'active' : ''}" onclick="switchReviewTab('review')">🤖 AI复盘</div>
  </div><div id="reviewTabContent"></div>`;
  view.innerHTML = html;
  renderReviewTabContent();
}
function switchReviewTab(tab) {
  reviewTab = tab;
  renderReviewTabContent();
}
function renderReviewTabContent() {
  const container = document.getElementById('reviewTabContent');
  if (!container) return;
  if (reviewTab === 'recording') {
    // 复用录音功能渲染
    renderRecordingContent(container);
  } else {
    // 复用复盘功能渲染
    renderAIReviewContent(container);
  }
}

// ===== 面诊录音（原 renderRecording 内容提取）=====
function renderRecordingContent(container) {
  const recordings = Store.get('recordings', []);
  let html = '';
  // 录音控制区
  html += `
    <div class="card" style="text-align:center;padding:20px;">
      <div style="font-size:48px;margin-bottom:8px;" id="recIcon">🎙️</div>
      <div style="font-size:15px;font-weight:700;margin-bottom:4px;" id="recStatus">准备录音</div>
      <div style="font-size:24px;font-weight:800;color:var(--pink);margin-bottom:12px;display:none;" id="recTimer">00:00</div>
      <div style="display:flex;gap:8px;justify-content:center;">
        <button class="btn btn-primary" id="recStartBtn" onclick="startRecording()" style="padding:10px 24px;">▶ 开始录音</button>
        <button class="btn" style="background:#F44336;color:#fff;display:none;" id="recStopBtn" onclick="stopRecording()">⏹ 结束录音</button>
      </div>
      <div style="font-size:11px;color:var(--text-light);margin-top:10px;line-height:1.6;">
        ⚡ 开启录音后可返回首页正常使用<br>
        🔒 全程无录音标识，保护面诊隐私<br>
        📝 录音结束后支持一键转文字
      </div>
    </div>
  `;
  // 录音列表
  if (recordings.length > 0) {
    html += `<div class="section-title">历史录音 (${recordings.length})</div>`;
    [...recordings].reverse().forEach(r => {
      const dur = r.duration ? Math.floor(r.duration/60)+'分'+Math.floor(r.duration%60)+'秒' : '未知';
      const hasTranscript = r.transcript && r.transcript.length > 0;
      const linkedCustomer = r.customerName || '';
      html += `
        <div class="recording-item" id="rec-${r.id}">
          <div class="recording-item-header">
            <span style="font-size:16px;">🎵</span>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:14px;">${linkedCustomer ? '👤 '+linkedCustomer : '未关联顾客'}</div>
              <div style="font-size:12px;color:var(--text-light);">${r.date} · ${dur}</div>
            </div>
            ${hasTranscript ? '<span class="tag tag-green">已转写</span>' : '<span class="tag tag-orange">待转写</span>'}
          </div>
          <div class="recording-item-actions">
            <button class="btn btn-sm btn-outline" onclick="playRecording('${r.id}')">▶ 播放</button>
            ${!hasTranscript ? `<button class="btn btn-sm btn-primary" onclick="transcribeRecording('${r.id}')">📝 转文字</button>` : `<button class="btn btn-sm btn-outline" onclick="viewTranscript('${r.id}')">📄 查看文稿</button>`}
            ${!linkedCustomer ? `<button class="btn btn-sm btn-outline" onclick="linkToCustomer('${r.id}')">👤 关联顾客</button>` : ''}
            <button class="btn btn-sm btn-outline" style="color:var(--red);border-color:var(--red);" onclick="deleteRecording('${r.id}')">🗑</button>
          </div>
        </div>
      `;
    });
  } else {
    html += `<div class="empty-state"><div class="es-icon">🎙️</div><div class="es-text">暂无录音记录</div></div>`;
  }
  container.innerHTML = html;
  if (isRecording) updateRecordingUI();
}

// ===== AI复盘内容渲染（原 renderAIReview 内容提取）=====
function renderAIReviewContent(container) {
  const recordings = Store.get('recordings', []);
  const reviews = Store.get('reviewReports', []);
  const hasTranscripts = recordings.filter(r => r.transcript && r.transcript.length > 0);
  let html = '';
  html += `
    <div class="card" style="text-align:center;padding:16px;">
      <div style="font-size:36px;margin-bottom:6px;">🤖</div>
      <div style="font-size:14px;font-weight:700;">AI智能谈单分析</div>
      <div style="font-size:12px;color:var(--text-light);margin-top:4px;line-height:1.6;">
        自动分析谈单文稿<br>标注沟通短板 · 优化话术建议 · 生成复盘小结
      </div>
    </div>
  `;
  if (hasTranscripts.length > 0) {
    html += `<div class="section-title">选择文稿进行分析 (${hasTranscripts.length}份可用)</div>`;
    [...hasTranscripts].reverse().forEach(r => {
      const hasReview = reviews.some(rv => rv.recordingId === r.id);
      html += `
        <div class="card" style="padding:12px 14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-weight:700;font-size:14px;">${r.customerName || '未关联顾客'}</div>
              <div style="font-size:12px;color:var(--text-light);">${r.date} · ${r.transcript ? r.transcript.length+'字' : ''}</div>
            </div>
            <button class="btn btn-sm ${hasReview ? 'btn-outline' : 'btn-primary'}" onclick="runAIReview('${r.id}')">${hasReview ? '📋 查看报告' : '🤖 开始分析'}</button>
          </div>
        </div>
      `;
    });
  } else {
    html += `<div class="empty-state"><div class="es-icon">📝</div><div class="es-text">暂无已转写的录音文稿<br>请在「录音转写」中先转写录音</div></div>`;
  }
  if (reviews.length > 0) {
    html += `<div class="section-title">历史复盘报告 (${reviews.length})</div>`;
    [...reviews].reverse().forEach(rv => {
      html += `
        <div class="card" style="padding:12px 14px;">
          <div style="font-weight:700;font-size:14px;">📋 ${rv.customerName || '复盘报告'}</div>
          <div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">${rv.date} · 沟通短板${rv.issues ? rv.issues.length : 0}处</div>
          <div style="font-size:13px;color:var(--text);line-height:1.6;max-height:80px;overflow:hidden;">${rv.summary || ''}</div>
          <button class="btn btn-sm btn-outline" style="margin-top:8px;" onclick="showReviewDetail('${rv.id}')">📄 查看完整报告</button>
        </div>
      `;
    });
  }
  container.innerHTML = html;
}

// 保留旧接口以兼容内部回调，委托给新渲染器
function renderRecording(view) {
  renderRecordingContent(view);
}

function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('当前浏览器不支持录音功能，请使用Chrome或Safari');
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    isRecording = true;
    audioChunks = [];
    recordingStartTime = Date.now();
    mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      saveRecordingBlob();
    };
    mediaRecorder.start(1000); // 每秒收集一次数据
    updateRecordingUI();
    showToast('🔒 录音已开始（静默模式）');
    speak('开始录音');
  }).catch(() => {
    showToast('无法获取麦克风权限，请检查浏览器设置');
  });
}

function updateRecordingUI() {
  const startBtn = document.getElementById('recStartBtn');
  const stopBtn = document.getElementById('recStopBtn');
  const statusEl = document.getElementById('recStatus');
  const iconEl = document.getElementById('recIcon');
  const timerEl = document.getElementById('recTimer');
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (statusEl) statusEl.textContent = '● 录音中...';
  if (iconEl) iconEl.textContent = '🔴';
  if (timerEl) {
    timerEl.style.display = 'block';
    if (recordingTimer) clearInterval(recordingTimer);
    recordingTimer = setInterval(() => {
      if (!isRecording) { clearInterval(recordingTimer); return; }
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      if (timerEl) timerEl.textContent = m + ':' + s;
    }, 1000);
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  isRecording = false;
  if (recordingTimer) clearInterval(recordingTimer);
  mediaRecorder.stop();
  showToast('录音已保存，可转写为文字');
  speak('录音结束');
}

async function saveRecordingBlob() {
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  const id = 'rec_' + Date.now();
  const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
  const rec = {
    id, date: formatDateTime(new Date()), duration,
    hasAudio: true, transcript: '', segments: [],
    customerName: '', customerPhone: ''
  };
  await AudioDB.save(id, blob);
  const recordings = Store.get('recordings', []);
  recordings.push(rec);
  Store.set('recordings', recordings);
  // 重新渲染
  const view = document.getElementById('view-recording');
  if (view) renderRecording(view);
}

async function playRecording(id) {
  const blob = await AudioDB.get(id);
  if (!blob) { showToast('音频文件丢失'); return; }
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.play();
  showToast('▶ 正在播放...');
}

// ===== 转写 =====
function transcribeRecording(id) {
  const recordings = Store.get('recordings', []);
  const idx = recordings.findIndex(r => r.id === id);
  if (idx < 0) return;
  const rec = recordings[idx];
  let html = `
    <div class="modal-header">
      <div class="modal-title">📝 转写录音文稿</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:13px;color:var(--text-light);margin-bottom:12px;">
      ${rec.date} · ${rec.duration ? Math.floor(rec.duration/60)+'分'+rec.duration%60+'秒' : ''}
    </div>
    <div style="margin-bottom:8px;">
      <div class="section-title" style="margin:0 0 6px;">请输入顾客信息</div>
      <input class="input-field" id="transName" placeholder="顾客姓名" value="${rec.customerName||''}">
      <input class="input-field" id="transPhone" placeholder="手机号码" value="${rec.customerPhone||''}">
    </div>
    <div style="margin-bottom:8px;">
      <div class="section-title" style="margin:0 0 6px;">文稿内容（可逐段标注发言人）</div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button class="btn btn-sm btn-outline" onclick="addSegment('咨询师')" style="font-size:11px;">👩‍⚕️ 插入咨询师</button>
        <button class="btn btn-sm btn-outline" onclick="addSegment('顾客')" style="font-size:11px;">👤 插入顾客</button>
      </div>
      <textarea class="input-field" id="transText" style="min-height:200px;font-size:13px;" placeholder="输入文字稿...

提示：点击上方按钮标记发言人，格式为：
【咨询师】：您好，请问哪里不满意？
【顾客】：法令纹有点深..."></textarea>
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:12px;color:var(--text-light);cursor:pointer;" onclick="tryVoiceInput('${id}')">🎤 使用语音输入（浏览器语音识别）</div>
      <div id="voiceInputStatus" style="font-size:11px;color:var(--pink);margin-top:4px;display:none;">正在聆听...</div>
    </div>
    <button class="btn btn-primary btn-full" onclick="saveTranscript('${id}')">💾 保存文稿并归档</button>
  `;
  showModal(html);
}

// 语音输入（Web Speech API）
let speechRecognition = null;
function tryVoiceInput(id) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { showToast('浏览器不支持语音识别'); return; }
  if (!speechRecognition) {
    speechRecognition = new SpeechRecognition();
    speechRecognition.lang = 'zh-CN';
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const ta = document.getElementById('transText');
          if (ta) ta.value += event.results[i][0].transcript;
        } else { interim += event.results[i][0].transcript; }
      }
      const statusEl = document.getElementById('voiceInputStatus');
      if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '聆听中: ' + interim; }
    };
    speechRecognition.onend = () => {
      const statusEl = document.getElementById('voiceInputStatus');
      if (statusEl) statusEl.style.display = 'none';
    };
  }
  speechRecognition.start();
  showToast('🎤 开始语音输入，请说话');
}

function addSegment(role) {
  const ta = document.getElementById('transText');
  if (ta) {
    ta.value += (ta.value ? '\n' : '') + '【' + role + '】：';
    ta.focus();
  }
}

function saveTranscript(id) {
  const name = document.getElementById('transName').value.trim();
  const phone = document.getElementById('transPhone').value.trim();
  const text = document.getElementById('transText').value.trim();
  if (!text) { showToast('请输入文稿内容'); return; }
  // 解析分段
  const segPattern = /【(咨询师|顾客)】：/g;
  const segments = [];
  let lastIdx = 0, match;
  while ((match = segPattern.exec(text)) !== null) {
    if (lastIdx > 0 && segments.length > 0) {
      segments[segments.length-1].text = text.slice(lastIdx, match.index).trim();
    }
    segments.push({ role: match[1], text: '' });
    lastIdx = match.index + match[0].length;
  }
  if (segments.length > 0) {
    segments[segments.length-1].text = text.slice(lastIdx).trim();
  }
  const recordings = Store.get('recordings', []);
  const idx = recordings.findIndex(r => r.id === id);
  if (idx >= 0) {
    recordings[idx].transcript = text;
    recordings[idx].segments = segments;
    recordings[idx].customerName = name;
    recordings[idx].customerPhone = phone;
    Store.set('recordings', recordings);
    // 自动归集到顾客档案
    if (name) autoLinkToCustomerProfile(id, name, phone, text, 'recording');
    closeModal();
    const view = document.getElementById('view-recording');
    if (view) renderRecording(view);
    showToast('✅ 文稿已保存并归档');
    speak('文稿保存成功');
  }
}

// 自动归集到顾客档案
function autoLinkToCustomerProfile(recId, name, phone, transcript, type) {
  let customers = Store.get('customers', []);
  const key = name + '_' + (phone || 'nophone');
  let cust = customers.find(c => (c.name + '_' + (c.phone || 'nophone')) === key);
  if (!cust) {
    cust = {
      id: 'cust_' + Date.now(),
      name: name,
      phone: phone || '',
      projects: [],
      followups: [],
      recordings: [],
      reviews: [],
      status: 'active',
      createdAt: formatDateTime(new Date())
    };
    customers.push(cust);
  }
  if (!cust.recordings) cust.recordings = [];
  cust.recordings.push({
    recId, date: formatDateTime(new Date()),
    transcript: transcript.slice(0, 200),
    type: type
  });
  Store.set('customers', customers);
}

function viewTranscript(id) {
  const recordings = Store.get('recordings', []);
  const rec = recordings.find(r => r.id === id);
  if (!rec || !rec.transcript) { showToast('暂无文稿'); return; }
  let html = `
    <div class="modal-header">
      <div class="modal-title">📄 录音文稿</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-light);margin-bottom:12px;">
      ${rec.customerName ? '👤 '+rec.customerName+' · ' : ''}${rec.date}
    </div>
    <div style="background:var(--pink-soft);border-radius:12px;padding:14px;max-height:60vh;overflow-y:auto;line-height:1.8;font-size:13px;">
  `;
  if (rec.segments && rec.segments.length > 0) {
    rec.segments.forEach(seg => {
      html += `<div style="margin-bottom:10px;">
        <span style="font-weight:700;color:${seg.role==='咨询师'?'var(--pink)':'var(--lavender)'};">【${seg.role}】：</span>
        <span style="color:var(--text);">${seg.text}</span>
      </div>`;
    });
  } else {
    html += `<div style="white-space:pre-wrap;color:var(--text);">${rec.transcript}</div>`;
  }
  html += `</div>
    <div style="margin-top:12px;display:flex;gap:8px;">
      <button class="btn btn-outline btn-full btn-sm" onclick="copyText('${rec.transcript.replace(/'/g,"\\'").replace(/\n/g,'\\n')}')">📋 复制文稿</button>
      <button class="btn btn-primary btn-full btn-sm" onclick="closeModal();switchView('aireview');runAIReview('${id}')">🤖 AI复盘</button>
    </div>
  `;
  showModal(html);
}

function linkToCustomer(id) {
  const customers = Store.get('customers', []);
  let html = `
    <div class="modal-header">
      <div class="modal-title">👤 选择关联顾客</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
  `;
  if (customers.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">👥</div><div class="es-text">暂无顾客档案，请先在顾客跟进中添加</div></div>`;
  } else {
    customers.filter(c => c.status !== 'done').forEach(c => {
      html += `<div style="padding:12px;border-bottom:1px solid #F5F5F5;cursor:pointer;" onclick="doLinkRecording('${id}','${c.name}','${c.phone||''}')">
        <div style="font-weight:700;">${c.name}</div>
        <div style="font-size:12px;color:var(--text-light);">${c.phone||'未留电话'} · ${(c.projects||[]).map(p=>p.name).join('、')||'暂无项目'}</div>
      </div>`;
    });
  }
  html += `<div style="margin-top:8px;"><button class="btn btn-outline btn-full btn-sm" onclick="closeModal()">取消</button></div>`;
  showModal(html);
}

function doLinkRecording(recId, name, phone) {
  const recordings = Store.get('recordings', []);
  const idx = recordings.findIndex(r => r.id === recId);
  if (idx >= 0) { recordings[idx].customerName = name; recordings[idx].customerPhone = phone; }
  Store.set('recordings', recordings);
  closeModal();
  const view = document.getElementById('view-recording');
  if (view) renderRecording(view);
  showToast('✅ 已关联顾客: ' + name);
}

function deleteRecording(id) {
  if (!confirm('确定删除这条录音吗？')) return;
  AudioDB.del(id).catch(() => {});
  let recordings = Store.get('recordings', []);
  recordings = recordings.filter(r => r.id !== id);
  Store.set('recordings', recordings);
  const view = document.getElementById('view-recording');
  if (view) renderRecording(view);
  showToast('已删除');
}

// ===== AI智能谈单复盘 =====
// 保留旧接口以兼容内部回调，委托给新渲染器
function renderAIReview(view) {
  renderAIReviewContent(view);
}

function runAIReview(recordingId) {
  const recordings = Store.get('recordings', []);
  const rec = recordings.find(r => r.id === recordingId);
  if (!rec || !rec.transcript) { showToast('请先完成录音转写'); return; }

  const text = rec.transcript;
  const segments = rec.segments || [];

  // ===== AI分析引擎（基于规则的智能分析）=====
  const issues = [];
  const suggestions = [];

  // 1. 检查咨询师发言占比
  const consultantSegs = segments.filter(s => s.role === '咨询师');
  const customerSegs = segments.filter(s => s.role === '顾客');
  const consultantWords = consultantSegs.reduce((sum, s) => sum + s.text.length, 0);
  const customerWords = customerSegs.reduce((sum, s) => sum + s.text.length, 0);
  const totalWords = consultantWords + customerWords || 1;
  const consultantRatio = consultantWords / totalWords;

  if (consultantRatio > 0.75) {
    issues.push({ type: '话术节奏', desc: '咨询师发言占比过高(' + Math.round(consultantRatio*100) + '%)，缺少顾客互动和倾听', severity: 'medium' });
    suggestions.push('适当增加开放式提问，引导顾客表达真实需求和顾虑。建议咨询师发言控制在60-70%以内。');
  } else if (consultantRatio < 0.4) {
    issues.push({ type: '话术节奏', desc: '咨询师发言占比偏低(' + Math.round(consultantRatio*100) + '%)，可能存在被顾客带节奏的情况', severity: 'medium' });
    suggestions.push('加强专业输出和项目方案讲解，主动引导谈单方向。');
  }

  // 2. 检查顾客异议处理
  const customerText = customerSegs.map(s => s.text).join(' ');
  const concernKeywords = ['贵', '便宜', '考虑', '再看看', '怕', '担心', '疼', '痛', '效果', '没效果', '恢复', '假', '不自然', '安全', '风险', '犹豫', '算了'];
  const foundConcerns = concernKeywords.filter(kw => customerText.includes(kw));
  if (foundConcerns.length > 0) {
    const handled = foundConcerns.filter(kw => {
      const idx = customerText.indexOf(kw);
      // 检查咨询师是否在后面回应了
      const afterText = consultantSegs.filter(s => {
        const segIdx = text.indexOf(s.text);
        return segIdx > idx;
      }).map(s => s.text).join(' ');
      return afterText.length > 0;
    });
    if (handled.length < foundConcerns.length) {
      const unhandled = foundConcerns.filter(k => !handled.includes(k));
      issues.push({ type: '异议处理', desc: '以下顾客顾虑可能未被充分回应：' + unhandled.join('、'), severity: 'high' });
      suggestions.push('针对顾客的价格顾虑/效果担忧/安全担心，准备标准化应答话术，不回避问题。');
    }
  }

  // 3. 检查项目方案是否明确
  const projectKeywords = ['疗程', '方案', '建议', '推荐', '项目', '次', '间隔', '术后', '护理', '防晒'];
  const hasProjectMentioned = projectKeywords.some(kw => text.includes(kw));
  if (!hasProjectMentioned) {
    issues.push({ type: '方案讲解', desc: '未检测到明确的疗程方案讲解，可能只是做了产品介绍', severity: 'high' });
    suggestions.push('每个谈单必须明确输出"项目名称+疗程次数+间隔时间+预期效果+价格区间"五要素。');
  }

  // 4. 检查价格谈判
  const priceKeywords = ['钱', '价格', '费用', '优惠', '便宜', '贵', '折扣', '活动'];
  const hasPriceTalk = priceKeywords.some(kw => text.includes(kw));
  if (hasPriceTalk) {
    const bargainingPattern = /(能不能|可以.*便宜|少.*钱|打折|优惠).*/g;
    const hasBargaining = bargainingPattern.test(customerText);
    if (hasBargaining) {
      const priceResponse = consultantSegs.filter(s => s.text.includes('价格') || s.text.includes('优惠') || s.text.includes('价值')).map(s => s.text).join('');
      if (priceResponse.length < 30) {
        issues.push({ type: '议价应对', desc: '顾客有议价行为，但咨询师的回应较为简短，可能未充分进行价值锚定', severity: 'medium' });
        suggestions.push('议价时采用"价值锚定法"：先讲项目价值→再讲专业保障→最后给出福利补偿，而不是直接降价。');
      }
    }
  }

  // 5. 检查专业度
  const professionalTerms = ['屏障', '胶原', '黑素', '血管', '真皮', '表皮', 'SMAS', '代谢', '光热', '靶组织', '交联', '溶解酶'];
  const usedTerms = professionalTerms.filter(t => text.includes(t));
  if (usedTerms.length < 2 && consultantWords > 100) {
    issues.push({ type: '专业度', desc: '专业术语使用较少，可能显得不够专业可信', severity: 'medium' });
    suggestions.push('适当在讲解中融入专业术语（如"皮肤屏障""胶原重塑""光热作用"等），增强专业权威感。');
  }

  // 6. 检查成交信号
  const closingKeywords = ['怎么付', '什么时候做', '约', '现在能', '今天', '定了', '行', '可以'];
  const hasClosingSignal = closingKeywords.some(kw => customerText.includes(kw));
  const askedForClose = text.includes('做') && (text.includes('今天') || text.includes('现在') || text.includes('约'));
  if (hasClosingSignal && !askedForClose) {
    issues.push({ type: '成交时机', desc: '检测到顾客有购买意向信号，但未发现明确的促进行动', severity: 'high' });
    suggestions.push('识别成交信号（如"那我试一下""什么时候可以做"）后应立即推动成交，提供明确的行动指引。');
  }

  // 7. 整体分析
  const segCount = segments.length;
  const consultantTurns = consultantSegs.length;
  const avgResponseLen = consultantSegs.length > 0 ? consultantWords / consultantSegs.length : 0;

  // 生成复盘小结
  const goodPoints = [];
  const badPoints = [];
  if (avgResponseLen > 80) goodPoints.push('咨询师发言内容充实详细');
  if (segCount > 10) goodPoints.push('沟通回合充足，有深入交流');
  if (segCount < 5) badPoints.push('沟通回合偏少，可能流于表面');
  if (usedTerms.length >= 3) goodPoints.push('专业术语运用得当');
  if (issues.length === 0) goodPoints.push('整体沟通无明显短板');

  issues.forEach(i => badPoints.push(i.desc));

  const summary = `
【优点】${goodPoints.length > 0 ? goodPoints.join('；') : '暂未发现明显优势点'}
【待改进】${badPoints.length > 0 ? badPoints.join('；') : '暂未发现明显问题点'}
【总字数】共${totalWords}字（咨询师${consultantWords}字/顾客${customerWords}字，占比${Math.round(consultantRatio*100)}%/${Math.round((1-consultantRatio)*100)}%）
【沟通回合】共${segCount}个回合
【建议】${suggestions.length > 0 ? suggestions.join(' ') : '保持现有沟通节奏，持续优化'}`.trim();

  // 保存复盘报告
  const review = {
    id: 'review_' + Date.now(),
    recordingId, customerName: rec.customerName || '未知顾客',
    date: formatDateTime(new Date()),
    issues, suggestions, summary,
    consultantRatio: Math.round(consultantRatio * 100),
    totalWords, segCount
  };
  const reviews = Store.get('reviewReports', []);
  // 替换旧报告
  const oldIdx = reviews.findIndex(r => r.recordingId === recordingId);
  if (oldIdx >= 0) reviews[oldIdx] = review; else reviews.push(review);
  Store.set('reviewReports', reviews);

  // 同步到顾客档案
  if (rec.customerName) {
    let customers = Store.get('customers', []);
    const key = rec.customerName + '_' + (rec.customerPhone || 'nophone');
    let cust = customers.find(c => (c.name + '_' + (c.phone || 'nophone')) === key);
    if (cust) {
      if (!cust.reviews) cust.reviews = [];
      cust.reviews.push({ reviewId: review.id, date: review.date, summary: review.summary.slice(0, 150) });
      Store.set('customers', customers);
    }
  }

  // 显示报告
  showReviewDetail(review.id);
}

function showReviewDetail(reviewId) {
  const reviews = Store.get('reviewReports', []);
  const review = reviews.find(r => r.id === reviewId);
  if (!review) return;

  let html = `
    <div class="modal-header">
      <div class="modal-title">🤖 AI复盘报告</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-light);margin-bottom:12px;">
      👤 ${review.customerName} · ${review.date} · 共${review.totalWords}字 · ${review.segCount}回合
    </div>
  `;

  if (review.issues && review.issues.length > 0) {
    html += `<div class="section-title" style="color:var(--red);">⚠️ 检测到 ${review.issues.length} 个问题</div>`;
    review.issues.forEach((issue, i) => {
      const sevColors = { high: '#F44336', medium: '#FF9800', low: '#4CAF50' };
      const sevLabels = { high: '严重', medium: '一般', low: '轻微' };
      html += `
        <div class="card" style="padding:10px 14px;margin-bottom:8px;border-left:3px solid ${sevColors[issue.severity]};">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;font-weight:700;color:${sevColors[issue.severity]};background:${sevColors[issue.severity]}15;padding:1px 6px;border-radius:6px;">${sevLabels[issue.severity]}</span>
            <span style="font-size:12px;font-weight:600;">${issue.type}</span>
          </div>
          <div style="font-size:13px;margin-top:4px;color:var(--text);">${issue.desc}</div>
        </div>
      `;
    });
  }

  if (review.suggestions && review.suggestions.length > 0) {
    html += `<div class="section-title" style="color:var(--pink);">💡 优化建议</div>`;
    review.suggestions.forEach(s => {
      html += `<div class="card" style="padding:10px 14px;margin-bottom:6px;font-size:13px;background:var(--pink-soft);">💬 ${s}</div>`;
    });
  }

  html += `
    <div class="section-title">📋 复盘小结</div>
    <div class="card" style="padding:12px 14px;font-size:13px;line-height:1.7;white-space:pre-wrap;">${review.summary}</div>
    <button class="btn btn-primary btn-full" style="margin-top:10px;" onclick="closeModal()">✅ 我知道了</button>
  `;
  showModal(html);
}

// ===== 音色播报设置 =====
function renderVoiceSettings(view) {
  const prefs = Store.get('voicePrefs', { presetId: 'v_female_elegant', rate: 0.85, volume: 1.0 });
  const currentPreset = VOICE_PRESETS.find(p => p.id === prefs.presetId) || VOICE_PRESETS[6];

  let html = `<div class="section-title">🔊 音色选择</div>`;

  // 当前音色卡片
  html += `
    <div class="card" style="background:linear-gradient(135deg,var(--pink-soft),var(--lavender-light));text-align:center;padding:18px;">
      <div style="font-size:36px;">${currentPreset.icon}</div>
      <div style="font-size:16px;font-weight:700;margin-top:6px;">${currentPreset.name}</div>
      <div style="font-size:12px;color:var(--text-light);">${currentPreset.desc}</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;">
        <button class="btn btn-sm btn-primary" onclick="previewVoice('${currentPreset.id}')">🔊 试听</button>
        <button class="btn btn-sm btn-outline" onclick="speak('妙妙工作台，您的美学顾问伙伴', prefs.rate, prefs.volume, currentPreset.pitch)">📢 播报测试</button>
      </div>
    </div>
  `;

  // 语速/音量调节
  html += `
    <div class="section-title">自定义参数</div>
    <div class="card">
      <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px;">
        <div style="display:flex;justify-content:space-between;">
          <span class="sr-label">播报语速</span>
          <span class="sr-value" id="rateVal">${prefs.rate || 0.85}x</span>
        </div>
        <input type="range" min="0.5" max="1.5" step="0.05" value="${prefs.rate || 0.85}" oninput="updateVoiceRate(this.value)" style="width:100%;">
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px;margin-top:10px;">
        <div style="display:flex;justify-content:space-between;">
          <span class="sr-label">播报音量</span>
          <span class="sr-value" id="volVal">${Math.round((prefs.volume || 1) * 100)}%</span>
        </div>
        <input type="range" min="0.2" max="1.5" step="0.05" value="${prefs.volume || 1}" oninput="updateVoiceVolume(this.value)" style="width:100%;">
      </div>
    </div>
  `;

  // 男声音色
  html += `<div class="section-title">🧔 男声音色</div>`;
  const malePresets = VOICE_PRESETS.filter(p => p.gender === 'male');
  malePresets.forEach(p => {
    html += `
      <div class="card voice-card ${prefs.presetId === p.id ? 'voice-active' : ''}" style="padding:12px 14px;display:flex;align-items:center;gap:10px;" onclick="selectVoicePreset('${p.id}')">
        <span style="font-size:24px;">${p.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:14px;">${p.name}</div>
          <div style="font-size:12px;color:var(--text-light);">${p.desc}</div>
        </div>
        <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();previewVoice('${p.id}')">试听</button>
      </div>
    `;
  });

  // 女声音色
  html += `<div class="section-title">👩 女声音色</div>`;
  const femalePresets = VOICE_PRESETS.filter(p => p.gender === 'female');
  femalePresets.forEach(p => {
    html += `
      <div class="card voice-card ${prefs.presetId === p.id ? 'voice-active' : ''}" style="padding:12px 14px;display:flex;align-items:center;gap:10px;" onclick="selectVoicePreset('${p.id}')">
        <span style="font-size:24px;">${p.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:14px;">${p.name}</div>
          <div style="font-size:12px;color:var(--text-light);">${p.desc}</div>
        </div>
        <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();previewVoice('${p.id}')">试听</button>
      </div>
    `;
  });

  view.innerHTML = html;
}

// 从设置页打开音色选择弹窗
function showVoicePresetModal() {
  showModal('<div id="voicePresetModalContent" style="max-height:70vh;overflow-y:auto;"></div>');
  const content = document.getElementById('voicePresetModalContent');
  if (content) renderVoiceSettings(content);
  // 修改 modal 样式适配
  const modal = document.getElementById('modal');
  if (modal) modal.style.maxWidth = '420px';
}

function selectVoicePreset(presetId) {
  const prefs = Store.get('voicePrefs', { presetId: 'v_female_elegant', rate: 0.85, volume: 1.0 });
  prefs.presetId = presetId;
  Store.set('voicePrefs', prefs);
  // 如果在弹窗中打开，刷新弹窗内容
  const modalContent = document.getElementById('voicePresetModalContent');
  if (modalContent) renderVoiceSettings(modalContent);
  const preset = VOICE_PRESETS.find(p => p.id === presetId);
  if (preset) {
    speak('已切换到 ' + preset.name, prefs.rate || 0.85, prefs.volume || 1.0, preset.pitch);
  }
}

function previewVoice(presetId) {
  const preset = VOICE_PRESETS.find(p => p.id === presetId);
  if (preset) {
    speak('您好，我是妙妙工作台的语音助手。这是' + preset.name + '的音色效果。', preset.rate, preset.volume, preset.pitch);
    showToast('🔊 正在试听: ' + preset.name);
  }
}

function updateVoiceRate(val) {
  const prefs = Store.get('voicePrefs', { presetId: 'v_female_elegant', rate: 0.85, volume: 1.0 });
  prefs.rate = parseFloat(val);
  Store.set('voicePrefs', prefs);
  const el = document.getElementById('rateVal');
  if (el) el.textContent = val + 'x';
}

function updateVoiceVolume(val) {
  const prefs = Store.get('voicePrefs', { presetId: 'v_female_elegant', rate: 0.85, volume: 1.0 });
  prefs.volume = parseFloat(val);
  Store.set('voicePrefs', prefs);
  const el = document.getElementById('volVal');
  if (el) el.textContent = Math.round(val * 100) + '%';
}

// ===== 专业学习资料库 =====
let learningTab = 'scripts'; // scripts | projects | cases

function renderLearning(view) {
  let html = `<div class="section-title">📚 专业学习资料库</div>`;

  // 子Tab切换
  html += `
    <div class="acct-tabs" style="margin-bottom:12px;">
      <div class="acct-tab ${learningTab==='scripts'?'active':''}" onclick="switchLearningTab('scripts')">💬 场景话术</div>
      <div class="acct-tab ${learningTab==='projects'?'active':''}" onclick="switchLearningTab('projects')">📋 项目知识</div>
      <div class="acct-tab ${learningTab==='cases'?'active':''}" onclick="switchLearningTab('cases')">🏆 成交案例</div>
    </div>
  `;

  if (learningTab === 'scripts') {
    html += `<div class="section-title">高频场景话术 · ${SCRIPT_LIBRARY.length}个场景</div>`;
    SCRIPT_LIBRARY.forEach(s => {
      html += `
        <div class="card learning-card" onclick="showScriptDetail('${s.id}')">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="tag tag-pink">${s.scene}</span>
            <span style="font-weight:700;font-size:14px;flex:1;">${s.title}</span>
          </div>
          <div style="font-size:12px;color:var(--text-light);margin-top:6px;">${s.summary.slice(0,80)}...</div>
          <div style="margin-top:8px;font-size:11px;color:var(--lavender);">
            🔑 ${s.keyPoints.slice(0,3).join(' · ')}
          </div>
        </div>
      `;
    });
  } else if (learningTab === 'projects') {
    html += `<div class="section-title">店内项目知识 · ${PROJECT_KNOWLEDGE.length}个项目</div>`;
    PROJECT_KNOWLEDGE.forEach(p => {
      html += `
        <div class="card learning-card" onclick="showProjectDetail('${p.id}')">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="tag tag-${p.category==='光电'?'blue':p.category==='填充'?'purple':p.category==='水光'?'green':p.category==='紧致'?'orange':'pink'}">${p.category}</span>
            <span style="font-weight:700;font-size:14px;">${p.name}</span>
          </div>
          <div style="font-size:12px;color:var(--text-light);margin-top:4px;">品牌: ${p.brand} · 适用: ${p.suitable.slice(0,30)}...</div>
        </div>
      `;
    });
  } else if (learningTab === 'cases') {
    html += `<div class="section-title">成交案例拆解 · ${CASE_LIBRARY.length}个案例</div>`;
    CASE_LIBRARY.forEach(c => {
      html += `
        <div class="card learning-card" onclick="showCaseDetail('${c.id}')">
          <div style="font-weight:700;font-size:14px;">${c.title}</div>
          <div style="font-size:12px;color:var(--text-light);margin-top:4px;">${c.background.slice(0,60)}...</div>
          <div style="margin-top:6px;font-size:11px;color:var(--pink);font-weight:600;">
            💰 ${c.result.slice(0,50)}...
          </div>
        </div>
      `;
    });
  }

  view.innerHTML = html;
}

function switchLearningTab(tab) {
  learningTab = tab;
  const view = document.getElementById('view-learning');
  if (view) renderLearning(view);
}

function showScriptDetail(id) {
  const s = SCRIPT_LIBRARY.find(x => x.id === id);
  if (!s) return;
  let html = `
    <div class="modal-header">
      <div class="modal-title">💬 ${s.title}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="card" style="padding:10px 14px;font-size:13px;line-height:1.6;background:var(--pink-soft);margin-bottom:10px;">${s.summary}</div>
    <div class="section-title">📞 完整对话</div>
  `;
  s.steps.forEach(step => {
    const isConsultant = step.role === '咨询师';
    html += `
      <div class="card" style="padding:10px 14px;margin-bottom:6px;${isConsultant ? 'border-left:3px solid var(--pink);' : 'border-left:3px solid var(--lavender);'}">
        <div style="font-weight:700;font-size:12px;color:${isConsultant ? 'var(--pink)' : 'var(--lavender)'};">${step.role}</div>
        <div style="font-size:13px;line-height:1.7;margin-top:4px;">${step.text}</div>
      </div>
    `;
  });
  html += `
    <div class="section-title">🔑 成交关键点</div>
    <div class="card" style="padding:10px 14px;font-size:13px;line-height:1.8;">
      ${s.keyPoints.map((kp,i) => `<div>${i+1}. ${kp}</div>`).join('')}
    </div>
    <button class="btn btn-primary btn-full" style="margin-top:10px;" onclick="speak('${s.steps.map(st=>st.text).join('。').replace(/'/g,'').replace(/\n/g,'')}')">🔊 全文朗读学习</button>
  `;
  showModal(html);
}

function showProjectDetail(id) {
  const p = PROJECT_KNOWLEDGE.find(x => x.id === id);
  if (!p) return;
  let html = `
    <div class="modal-header">
      <div class="modal-title">📋 ${p.name}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="card" style="padding:10px 14px;"><span class="tag tag-pink">${p.category}</span> <span style="font-size:12px;color:var(--text-light);">品牌: ${p.brand}</span></div>
    <div class="section-title">✅ 适用人群</div>
    <div class="card" style="padding:10px 14px;font-size:13px;">${p.suitable}</div>
    <div class="section-title">👍 优势</div>
    <div class="card" style="padding:10px 14px;font-size:13px;background:#E8F5E9;">${p.pros}</div>
    <div class="section-title">⚠️ 局限</div>
    <div class="card" style="padding:10px 14px;font-size:13px;background:#FFF8E1;">${p.cons}</div>
    <div class="section-title">📅 疗程规划</div>
    <div class="card" style="padding:10px 14px;font-size:13px;">${p.plan}</div>
    <div class="section-title">🚫 禁忌症</div>
    <div class="card" style="padding:10px 14px;font-size:13px;background:#FFEBEE;">${p.contraindications}</div>
    <div class="section-title">💡 咨询技巧</div>
    <div class="card" style="padding:10px 14px;font-size:13px;background:var(--pink-soft);">${p.tips}</div>
    <button class="btn btn-outline btn-full btn-sm" style="margin-top:10px;" onclick="copyText('${(p.name+'\\n适合:'+p.suitable+'\\n优势:'+p.pros+'\\n疗程:'+p.plan).replace(/'/g,'\\\'')}')">📋 复制要点</button>
  `;
  showModal(html);
}

function showCaseDetail(id) {
  const c = CASE_LIBRARY.find(x => x.id === id);
  if (!c) return;
  let html = `
    <div class="modal-header">
      <div class="modal-title">🏆 ${c.title}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="card" style="padding:10px 14px;font-size:13px;line-height:1.6;background:var(--lavender-light);">📌 ${c.background}</div>
    <div class="section-title">💬 关键对话</div>
  `;
  c.dialogue.forEach(d => {
    html += `
      <div class="card" style="padding:10px 14px;margin-bottom:6px;border-left:3px solid ${d.role==='咨询师'?'var(--pink)':'var(--lavender)'};">
        <div style="font-weight:700;font-size:12px;color:${d.role==='咨询师'?'var(--pink)':'var(--lavender)'};">${d.role}</div>
        <div style="font-size:13px;line-height:1.7;margin-top:4px;">${d.text}</div>
      </div>
    `;
  });
  html += `
    <div class="section-title">💰 成交结果</div>
    <div class="card" style="padding:10px 14px;font-size:13px;background:#E8F5E9;font-weight:600;">${c.result}</div>
    <div class="section-title">🔑 核心拆解</div>
    <div class="card" style="padding:10px 14px;font-size:13px;line-height:1.8;">
      ${c.keyInsights.map((ki,i) => `<div>${i+1}. ${ki}</div>`).join('')}
    </div>
  `;
  showModal(html);
}

// ===== 个人成长数据台账 =====
function renderDashboard(view) {
  const customers = Store.get('customers', []);
  const recordings = Store.get('recordings', []);
  const reviews = Store.get('reviewReports', []);
  const consumption = Store.get('consumption', []);
  const completions = Store.get('completions', {});

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  // 月度统计
  const monthRecordings = recordings.filter(r => {
    const d = new Date(r.date);
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  });
  const monthConsumptions = consumption.filter(c => {
    const d = new Date(c.date);
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  });
  const monthDeals = monthConsumptions.filter(c => c.status === 'paid' || c.status === 'done');
  const monthRevenue = monthConsumptions.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);

  // 成交/未成交分析
  const totalDeals = consumption.filter(c => c.status === 'paid' || c.status === 'done').length;
  const totalLost = consumption.filter(c => c.status === 'lost').length;
  const loseReasons = {};
  consumption.filter(c => c.status === 'lost' && c.loseReason).forEach(c => {
    loseReasons[c.loseReason] = (loseReasons[c.loseReason] || 0) + 1;
  });

  // 顾客薄弱场景
  const reviewIssues = [];
  reviews.forEach(r => {
    if (r.issues) r.issues.forEach(i => reviewIssues.push(i.type));
  });
  const issueCount = {};
  reviewIssues.forEach(t => { issueCount[t] = (issueCount[t] || 0) + 1; });
  const weakAreas = Object.entries(issueCount).sort((a,b) => b[1]-a[1]).slice(0, 5);

  // 全量数据统计
  const allConsumptions = consumption.filter(c => c.status !== 'archived');
  const totalRevenue = allConsumptions.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);

  let html = `<div class="section-title">📊 个人成长数据台账</div>`;

  // 核心指标
  html += `
    <div class="consumption-stats" style="margin-bottom:12px;">
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">${monthRecordings.length}</div>
        <div class="consumption-stat-label">本月谈单次数</div>
      </div>
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">${monthDeals.length}</div>
        <div class="consumption-stat-label">本月成交数</div>
      </div>
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">¥${(monthRevenue/10000).toFixed(1)}万</div>
        <div class="consumption-stat-label">本月业绩</div>
      </div>
    </div>
  `;

  // 总览
  html += `
    <div class="card" style="padding:12px 14px;">
      <div class="section-title" style="margin-top:0;">📈 累计总览</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
        <div>📝 录音文稿：<b>${recordings.length}</b> 份</div>
        <div>🤖 AI复盘：<b>${reviews.length}</b> 次</div>
        <div>👥 顾客档案：<b>${customers.length}</b> 人</div>
        <div>💳 消费记录：<b>${consumption.length}</b> 条</div>
        <div>💰 累计业绩：<b>¥${(totalRevenue/10000).toFixed(1)}万</b></div>
        <div>🏆 成交率：<b>${totalDeals+totalLost>0 ? Math.round(totalDeals/(totalDeals+totalLost)*100) : 0}%</b></div>
      </div>
    </div>
  `;

  // 未成交原因分析
  if (Object.keys(loseReasons).length > 0) {
    html += `<div class="section-title">📉 未成交原因分布</div>`;
    html += `<div class="card" style="padding:12px 14px;">`;
    Object.entries(loseReasons).sort((a,b)=>b[1]-a[1]).forEach(([reason, count]) => {
      const pct = Math.round(count / totalLost * 100);
      html += `
        <div style="margin-bottom:6px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;">
            <span>${reason}</span><span style="font-weight:700;">${count}次 · ${pct}%</span>
          </div>
          <div style="background:#F0F0F0;border-radius:4px;height:6px;overflow:hidden;">
            <div style="background:linear-gradient(90deg,#FF6B9D,#FF8FB1);height:100%;width:${pct}%;border-radius:4px;"></div>
          </div>
        </div>
      `;
    });
    html += `</div>`;
  }

  // 个人薄弱环节
  if (weakAreas.length > 0) {
    html += `<div class="section-title">🎯 个人薄弱沟通场景</div>`;
    weakAreas.forEach(([area, count]) => {
      html += `
        <div class="card" style="padding:10px 14px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-weight:700;font-size:13px;">⚠️ ${area}</div>
            <div style="font-size:11px;color:var(--text-light);">AI复盘累计发现 ${count} 次</div>
          </div>
          <button class="btn btn-sm btn-outline" onclick="goToLearning('${area}')">📚 学习</button>
        </div>
      `;
    });
    html += `<div style="font-size:11px;color:var(--text-light);text-align:center;margin:8px 0;">💡 已在学习资料库对应场景增加专项练习建议</div>`;
  }

  // 最近活动
  html += `<div class="section-title">🕐 最近动态</div>`;
  const recentItems = [];
  recordings.slice(-3).forEach(r => recentItems.push({ type: 'recording', text: '🎙️ 完成录音', detail: (r.customerName||'未关联') + ' · ' + r.date, time: r.date }));
  reviews.slice(-3).forEach(r => recentItems.push({ type: 'review', text: '🤖 AI复盘', detail: r.customerName + ' · ' + (r.issues?r.issues.length:0)+'个问题', time: r.date }));
  consumption.slice(-3).forEach(c => recentItems.push({ type: 'consumption', text: '💳 ' + (c.status==='paid'?'成交':'记录'), detail: c.customerName + ' · ¥' + (c.amount||0), time: c.date }));
  recentItems.sort((a,b) => b.time.localeCompare(a.time));
  recentItems.slice(0, 10).forEach(item => {
    html += `
      <div style="padding:8px 14px;font-size:12px;border-bottom:1px solid #F5F5F5;display:flex;justify-content:space-between;">
        <span>${item.text}</span>
        <span style="color:var(--text-light);">${item.detail}</span>
      </div>
    `;
  });

  if (recentItems.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">📊</div><div class="es-text">开始使用工作台后，数据将在此汇总</div></div>`;
  }

  view.innerHTML = html;
}

function goToLearning(area) {
  switchView('learning');
  setTimeout(() => {
    const scripts = document.getElementById('view-learning');
    if (scripts) {
      // 根据薄弱场景匹配话术
      const mappedScenes = {
        '异议处理': '议价砍价',
        '话术节奏': '犹豫顾客挽留',
        '方案讲解': '玻尿酸填充',
        '议价应对': '议价砍价',
        '成交时机': '犹豫顾客挽留',
        '专业度': '初次面诊破冰'
      };
      const scene = mappedScenes[area] || area;
      const match = SCRIPT_LIBRARY.find(s => s.scene === scene);
      if (match) showScriptDetail(match.id);
    }
  }, 300);
}

function showVideoPlayer(title, videoUrl, contentHtml) {
  const bililiUrl = videoUrl || ('https://search.bilibili.com/all?keyword=' + encodeURIComponent(title));
  const douyinUrl = 'https://www.douyin.com/search/' + encodeURIComponent(title);
  const xhsUrl = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(title);
  const html = `
    <div class="modal-header">
      <div class="modal-title">${title}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="vp-wrapper">
      <div class="vp-screen" onclick="window.open('${bililiUrl}', '_blank')">
        <div class="vp-play-icon">▶</div>
        <div class="vp-play-text">点击播放视频</div>
        <div class="vp-hint">将在浏览器中打开B站搜索结果</div>
      </div>
    </div>
    <div class="vp-platforms">
      <button class="vp-btn vp-bili" onclick="window.open('${bililiUrl}', '_blank')">📺 B站观看</button>
      <button class="vp-btn vp-douyin" onclick="window.open('${douyinUrl}', '_blank')">📱 抖音观看</button>
      <button class="vp-btn vp-xhs" onclick="window.open('${xhsUrl}', '_blank')">📕 小红书观看</button>
    </div>
    ${contentHtml || ''}
  `;
  showModal(html);
}

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
