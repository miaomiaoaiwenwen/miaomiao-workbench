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
let _lastAutoBackup = 0;      // 上次备份时间戳（节流用）
let _lastCloudSync = 0;       // 上次云同步时间戳（节流用）
const DATA_KEYS = ['tasks', 'completions', 'leaves', 'reminders', 'accounting', 'engProgress', 'voiceOn', 'customers', 'consumption', 'recordings', 'voicePrefs', 'reviewReports', 'notes'];

const Store = {
  get(key, def) {
    try { const v = localStorage.getItem('mm_' + key); return v ? JSON.parse(v) : def; }
    catch(e) { return def; }
  },
  set(key, val) {
    localStorage.setItem('mm_' + key, JSON.stringify(val));
    // 延迟自动备份（防抖 + 节流，避免频繁打包大对象导致卡顿）
    if (_backupTimer) clearTimeout(_backupTimer);
    _backupTimer = setTimeout(() => autoBackup(), 8000);
    // 延迟云端同步（防抖 + 节流，避免频繁加密上传 GitHub）
    if (_cloudSyncTimer) clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = setTimeout(() => pushToCloud(), 20000);
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
  // 节流：距上次云同步不足 3 分钟则跳过
  const now = Date.now();
  if (now - _lastCloudSync < 180000) return;
  _lastCloudSync = now;
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
      <div class="quick-card-name">成交记录</div>
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
let custSearchTimer = null;
const CUST_QUICK_TAGS = ['水光', '胶原水光', '超光子', '肌美时光', '菲林普利', '童颜炮', '鼻综合'];

function getCustCustomersWithMigration() {
  let customers = Store.get('customers', []);
  const migrated = migrateCustomers(customers);
  // 仅当迁移产生变化时才写回（避免每次渲染触发备份/云同步）
  if (migrated !== customers) {
    try {
      if (JSON.stringify(migrated) !== JSON.stringify(customers)) Store.set('customers', migrated);
    } catch(e) { Store.set('customers', migrated); }
    customers = migrated;
  }
  return customers;
}

// 只构建列表区 HTML（不含搜索框），供局部刷新使用
function buildCustListHtml(customers) {
  const keyword = custSearchKeyword.toLowerCase().trim();

  // 提取所有有日期的活动条目（项目 + 跟进）
  // 格式: { customerId, customerName, date, type, typeLabel, summary, projectName, ... }
  const allActivities = [];
  customers.forEach(c => {
    const cname = c.name || '未知';
    // 项目
    (c.projects || []).forEach(p => {
      if (p.date) {
        allActivities.push({
          customerId: c.id,
          customerName: cname,
          customerContact: c.contact || '',
          customerPriority: c.priority || 'long',
          customerCompleted: c.completed || false,
          date: p.date,
          type: 'project',
          typeLabel: '📌',
          summary: p.name,
          detail: p.thought || '',
          projectName: p.name,
          projectId: p.id,
          projectCompleted: p.completed || false,
          sortTime: p.date
        });
      }
    });
    // 跟进
    (c.followups || []).forEach(f => {
      if (f.date) {
        allActivities.push({
          customerId: c.id,
          customerName: cname,
          customerContact: c.contact || '',
          customerPriority: c.priority || 'long',
          customerCompleted: c.completed || false,
          date: f.date,
          type: 'followup',
          typeLabel: '💬',
          summary: f.content || '',
          detail: f.content || '',
          projectName: (c.projects || []).find(p => p.id === f.projectId)?.name || '',
          followupId: f.id,
          revisitDate: f.revisitDate || '',
          sortTime: f.date
        });
      }
    });
  });

  // 搜索过滤
  let filtered = allActivities;
  if (keyword) {
    filtered = allActivities.filter(a =>
      a.customerName.toLowerCase().includes(keyword) ||
      (a.projectName || '').toLowerCase().includes(keyword) ||
      (a.summary || '').toLowerCase().includes(keyword)
    );
  }

  // 按日期降序排列
  filtered.sort((a, b) => {
    const dateCompare = (b.date || '').localeCompare(a.date || '');
    if (dateCompare !== 0) return dateCompare;
    // 同一天按顾客姓名聚集
    const nameCompare = (a.customerName || '').localeCompare(b.customerName || '');
    if (nameCompare !== 0) return nameCompare;
    // 同一顾客按时间排序
    return (b.sortTime || '').localeCompare(a.sortTime || '');
  });

  // 按日期分组
  const dateGroups = [];
  let currentDate = '';
  let currentGroup = null;
  filtered.forEach(a => {
    if (a.date !== currentDate) {
      currentDate = a.date;
      currentGroup = { date: currentDate, activities: [] };
      dateGroups.push(currentGroup);
    }
    currentGroup.activities.push(a);
  });

  let html = '';
  if (filtered.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">👥</div><div class="es-text">${keyword ? '没有找到匹配的记录' : '还没有跟进记录，点击上方按钮添加'}</div></div>`;
  } else {
    dateGroups.forEach(group => {
      const dateLabel = formatDateCN(group.date);
      html += `<div class="cust-date-group">`;
      html += `<div class="cust-date-group-header">📅 ${dateLabel}（${group.activities.length}条记录）</div>`;
      group.activities.forEach(a => {
        const p = PRIORITY[a.customerPriority] || PRIORITY.long;
        html += `
          <div class="cust-activity-item ${a.customerCompleted ? 'completed' : ''}" onclick="showCustomerDetail('${a.customerId}')">
            <div class="cust-activity-type">${a.typeLabel}</div>
            <div class="cust-activity-body">
              <div class="cust-activity-name">${a.customerName}
                <span class="cust-priority-tag ${p.tag}" style="font-size:10px;padding:2px 6px;">${p.label}</span>
                ${a.projectName ? `<span class="cust-activity-project">${a.projectName}</span>` : ''}
              </div>
              <div class="cust-activity-summary">${a.summary}</div>
            </div>
            <div class="cust-activity-arrow">›</div>
          </div>
        `;
      });
      html += `</div>`;
    });
  }
  return html;
}

// 局部刷新列表区：不销毁搜索框，保住光标与输入法组合缓冲
function renderCustListArea() {
  const area = document.getElementById('custListArea');
  if (!area) return;
  const customers = getCustCustomersWithMigration();
  area.innerHTML = buildCustListHtml(customers);
}

function renderCustomers(view) {
  const customers = getCustCustomersWithMigration();

  // 统计（基于全量活跃顾客，与搜索关键词无关，保持静态）
  const activeCustomers = customers.filter(c => !c.completed);
  const urgentCount = activeCustomers.filter(c => c.priority === 'urgent').length;
  const monthCount  = activeCustomers.filter(c => c.priority === 'month').length;
  const longCount   = activeCustomers.filter(c => c.priority === 'long').length;

  let html = `
    <div class="cust-search-bar">
      <input class="cust-search-input" id="custSearch" placeholder="🔍 搜索顾客姓名/项目名称/跟进内容..." value="${custSearchKeyword.replace(/"/g, '&quot;')}" oninput="onCustSearch(this.value)" onkeydown="onCustSearchKey(event)">
    </div>
    <div class="cust-quick-tags">
      ${CUST_QUICK_TAGS.map(t => `<button type="button" class="cust-quick-tag" onclick="quickCustSearch('${t}')">${t}</button>`).join('')}
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
    <button class="btn btn-primary btn-full" onclick="showAddCustomer()" style="margin-bottom:14px;">
      ➕ 新增顾客跟进
    </button>
    <div id="custListArea">${buildCustListHtml(customers)}</div>
  `;

  view.innerHTML = html;
}

function formatDateCN(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const y = parts[0], m = parts[1], d = parts[2];
  const today = formatDate(new Date());
  const yesterday = formatDate(new Date(Date.now() - 86400000));
  if (dateStr === today) return '今天';
  if (dateStr === yesterday) return '昨天';
  return `${y}年${parseInt(m)}月${parseInt(d)}日 · ${['日','一','二','三','四','五','六'][new Date(y, parseInt(m)-1, parseInt(d)).getDay()]}`;
}

// 防抖搜索：停止输入 400ms 后只刷新列表区（不重建搜索框，输入法可完整拼词上屏）
function onCustSearch(val) {
  custSearchKeyword = val;
  if (custSearchTimer) clearTimeout(custSearchTimer);
  custSearchTimer = setTimeout(() => {
    custSearchTimer = null;
    renderCustListArea();
  }, 400);
}

// 回车立即搜索（备用触发方式）
function onCustSearchKey(e) {
  if (e && e.key === 'Enter') {
    if (custSearchTimer) { clearTimeout(custSearchTimer); custSearchTimer = null; }
    renderCustListArea();
  }
}

// 快捷标签：点击填入搜索词并立即检索
function quickCustSearch(kw) {
  custSearchKeyword = kw;
  if (custSearchTimer) { clearTimeout(custSearchTimer); custSearchTimer = null; }
  const input = document.getElementById('custSearch');
  if (input) input.value = kw;
  renderCustListArea();
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

// 顾客详情（全周期跨日期汇总档案）
function showCustomerDetail(cid) {
  let customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const c = customers.find(cu => cu.id === cid);
  if (!c) return;

  const p = PRIORITY[c.priority] || PRIORITY.long;
  const allEntries = getAllEntries(c);
  const activeEntries = allEntries.filter(e => !e.completed);
  const completedEntries = allEntries.filter(e => e.completed);

  // 关联的录音
  const recordings = Store.get('recordings', []);
  const custRecordings = recordings.filter(r => r.customerName === c.name);

  // 消费记录
  const consumption = Store.get('consumption', []);
  const custConsumption = consumption.filter(r => r.name === c.name);

  // 项目统计
  const allProjects = c.projects || [];
  const activeProjects = allProjects.filter(p => !p.completed);
  const doneProjects = allProjects.filter(p => p.completed);

  let html = `
    <div class="modal-header">
      <div class="modal-title">📋 ${c.name} 完整档案</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <!-- 基本信息卡 -->
    <div style="background:#FFF5F8;border-radius:12px;padding:14px;margin-bottom:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:18px;font-weight:700;color:#333;">${c.name}</div>
          ${c.contact ? `<div style="font-size:13px;color:#666;margin-top:2px;">📱 ${c.contact}</div>` : ''}
          <span class="cust-priority-tag ${p.tag}" style="margin-top:4px;display:inline-block;">${p.label}</span>
          ${c.revisitDate ? `<span style="margin-left:6px;font-size:12px;color:${c.revisitDate <= formatDate(new Date()) && !c.completed ? '#F44336' : '#999'};">📅 回访：${c.revisitDate}${c.revisitDate <= formatDate(new Date()) && !c.completed ? ' ⚠已到期' : ''}</span>` : ''}
        </div>
        <div style="text-align:right;font-size:12px;color:#999;">
          <div>项目 ${activeProjects.length}/${allProjects.length}个</div>
          <div>跟进 ${allEntries.filter(e => e.type === 'followup').length}次</div>
          ${custRecordings.length > 0 ? `<div>录音 ${custRecordings.length}段</div>` : ''}
          ${custConsumption.length > 0 ? `<div>消费 ${custConsumption.length}笔</div>` : ''}
        </div>
      </div>
    </div>
    <!-- 操作按钮 -->
    <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;">
      ${!c.completed ? `<button class="cust-action-btn" onclick="closeModal();showAddFollowup('${c.id}')">💬 记跟进</button>` : ''}
      ${!c.completed ? `<button class="cust-action-btn" onclick="closeModal();showAddProject('${c.id}')">📌 新增项目</button>` : ''}
      ${!c.completed ? `<button class="cust-action-btn success" onclick="toggleCustomerDone('${c.id}');setTimeout(closeModal,300)">✅ 完成成交</button>` : `<button class="cust-action-btn" onclick="toggleCustomerDone('${c.id}');setTimeout(closeModal,300)">↩️ 恢复跟进</button>`}
      ${custConsumption.length > 0 ? `<button class="cust-cross-link" onclick="closeModal();switchView('consumption');setTimeout(()=>{const el=document.getElementById('consumptionSearch');if(el){el.value='${c.name}';onConsumptionSearch('${c.name}');}},100)">💳 消费(${custConsumption.length})</button>` : ''}
    </div>
  `;

  // === 项目汇总（跨所有日期）===
  if (allProjects.length > 0) {
    html += `<div class="section-title">📌 铺垫项目全周期汇总</div>`;
    html += `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">`;
    allProjects.forEach(p => {
      html += `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#fff;border-radius:8px;border:1px solid #F0F0F0;${p.completed ? 'opacity:0.6;' : ''}">
          <div style="flex:1;">
            <div style="font-weight:600;font-size:14px;${p.completed ? 'text-decoration:line-through;' : ''}">${p.name}</div>
            ${p.thought ? `<div style="font-size:12px;color:#666;margin-top:2px;">${p.thought}</div>` : ''}
            <div style="font-size:11px;color:#999;margin-top:2px;">📅 ${p.date || '未标注日期'}</div>
          </div>
          <span style="font-size:11px;padding:3px 8px;border-radius:10px;${p.completed ? 'background:#E8F5E9;color:#388E3C;' : 'background:#FFF3E0;color:#E65100;'}">${p.completed ? '✓ 已成交' : '跟进中'}</span>
        </div>
      `;
    });
    html += `</div>`;
  }

  // === 沟通全周期时间线（所有日期不限制）===
  html += `<div class="section-title">📝 沟通全周期轨迹 (${allEntries.length}条)</div>`;
  html += `<div class="cust-timeline">`;
  if (allEntries.length === 0) {
    html += `<div style="text-align:center;padding:20px;color:#999;font-size:13px;">暂无记录</div>`;
  } else {
    // 按时���倒序
    activeEntries.forEach(e => {
      html += renderTimelineEntry(e);
    });
    if (completedEntries.length > 0) {
      html += `<div style="margin-top:8px;padding:6px 0;border-top:1px dashed #E0E0E0;font-size:12px;color:#999;">已完成项目 (${completedEntries.length})</div>`;
      completedEntries.forEach(e => {
        html += renderTimelineEntry(e);
      });
    }
  }
  html += `</div>`;

  // === 关联录音 ===
  if (custRecordings.length > 0) {
    html += `<div class="section-title">🎙️ 关联录音 (${custRecordings.length})</div>`;
    custRecordings.forEach(r => {
      const dur = r.duration ? Math.floor(r.duration/60)+'分'+Math.floor(r.duration%60)+'秒' : '未知';
      html += `
        <div style="padding:10px 12px;background:#fff;border-radius:8px;border:1px solid #F0F0F0;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:13px;font-weight:600;">${r.date}</div>
            <div style="font-size:12px;color:#999;">${dur} · ${r.transcript && r.transcript.length > 0 ? '已转写' : '待转写'}</div>
          </div>
          ${r.transcript && r.transcript.length > 0
            ? `<button class="btn btn-sm btn-outline" onclick="closeModal();switchView('recording_review');setTimeout(()=>viewTranscriptSync('${r.id}'),250)">📄 查看文稿</button>`
            : `<button class="btn btn-sm btn-outline" onclick="closeModal();switchView('recording_review')">📝 去转写</button>`
          }
        </div>
      `;
    });
  }

  // 底部操作
  html += `
    <div style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;">
      <button class="cust-action-btn" onclick="showEditCustomer('${c.id}');closeModal()">✏️ 编辑档案</button>
      <button class="cust-action-btn" onclick="closeModal();switchView('consumption');setTimeout(()=>{const el=document.getElementById('consumptionSearch');if(el){el.value='${c.name}';onConsumptionSearch('${c.name}');}},100)">💳 消费管理</button>
    </div>
  `;

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

// ===== 顾客消费管理视图（成交记录）=====
let consumptionSearchKeyword = '';
let consumptionFilterProject = '';
let consumptionFilterStatus = '';
let consumptionShowArchived = false;
let consumptionFilterMonth = '';
let consumptionFilterDate = '';
let consumptionCollapsedMonths = new Set();
let consumptionCollapsedDates = new Set();
let consumptionExpandedItems = new Set();
let consumptionSearchTimer = null;

function applyConsumptionFilters(records) {
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
  if (consumptionFilterMonth) {
    filtered = filtered.filter(r => (r.date || '').startsWith(consumptionFilterMonth));
  }
  if (consumptionFilterDate) {
    filtered = filtered.filter(r => r.date === consumptionFilterDate);
  }
  if (!consumptionShowArchived) {
    filtered = filtered.filter(r => !r.archived);
  }
  return filtered;
}

// 统计区 HTML（随搜索/筛选变化，供局部刷新）
function buildConsStatsHtml() {
  const records = Store.get('consumption', []);
  const filtered = applyConsumptionFilters(records);
  const activeFiltered = filtered.filter(r => !r.archived);
  const totalAmount = activeFiltered.reduce((s,r) => s + (r.amount||0), 0);
  const totalRecords = activeFiltered.length;
  const uniqueCustomers = new Set(activeFiltered.map(r => r.name)).size;
  return `
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">${totalRecords}</div>
        <div class="consumption-stat-label">成交笔数</div>
      </div>
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">${uniqueCustomers}</div>
        <div class="consumption-stat-label">成交顾客</div>
      </div>
      <div class="consumption-stat-card">
        <div class="consumption-stat-num">¥${totalAmount.toFixed(0)}</div>
        <div class="consumption-stat-label">成交总额</div>
      </div>
  `;
}

// 列表区 HTML（随搜索/筛选变化，供局部刷新）
function buildConsListHtml() {
  const records = Store.get('consumption', []);
  const filtered = applyConsumptionFilters(records);
  const keyword = consumptionSearchKeyword.toLowerCase().trim();

  // 按月份 → 日期分组
  const byMonth = {};
  filtered.forEach(r => {
    const monthKey = (r.date || '').substring(0, 7) || '未分类';
    const dateKey = r.date || '未标注日期';
    if (!byMonth[monthKey]) byMonth[monthKey] = {};
    if (!byMonth[monthKey][dateKey]) byMonth[monthKey][dateKey] = [];
    byMonth[monthKey][dateKey].push(r);
  });

  const sortedMonths = Object.keys(byMonth).sort((a, b) => b.localeCompare(a));

  let html = '';
  if (sortedMonths.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">💳</div><div class="es-text">${keyword ? '没有找到匹配的成交记录' : '还没有成交记录，点击上方按钮添加'}</div></div>`;
  } else {
    sortedMonths.forEach(monthKey => {
      const monthDates = byMonth[monthKey];
      const monthRecords = Object.values(monthDates).flat();
      const monthTotal = monthRecords.reduce((s, r) => s + (r.amount || 0), 0);
      const monthCustomers = new Set(monthRecords.map(r => r.name)).size;
      const monthLabel = monthKey === '未分类' ? '未分类' : (monthKey.substring(0, 4) + '年' + parseInt(monthKey.substring(5)) + '月');
      const monthCollapsed = consumptionCollapsedMonths.has(monthKey);

      html += `
        <div class="cons-month-section${monthCollapsed ? ' collapsed' : ''}">
          <div class="cons-month-header" onclick="toggleConsMonth('${monthKey}')">
            <span class="cons-toggle-icon">${monthCollapsed ? '▶' : '▼'}</span>
            <span class="cons-month-title">${monthLabel}</span>
            <span class="cons-month-stats">总业绩 ¥${monthTotal.toFixed(0)} ｜ ${monthCustomers}人</span>
            <button class="cons-export-btn" onclick="event.stopPropagation();exportConsumptionCSV('month','${monthKey}')">📥 导出</button>
          </div>
      `;

      if (!monthCollapsed) {
        const sortedDates = Object.keys(monthDates).sort((a, b) => b.localeCompare(a));
        sortedDates.forEach(dateKey => {
          const dateRecords = monthDates[dateKey];
          const dateTotal = dateRecords.reduce((s, r) => s + (r.amount || 0), 0);
          const dateLabel = dateKey === '未标注日期' ? '未标注日期' : formatDateCN(dateKey);
          const dateCollapsed = consumptionCollapsedDates.has(dateKey);

          html += `
            <div class="cons-date-section${dateCollapsed ? ' collapsed' : ''}">
              <div class="cons-date-header" onclick="toggleConsDate('${dateKey}')">
                <span class="cons-toggle-icon">${dateCollapsed ? '▶' : '▼'}</span>
                <span class="cons-date-title">— ${dateLabel}</span>
                <span class="cons-date-stats">¥${dateTotal.toFixed(0)} · ${dateRecords.length}人</span>
                <button class="cons-export-btn" onclick="event.stopPropagation();exportConsumptionCSV('date','${dateKey}')">📥</button>
              </div>
          `;

          if (!dateCollapsed) {
            html += `<div class="cons-date-items">`;
            dateRecords.forEach((r, idx) => {
              html += renderConsumptionItem(r, idx + 1);
            });
            html += `</div>`;
          }

          html += `</div>`;
        });
      }

      html += `</div>`;
    });
  }
  return html;
}

// 局部刷新统计区 + 列表区：不销毁搜索框，保住光标与输入法组合缓冲
function refreshConsAreas() {
  const statsArea = document.getElementById('consStatsArea');
  if (statsArea) statsArea.innerHTML = buildConsStatsHtml();
  const listArea = document.getElementById('consListArea');
  if (listArea) listArea.innerHTML = buildConsListHtml();
}

function renderConsumption(view) {
  const records = Store.get('consumption', []);

  // 获取所有项目名称（用于筛选下拉，基于全量记录，不随搜索变化）
  const allProjects = [...new Set(records.map(r => r.project).filter(Boolean))].sort();
  // 获取所有月份（用于月份快筛，基于全量记录，不随搜索变化）
  const allMonths = [...new Set(records.map(r => (r.date || '').substring(0, 7)).filter(Boolean))].sort().reverse();

  let html = `
    <div class="consumption-stats" id="consStatsArea">${buildConsStatsHtml()}</div>
    <div class="consumption-search-bar">
      <input class="consumption-search-input" id="consumptionSearch" placeholder="🔍 搜索顾客姓名/手机号/成交项目（跨月汇总）..." value="${consumptionSearchKeyword.replace(/"/g, '&quot;')}" oninput="onConsumptionSearch(this.value)" onkeydown="onConsumptionSearchKey(event)">
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
    ${allMonths.length > 0 ? `
    <div class="cons-month-filter-bar">
      <button class="cons-month-btn ${!consumptionFilterMonth?'active':''}" onclick="onConsumptionFilterMonth('')">全部</button>
      ${allMonths.map(m => `<button class="cons-month-btn ${consumptionFilterMonth===m?'active':''}" onclick="onConsumptionFilterMonth('${m}')">${parseInt(m.substring(5))}月</button>`).join('')}
    </div>` : ''}
    <div class="cons-date-search-bar">
      <input type="date" class="consumption-filter-select" value="${consumptionFilterDate}" onchange="onConsumptionFilterDate(this.value)">
      ${consumptionFilterDate ? `<button class="cons-clear-btn" onclick="onConsumptionFilterDate('')">✕ 清除日期</button>` : ''}
    </div>
    <button class="btn btn-primary btn-full" onclick="showAddConsumption()" style="margin-bottom:12px;">
      ➕ 新增成交记录
    </button>
    <div id="consListArea">${buildConsListHtml()}</div>
  `;

  view.innerHTML = html;
}

// 防抖搜索：停止输入 400ms 后只刷新统计区+列表区（不重建搜索框）
function onConsumptionSearch(val) {
  consumptionSearchKeyword = val;
  if (consumptionSearchTimer) clearTimeout(consumptionSearchTimer);
  consumptionSearchTimer = setTimeout(() => {
    consumptionSearchTimer = null;
    refreshConsAreas();
  }, 400);
}

// 回车立即搜索（备用触发方式）
function onConsumptionSearchKey(e) {
  if (e && e.key === 'Enter') {
    if (consumptionSearchTimer) { clearTimeout(consumptionSearchTimer); consumptionSearchTimer = null; }
    refreshConsAreas();
  }
}

function renderConsumptionItem(r, index) {
  const statusMap = {
    paid: { label: '已付款', class: 'status-paid' },
    done: { label: '已做完', class: 'status-done' },
    aftercare: { label: '售后保养', class: 'status-aftercare' }
  };
  const st = statusMap[r.status] || statusMap.paid;

  // 跨表联动：检查跟进记录
  const customers = Store.get('customers', []);
  const hasFollowup = customers.some(c => c.name === r.name);

  // 关联录音
  const recordings = Store.get('recordings', []);
  const custRecordings = recordings.filter(rec => rec.customerName === r.name);

  // 预约提醒：7天内有预约
  const todayStr = formatDate(new Date());
  const sevenLater = formatDate(new Date(Date.now() + 7 * 86400000));
  const hasUpcomingAppt = r.nextAppointment && r.nextAppointment >= todayStr && r.nextAppointment <= sevenLater;

  // 展开/收起状态
  const itemId = r.id;
  const isExpanded = consumptionExpandedItems.has(itemId);

  // 简略视图
  let html = `
    <div class="consumption-item ${st.class} ${r.archived ? 'archived' : ''} ${hasUpcomingAppt ? 'has-appt' : ''}" id="cons-${itemId}">
      <div class="consumption-item-header" onclick="toggleConsItem('${itemId}')">
        <span class="cons-item-index">${index}</span>
        <div class="consumption-item-name">${r.name}${hasUpcomingAppt ? '<span class="appt-badge">📅 预约</span>' : ''}</div>
        <span class="consumption-item-status ${st.class}">${st.label}</span>
        <span class="cons-toggle-detail">${isExpanded ? '▲' : '▼'}</span>
      </div>
      <div class="consumption-item-summary" onclick="toggleConsItem('${itemId}')">
        <span class="cons-sum-project">${r.project || '-'}</span>
        <span class="cons-sum-amount">¥${(r.amount||0).toFixed(0)}</span>
        ${r.nextAppointment ? `<span class="cons-sum-appt">📅 ${formatDateCN(r.nextAppointment)}</span>` : ''}
        ${r.paymentMethod ? `<span class="cons-sum-pay">${r.paymentMethod}</span>` : ''}
      </div>
  `;

  // 展开详情
  if (isExpanded) {
    html += `<div class="cons-detail-panel">`;
    // 基础信息
    html += `<div class="cons-detail-group"><div class="cons-detail-group-title">📋 基础信息</div>`;
    html += `<div class="cons-detail-row"><span>姓名</span><b>${r.name}</b></div>`;
    if (r.contact) html += `<div class="cons-detail-row"><span>联系方式</span><b>${r.contact}</b></div>`;
    if (r.channel) html += `<div class="cons-detail-row"><span>到店渠道</span><b>${r.channel}</b></div>`;
    html += `</div>`;

    // 成交核心
    html += `<div class="cons-detail-group"><div class="cons-detail-group-title">💰 成交核心</div>`;
    html += `<div class="cons-detail-row"><span>成交金额</span><b style="color:var(--pink);font-size:16px;">¥${(r.amount||0).toFixed(2)}</b></div>`;
    if (r.paymentMethod) html += `<div class="cons-detail-row"><span>付款方式</span><b>${r.paymentMethod}</b></div>`;
    if (r.cardType) html += `<div class="cons-detail-row"><span>卡种</span><b>${r.cardType}</b></div>`;
    html += `<div class="cons-detail-row"><span>成交日期</span><b>${r.date || '-'}</b></div>`;
    html += `<div class="cons-detail-row"><span>状态</span><b>${st.label}</b></div>`;
    html += `</div>`;

    // 项目明细
    html += `<div class="cons-detail-group"><div class="cons-detail-group-title">🧴 项目明细</div>`;
    html += `<div class="cons-detail-row"><span>购买项目</span><b>${r.project || '-'}</b></div>`;
    if (r.giftProjects) html += `<div class="cons-detail-row"><span>赠送项目</span><b>${r.giftProjects}</b></div>`;
    if (r.remainingSessions !== undefined && r.remainingSessions !== null) html += `<div class="cons-detail-row"><span>剩余次数</span><b>${r.remainingSessions}</b></div>`;
    if (r.usageCycle) html += `<div class="cons-detail-row"><span>使用周期</span><b>${r.usageCycle}</b></div>`;
    html += `</div>`;

    // 跟进记录
    if (r.skinIssue || r.skincarePlan || r.nextAppointment) {
      html += `<div class="cons-detail-group"><div class="cons-detail-group-title">📝 跟进记录</div>`;
      if (r.skinIssue) html += `<div class="cons-detail-row"><span>皮肤问题</span><b>${r.skinIssue}</b></div>`;
      if (r.skincarePlan) html += `<div class="cons-detail-row"><span>护肤方案</span><b>${r.skincarePlan}</b></div>`;
      if (r.nextAppointment) html += `<div class="cons-detail-row"><span>下次预约</span><b style="color:${hasUpcomingAppt ? '#F44336' : 'var(--text)'};">${formatDateCN(r.nextAppointment)}${hasUpcomingAppt ? ' ⚠近期' : ''}</b></div>`;
      html += `</div>`;
    }

    // 附加数据
    if (r.balance !== undefined && r.balance !== null && r.balance > 0) {
      html += `<div class="cons-detail-group"><div class="cons-detail-group-title">📦 附加数据</div>`;
      html += `<div class="cons-detail-row"><span>剩余充值余额</span><b>¥${r.balance}</b></div>`;
      if (r.consumedSessions !== undefined && r.consumedSessions !== null) html += `<div class="cons-detail-row"><span>已消费次数</span><b>${r.consumedSessions}</b></div>`;
      if (r.giftCareStatus) html += `<div class="cons-detail-row"><span>赠送护理状态</span><b>${r.giftCareStatus}</b></div>`;
      html += `</div>`;
    }

    // 关联录音
    if (custRecordings.length > 0) {
      html += `<div class="cons-detail-group"><div class="cons-detail-group-title">🎙️ 关联录音 (${custRecordings.length})</div>`;
      custRecordings.forEach(rec => {
        const dur = rec.duration ? Math.floor(rec.duration/60)+'分'+Math.floor(rec.duration%60)+'秒' : '未知';
        const hasT = rec.transcript && rec.transcript.length > 0;
        html += `
          <div class="cons-recording-item">
            <div>
              <div style="font-size:13px;font-weight:600;">${rec.date} · ${dur}</div>
              <div style="font-size:11px;color:var(--text-light);">${hasT ? '已转写 ' + rec.transcript.length + '字' : '待转写'}</div>
            </div>
            <div style="display:flex;gap:4px;">
              <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();closeModal();switchView('recording_review');setTimeout(()=>playRecordingSync('${rec.id}'),250)">▶ 播放</button>
              ${hasT ? `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();closeModal();switchView('recording_review');setTimeout(()=>viewTranscriptSync('${rec.id}'),250)">📄 文稿</button>` : ''}
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }

    // 备注
    if (r.notes) {
      html += `<div class="cons-detail-group"><div class="cons-detail-group-title">💬 备注</div><div style="font-size:13px;color:var(--text);padding:4px 0;">${r.notes}</div></div>`;
    }

    // 操作按钮
    html += `<div class="consumption-item-actions">`;
    html += `<button onclick="event.stopPropagation();showEditConsumption('${r.id}')">✏️ 编辑</button>`;
    if (hasFollowup) html += `<button onclick="event.stopPropagation();jumpToFollowup('${r.name.replace(/'/g, "\\'")}')">👥 跟进档案</button>`;
    if (custRecordings.length > 0) html += `<button onclick="event.stopPropagation();closeModal();switchView('recording_review')">🎙️ 录音(${custRecordings.length})</button>`;
    if (!r.archived) {
      html += `<button class="archive" onclick="event.stopPropagation();archiveConsumption('${r.id}')">📦 归档</button>`;
    } else {
      html += `<button class="archive" onclick="event.stopPropagation();unarchiveConsumption('${r.id}')">📤 取消归档</button>`;
    }
    html += `<button class="danger" onclick="event.stopPropagation();deleteConsumption('${r.id}')">🗑 删除</button>`;
    html += `</div>`;

    html += `</div>`; // close cons-detail-panel
  }

  html += `</div>`; // close consumption-item
  return html;
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
function onConsumptionFilterMonth(val) {
  consumptionFilterMonth = val;
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}
function onConsumptionFilterDate(val) {
  consumptionFilterDate = val;
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}
function toggleConsMonth(key) {
  if (consumptionCollapsedMonths.has(key)) consumptionCollapsedMonths.delete(key);
  else consumptionCollapsedMonths.add(key);
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}
function toggleConsDate(key) {
  if (consumptionCollapsedDates.has(key)) consumptionCollapsedDates.delete(key);
  else consumptionCollapsedDates.add(key);
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}
function toggleConsItem(itemId) {
  if (consumptionExpandedItems.has(itemId)) consumptionExpandedItems.delete(itemId);
  else consumptionExpandedItems.add(itemId);
  const view = document.getElementById('view-consumption');
  if (view) renderConsumption(view);
}

// 跨表联动：从消费跳转到跟进
function jumpToFollowup(name) {
  custSearchKeyword = name;
  switchView('customers');
}

function showAddConsumption() {
  const customers = Store.get('customers', []);
  const custNames = customers.map(c => c.name);

  const html = `
    <div class="modal-header">
      <div class="modal-title">新增成交记录</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="consName" placeholder="顾客姓名" autofocus list="custNameList" oninput="checkConsName(this.value)">
    <datalist id="custNameList">
      ${custNames.map(n => `<option value="${n}">`).join('')}
    </datalist>
    <div id="consNameHint" style="font-size:12px;margin-top:-6px;margin-bottom:8px;display:none;"></div>
    <input class="input-field" id="consContact" placeholder="联系方式（手机号/微信号）">
    <select class="input-field" id="consChannel">
      <option value="">到店渠道（选填）</option>
      <option value="老客转介绍">老客转介绍</option>
      <option value="新客到店">新客到店</option>
      <option value="线上咨询">线上咨询</option>
    </select>
    <input class="input-field" id="consProject" placeholder="成交项目（如：轻秀疗程/超光子/童颜炮）">
    <input class="input-field" type="number" id="consAmount" placeholder="实际成交金额" step="0.01">
    <div style="display:flex;gap:8px;">
      <select class="input-field" id="consPaymentMethod" style="flex:1;">
        <option value="">付款方式</option>
        <option value="微信">微信</option>
        <option value="现金">现金</option>
        <option value="刷卡">刷卡</option>
        <option value="充值抵扣">充值抵扣</option>
        <option value="支付宝">支付宝</option>
      </select>
      <select class="input-field" id="consCardType" style="flex:1;">
        <option value="">卡种</option>
        <option value="疗程卡">疗程卡</option>
        <option value="单次体验">单次体验</option>
        <option value="充值金">充值金</option>
      </select>
    </div>
    <input class="input-field" type="date" id="consDate" value="${formatDate(new Date())}">
    <div class="section-title">操作完成状态</div>
    <select class="input-field" id="consStatus">
      <option value="paid">已付款未操作</option>
      <option value="done">已做完项目</option>
      <option value="aftercare">售后保养阶段</option>
    </select>
    <input class="input-field" id="consGiftProjects" placeholder="赠送项目（选填，如：胶原水光1次）">
    <input class="input-field" type="number" id="consRemainingSessions" placeholder="剩余次数（选填）" min="0">
    <input class="input-field" id="consUsageCycle" placeholder="使用周期规划（选填，如：月底去皱/下周三海润泉）">
    <input class="input-field" id="consSkinIssue" placeholder="面诊皮肤问题（选填）">
    <input class="input-field" id="consSkincarePlan" placeholder="定制护肤方案（选填）">
    <input class="input-field" type="date" id="consNextAppointment" placeholder="下次预约护理时间">
    <div style="display:flex;gap:8px;">
      <input class="input-field" type="number" id="consBalance" placeholder="剩余充值余额（选填）" step="0.01" style="flex:1;">
      <input class="input-field" type="number" id="consConsumedSessions" placeholder="已消费次数（选填）" min="0" style="flex:1;">
    </div>
    <input class="input-field" id="consGiftCareStatus" placeholder="赠送护理使用状态（选填）">
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
  const channel = document.getElementById('consChannel').value;
  const project = document.getElementById('consProject').value.trim();
  const amount = parseFloat(document.getElementById('consAmount').value);
  if (!amount || amount <= 0) { showToast('请输入有效金额'); return; }
  const date = document.getElementById('consDate').value || formatDate(new Date());
  const status = document.getElementById('consStatus').value;
  const paymentMethod = document.getElementById('consPaymentMethod').value;
  const cardType = document.getElementById('consCardType').value;
  const giftProjects = document.getElementById('consGiftProjects').value.trim();
  const remainingSessions = document.getElementById('consRemainingSessions').value ? parseInt(document.getElementById('consRemainingSessions').value) : null;
  const usageCycle = document.getElementById('consUsageCycle').value.trim();
  const skinIssue = document.getElementById('consSkinIssue').value.trim();
  const skincarePlan = document.getElementById('consSkincarePlan').value.trim();
  const nextAppointment = document.getElementById('consNextAppointment').value;
  const balance = document.getElementById('consBalance').value ? parseFloat(document.getElementById('consBalance').value) : null;
  const consumedSessions = document.getElementById('consConsumedSessions').value ? parseInt(document.getElementById('consConsumedSessions').value) : null;
  const giftCareStatus = document.getElementById('consGiftCareStatus').value.trim();
  const notes = document.getElementById('consNotes').value.trim();

  const records = Store.get('consumption', []);
  records.push({
    id: 'r' + Date.now(),
    name, contact, channel, project, amount, date, status,
    paymentMethod, cardType, giftProjects, remainingSessions, usageCycle,
    skinIssue, skincarePlan, nextAppointment, balance, consumedSessions, giftCareStatus,
    notes, archived: false, createdAt: formatDate(new Date())
  });
  Store.set('consumption', records);
  closeModal();
  speak('已记录成交');
  renderConsumption(document.getElementById('view-consumption'));
}

function showEditConsumption(rid) {
  const records = Store.get('consumption', []);
  const r = records.find(rec => rec.id === rid);
  if (!r) return;

  const html = `
    <div class="modal-header">
      <div class="modal-title">编辑成交记录</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="editConsName" value="${r.name.replace(/"/g,'&quot;')}" autofocus>
    <input class="input-field" id="editConsContact" value="${(r.contact||'').replace(/"/g,'&quot;')}" placeholder="联系方式">
    <select class="input-field" id="editConsChannel">
      <option value="" ${!r.channel?'selected':''}>到店渠道（选填）</option>
      <option value="老客转介绍" ${r.channel==='老客转介绍'?'selected':''}>老客转介绍</option>
      <option value="新客到店" ${r.channel==='新客到店'?'selected':''}>新客到店</option>
      <option value="线上咨询" ${r.channel==='线上咨询'?'selected':''}>线上咨询</option>
    </select>
    <input class="input-field" id="editConsProject" value="${(r.project||'').replace(/"/g,'&quot;')}" placeholder="成交项目">
    <input class="input-field" type="number" id="editConsAmount" value="${r.amount||0}" step="0.01">
    <div style="display:flex;gap:8px;">
      <select class="input-field" id="editConsPaymentMethod" style="flex:1;">
        <option value="" ${!r.paymentMethod?'selected':''}>付款方式</option>
        <option value="微信" ${r.paymentMethod==='微信'?'selected':''}>微信</option>
        <option value="现金" ${r.paymentMethod==='现金'?'selected':''}>现金</option>
        <option value="刷卡" ${r.paymentMethod==='刷卡'?'selected':''}>刷卡</option>
        <option value="充值抵扣" ${r.paymentMethod==='充值抵扣'?'selected':''}>充值抵扣</option>
        <option value="支付宝" ${r.paymentMethod==='支付宝'?'selected':''}>支付宝</option>
      </select>
      <select class="input-field" id="editConsCardType" style="flex:1;">
        <option value="" ${!r.cardType?'selected':''}>卡种</option>
        <option value="疗程卡" ${r.cardType==='疗程卡'?'selected':''}>疗程卡</option>
        <option value="单次体验" ${r.cardType==='单次体验'?'selected':''}>单次体验</option>
        <option value="充值金" ${r.cardType==='充值金'?'selected':''}>充值金</option>
      </select>
    </div>
    <input class="input-field" type="date" id="editConsDate" value="${r.date||''}">
    <div class="section-title">操作完成状态</div>
    <select class="input-field" id="editConsStatus">
      <option value="paid" ${r.status==='paid'?'selected':''}>已付款未操作</option>
      <option value="done" ${r.status==='done'?'selected':''}>已做完项目</option>
      <option value="aftercare" ${r.status==='aftercare'?'selected':''}>售后保养阶段</option>
    </select>
    <input class="input-field" id="editConsGiftProjects" value="${(r.giftProjects||'').replace(/"/g,'&quot;')}" placeholder="赠送项目">
    <input class="input-field" type="number" id="editConsRemainingSessions" value="${r.remainingSessions!==null&&r.remainingSessions!==undefined?r.remainingSessions:''}" placeholder="剩余次数" min="0">
    <input class="input-field" id="editConsUsageCycle" value="${(r.usageCycle||'').replace(/"/g,'&quot;')}" placeholder="使用周期规划">
    <input class="input-field" id="editConsSkinIssue" value="${(r.skinIssue||'').replace(/"/g,'&quot;')}" placeholder="面诊皮肤问题">
    <input class="input-field" id="editConsSkincarePlan" value="${(r.skincarePlan||'').replace(/"/g,'&quot;')}" placeholder="定制护肤方案">
    <input class="input-field" type="date" id="editConsNextAppointment" value="${r.nextAppointment||''}" placeholder="下次预约">
    <div style="display:flex;gap:8px;">
      <input class="input-field" type="number" id="editConsBalance" value="${r.balance!==null&&r.balance!==undefined?r.balance:''}" placeholder="剩余充值余额" step="0.01" style="flex:1;">
      <input class="input-field" type="number" id="editConsConsumedSessions" value="${r.consumedSessions!==null&&r.consumedSessions!==undefined?r.consumedSessions:''}" placeholder="已消费次数" min="0" style="flex:1;">
    </div>
    <input class="input-field" id="editConsGiftCareStatus" value="${(r.giftCareStatus||'').replace(/"/g,'&quot;')}" placeholder="赠送护理使用状态">
    <textarea class="input-field" id="editConsNotes" rows="2" placeholder="售后备注">${r.notes||''}</textarea>
    <button class="btn btn-primary btn-full" onclick="saveEditConsumption('${rid}')">保存</button>
  `;
  showModal(html);
}

function saveEditConsumption(rid) {
  const name = document.getElementById('editConsName').value.trim();
  if (!name) { showToast('请输入顾客姓名'); return; }
  const contact = document.getElementById('editConsContact').value.trim();
  const channel = document.getElementById('editConsChannel').value;
  const project = document.getElementById('editConsProject').value.trim();
  const amount = parseFloat(document.getElementById('editConsAmount').value);
  if (!amount || amount <= 0) { showToast('请输入有效金额'); return; }
  const date = document.getElementById('editConsDate').value || formatDate(new Date());
  const status = document.getElementById('editConsStatus').value;
  const paymentMethod = document.getElementById('editConsPaymentMethod').value;
  const cardType = document.getElementById('editConsCardType').value;
  const giftProjects = document.getElementById('editConsGiftProjects').value.trim();
  const remainingSessions = document.getElementById('editConsRemainingSessions').value ? parseInt(document.getElementById('editConsRemainingSessions').value) : null;
  const usageCycle = document.getElementById('editConsUsageCycle').value.trim();
  const skinIssue = document.getElementById('editConsSkinIssue').value.trim();
  const skincarePlan = document.getElementById('editConsSkincarePlan').value.trim();
  const nextAppointment = document.getElementById('editConsNextAppointment').value;
  const balance = document.getElementById('editConsBalance').value ? parseFloat(document.getElementById('editConsBalance').value) : null;
  const consumedSessions = document.getElementById('editConsConsumedSessions').value ? parseInt(document.getElementById('editConsConsumedSessions').value) : null;
  const giftCareStatus = document.getElementById('editConsGiftCareStatus').value.trim();
  const notes = document.getElementById('editConsNotes').value.trim();

  const records = Store.get('consumption', []);
  const idx = records.findIndex(r => r.id === rid);
  if (idx < 0) return;
  records[idx] = { ...records[idx], name, contact, channel, project, amount, date, status,
    paymentMethod, cardType, giftProjects, remainingSessions, usageCycle,
    skinIssue, skincarePlan, nextAppointment, balance, consumedSessions, giftCareStatus, notes };
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
  if (!confirm('确定删除该成交记录吗？')) return;
  const records = Store.get('consumption', []);
  const filtered = records.filter(r => r.id !== rid);
  Store.set('consumption', filtered);
  speak('已删除');
  renderConsumption(document.getElementById('view-consumption'));
}

// 导出成交记录CSV
function exportConsumptionCSV(scope, key) {
  const records = Store.get('consumption', []);
  let filtered = records.filter(r => !r.archived);
  if (scope === 'month') filtered = filtered.filter(r => (r.date || '').startsWith(key));
  if (scope === 'date') filtered = filtered.filter(r => r.date === key);

  const headers = ['顾客姓名','联系方式','到店渠道','成交项目','成交金额','付款方式','卡种','成交日期','状态','赠送项目','剩余次数','使用周期','皮肤问题','护肤方案','下次预约','剩余余额','已消费次数','赠送护理状态','备注'];
  const statusLabels = { paid: '已付款未操作', done: '已做完项目', aftercare: '售后保养阶段' };
  let csv = '\uFEFF' + headers.join(',') + '\n';
  filtered.forEach(r => {
    const row = [r.name, r.contact, r.channel, r.project, r.amount, r.paymentMethod, r.cardType, r.date, statusLabels[r.status]||r.status, r.giftProjects, r.remainingSessions, r.usageCycle, r.skinIssue, r.skincarePlan, r.nextAppointment, r.balance, r.consumedSessions, r.giftCareStatus, r.notes];
    csv += row.map(cell => {
      const s = String(cell !== null && cell !== undefined ? cell : '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `成交记录_${scope === 'month' ? key : scope === 'date' ? key : '全部'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  speak('已导出');
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

  html += `<div class="section-title">🤖 AI智能分析</div>`;
  const aiSettings = getAISettings();
  const aiProviderName = aiSettings.provider ? (AI_CONFIG.providers[aiSettings.provider] ? AI_CONFIG.providers[aiSettings.provider].name : aiSettings.provider) : 'DeepSeek';
  html += `
    <div class="card" style="margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <span style="font-size:26px;">🤖</span>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:14px;">AI面诊分析</div>
          <div style="font-size:12px;color:var(--text-light);">${aiSettings.apiKey ? '✅ 已配置（' + aiProviderName + ' / ' + (aiSettings.model || '-') + '）' : '⚠️ 未配置API密钥'}</div>
        </div>
        <button class="btn btn-sm ${aiSettings.apiKey ? 'btn-outline' : 'btn-primary'}" onclick="showAISettingsModal()">${aiSettings.apiKey ? '✏️ 修改' : '⚡ 去配置'}</button>
      </div>
      <div style="font-size:12px;color:var(--text-light);line-height:1.7;">
        🎙️ 分析面诊录音转写对话，结构化输出6大模块（基础情况/诉求/异议/意向项目/预算/跟进建议）<br>
        📝 分析结果可<b style="color:var(--pink);">一键回填顾客跟进记录</b>，免手动抄写<br>
        🔑 支持 DeepSeek / 通义千问 / OpenAI 兼容接口<br>
        🎧 语音转写：${aiSettings.asrApiKey ? '✅ 已配置' : '⚠️ 未配置（外部导入音频需配置后转写）'}
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
  // 节流：距上次备份不足 60 秒则跳过（高频率 Store.set 不再重复打包）
  const now = Date.now();
  if (now - _lastAutoBackup < 60000) return;
  _lastAutoBackup = now;
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
function showModal(htmlOrTitle, contentOrButtons, maybeButtons) {
  // 兼容多种调用方式:
  // showModal(html) - 旧用法
  // showModal(title, content, buttons) - 新用法
  let title, content, buttons;
  if (contentOrButtons === undefined) {
    content = htmlOrTitle;
    title = '';
    buttons = null;
  } else {
    title = htmlOrTitle;
    content = contentOrButtons;
    buttons = maybeButtons;
  }
  // 保存按钮回调到 window 按索引直接调用
  window.__modalCallbacks = [];
  let btnHtml = '';
  if (buttons && Array.isArray(buttons) && buttons.length > 0) {
    buttons.forEach((btn, i) => {
      window.__modalCallbacks[i] = () => {
        closeModal();
        if (btn.onClick) btn.onClick();
      };
    });
    btnHtml = `<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">` +
      buttons.map((btn, i) => {
        const bg = btn.primary ? 'var(--pink)' : '#fff';
        const color = btn.primary ? '#fff' : 'var(--pink)';
        const border = 'var(--pink)';
        return `<button class="btn" style="flex:1;background:${bg};color:${color};border:1.5px solid ${border};padding:10px 16px;" onclick="window.__modalCallbacks[${i}]()">${btn.text}</button>`;
      }).join('') +
      `</div>`;
  } else {
    btnHtml = `<div style="text-align:center;margin-top:16px;"><button class="btn btn-primary" style="padding:10px 32px;" onclick="closeModal()">关闭</button></div>`;
  }
  const titleHtml = title ? `<div style="font-size:18px;font-weight:700;margin-bottom:12px;color:#333;text-align:center;">${title}</div>` : '';
  document.getElementById('modal').innerHTML = titleHtml + `<div>${content}</div>` + btnHtml;
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
let liveRecognition = null;
let liveTranscriptText = '';
let liveTranscriptSegments = [];
let liveRecognitionRestartTimer = null;
let currentPlaybackAudio = null;
let currentPlaybackHighlightTimer = null;

// ===== 实时语音转文字 =====
function startLiveTranscription() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.log('浏览器不支持SpeechRecognition，将使用手动转写');
    return;
  }
  liveTranscriptText = '';
  liveTranscriptSegments = [];
  liveRecognition = new SR();
  liveRecognition.lang = 'zh-CN';
  liveRecognition.continuous = true;
  liveRecognition.interimResults = true;

  liveRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        const timestamp = Math.floor((Date.now() - recordingStartTime) / 1000);
        liveTranscriptText += transcript;
        liveTranscriptSegments.push({
          text: transcript.trim(),
          timeStart: timestamp,
          timeEnd: timestamp + 5
        });
        // 实时更新UI
        const liveEl = document.getElementById('liveTranscript');
        if (liveEl) {
          liveEl.innerHTML = liveTranscriptSegments.map(s =>
            `<span class="ts-seg" data-time="${s.timeStart}">${s.text}</span>`
          ).join('') + (interim ? `<span class="ts-interim">${interim}</span>` : '');
          liveEl.scrollTop = liveEl.scrollHeight;
        }
      } else {
        interim += transcript;
      }
    }
    const liveEl = document.getElementById('liveTranscript');
    if (liveEl && interim) {
      // 显示临时结果
      const interimEl = liveEl.querySelector('.ts-interim');
      if (interimEl) {
        interimEl.textContent = interim;
      } else {
        liveEl.innerHTML += `<span class="ts-interim">${interim}</span>`;
      }
      liveEl.scrollTop = liveEl.scrollHeight;
    }
  };

  liveRecognition.onerror = (e) => {
    console.log('SpeechRecognition error:', e.error);
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed') {
      showToast('语音识别权限被拒绝，仅录音不转写');
    }
  };

  liveRecognition.onend = () => {
    // 自动重启（录音仍在进行时）
    if (isRecording) {
      clearTimeout(liveRecognitionRestartTimer);
      liveRecognitionRestartTimer = setTimeout(() => {
        if (isRecording && liveRecognition) {
          try { liveRecognition.start(); } catch(e) { console.log('Recognition restart failed:', e); }
        }
      }, 300);
    }
  };

  try { liveRecognition.start(); } catch(e) { console.log('Recognition start failed:', e); }
}

function stopLiveTranscription() {
  clearTimeout(liveRecognitionRestartTimer);
  if (liveRecognition) {
    try { liveRecognition.stop(); } catch(e) {}
    liveRecognition = null;
  }
}

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
      <div id="liveTranscript" style="display:none;max-height:150px;overflow-y:auto;background:var(--pink-soft);border-radius:10px;padding:10px;margin-bottom:10px;font-size:13px;line-height:1.8;text-align:left;"></div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
        <button class="btn btn-primary" id="recStartBtn" onclick="startConsultRecording()" style="padding:10px 24px;">▶ 开始录音</button>
        <button class="btn" style="background:#FF9800;color:#fff;display:none;" id="recPauseBtn" onclick="togglePauseRecording()">⏸ 暂停</button>
        <button class="btn" style="background:#F44336;color:#fff;display:none;" id="recStopBtn" onclick="stopRecording()">⏹ 结束录音</button>
      </div>
      <div style="margin-top:10px;">
        <button class="btn btn-outline" onclick="uploadAudioFile()" style="padding:8px 16px;font-size:13px;border-style:dashed;">📁 导入录音文件（支持iPhone语音备忘录）</button>
      </div>
      <div style="font-size:11px;color:var(--text-light);margin-top:10px;line-height:1.6;">
        ⚡ 录音时自动同步转写文字（需Chrome浏览器）<br>
        🔒 全程无录音标识，保护面诊隐私<br>
        📝 录音结束后文字稿自动生成，可编辑修正<br>
        🎯 支持音频回放时文字同步高亮定位<br>
        📁 外部导入的录音同样支持AI转写与AI分析<br>
        💡 iOS用户：可在「语音备忘录」录好后导入
      </div>
    </div>
  `;
  // 录音列表（性能优化：reviewId 集合一次性构建，避免每项全量扫描 reviewReports）
  if (recordings.length > 0) {
    const reviewedIds = new Set((Store.get('reviewReports', []) || []).map(rv => rv.recordingId));
    html += `<div class="section-title">历史录音 (${recordings.length})</div>`;
    [...recordings].reverse().forEach(r => {
      const dur = r.duration ? Math.floor(r.duration/60)+'分'+Math.floor(r.duration%60)+'秒' : '未知';
      const hasTranscript = r.transcript && r.transcript.length > 0;
      const linkedCustomer = r.customerName || '';
      const hasAIAnalysis = reviewedIds.has(r.id);
      const isUpload = r.source === 'upload';
      html += `
        <div class="recording-item" id="rec-${r.id}">
          <div class="recording-item-header">
            <span style="font-size:16px;">${isUpload ? '📁' : '🎵'}</span>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;font-size:14px;">${linkedCustomer ? '👤 '+linkedCustomer : '未关联顾客'}${isUpload ? '<span style="font-size:11px;color:var(--text-light);font-weight:400;"> · ' + (r.filename||'外部音频') + '</span>' : ''}</div>
              <div style="font-size:12px;color:var(--text-light);">${r.date} · ${dur}</div>
            </div>
            ${isUpload ? '<span class="tag tag-purple">导入</span>' : ''}
            ${hasAIAnalysis ? '<span class="tag tag-green">已分析</span>' : hasTranscript ? '<span class="tag tag-green">已转写</span>' : '<span class="tag tag-orange">待转写</span>'}
            ${r.autoTranscribed ? '<span class="tag tag-blue">自动</span>' : ''}
          </div>
          <div class="recording-item-actions">
            <button class="btn btn-sm btn-outline" onclick="playRecordingSync('${r.id}')">▶ 播放</button>
            ${hasTranscript ? `<button class="btn btn-sm btn-outline" onclick="viewTranscriptSync('${r.id}')">📄 查看文稿</button>` : `<button class="btn btn-sm btn-primary" onclick="transcribeRecording('${r.id}')">📝 转文字</button>`}
            ${hasTranscript ? `<button class="btn btn-sm ${hasAIAnalysis ? 'btn-outline' : 'btn-primary'}" onclick="runAIReview('${r.id}')">${hasAIAnalysis ? '📋 AI报告' : '🤖 AI分析'}</button>` : ''}
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

function startConsultRecording() {
  // 防重入：录音中禁止再次点击（按钮即时响应保障）
  if (isRecording) { showToast('⏳ 正在录音中，请先点击结束'); return; }
  // 详细诊断浏览器能力
  const ua = navigator.userAgent;
  const isWechat = /MicroMessenger/i.test(ua);
  const isIOS = /iPad|iPhone|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/i.test(ua);
  const isStandalone = window.navigator.standalone === true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    if (isWechat) {
      showToast('微信内置浏览器不支持录音，请在Safari中打开');
    } else if (isIOS && !isStandalone) {
      showModal('📱 iOS Safari录音说明', `
        <div style="line-height:1.8;font-size:14px;color:#333;">
          <p style="margin:8px 0;color:#E91E63;font-weight:600;">⚠️ iOS Safari不支持网页内录音</p>
          <p style="margin:12px 0;">这是Apple的安全策略，<b>所有网页录音</b>都需要通过以下方式之一实现：</p>
          <div style="background:#FFF5F8;padding:12px;border-radius:8px;margin:12px 0;">
            <b>✅ 推荐方案：用iPhone「语音备忘录」录好后上传</b>
            <ol style="margin:8px 0;padding-left:20px;font-size:13px;">
              <li>打开iPhone「语音备忘录」App录音</li>
              <li>录好后点击分享 → 存储到"文件"</li>
              <li>回到工作台，点击下方「📁 上传录音文件」</li>
            </ol>
          </div>
          <div style="background:#F0F4FF;padding:12px;border-radius:8px;margin:12px 0;">
            <b>🔧 另一种方式：将页面添加到主屏幕</b>
            <ol style="margin:8px 0;padding-left:20px;font-size:13px;">
              <li>Safari底部分享按钮 → 添加到主屏幕</li>
              <li>从主屏幕图标进入（脱离Safari）</li>
              <li>此时可启用录音</li>
            </ol>
          </div>
        </div>
      `, [{text:'我知道了', primary:true}]);
      return;
    }
    showToast('当前浏览器不支持录音，请使用Chrome浏览器');
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    try {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
                       MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' :
                       MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch(e) {
      // MediaRecorder 创建失败 → 立即释放麦克风并复位，避免假录音
      stream.getTracks().forEach(t => t.stop());
      mediaRecorder = null;
      forceResetRecording();
      showToast('⚠️ 录音器创建失败，请改用「上传录音文件」');
      return;
    }
    isRecording = true;
    audioChunks = [];
    recordingStartTime = Date.now();
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      saveRecordingBlob();
    };
    mediaRecorder.onerror = () => {
      // 录制器运行错误 → 自动停止并复位，杜绝后台静默录制
      if (isRecording) {
        try { mediaRecorder.stop(); } catch(e) {}
        forceResetRecording();
        showToast('⚠️ 录音异常中断，已自动保存');
      }
    };
    mediaRecorder.start(1000);
    // 同步启动实时语音转文字
    startLiveTranscription();
    updateRecordingUI();
    showToast('🔒 录音已开始（静默模式 + 实时转写）');
    speak('开始录音');
  }).catch(err => {
    console.error('录音错误:', err.name, err.message);
    forceResetRecording();
    let msg = '无法获取麦克风权限';
    let detail = '';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = '麦克风权限被拒绝';
      if (isWechat) {
        detail = '微信内置浏览器不支持录音。请点击右上角「...」→「在Safari中打开」，或改用「语音备忘录」录好后上传。';
      } else if (isIOS) {
        detail = 'iOS设置→Safari→麦克风权限，检查是否被禁用。或直接用「语音备忘录」录好后上传。';
      } else {
        detail = '请检查浏览器地址栏左侧是否有权限图标，点击允许后刷新页面重试。';
      }
    } else if (err.name === 'NotFoundError') {
      msg = '未找到麦克风设备';
      detail = '请确认手机麦克风未被占用。';
    } else if (err.name === 'NotReadableError') {
      msg = '麦克风被其他应用占用';
      detail = '请关闭其他正在使用麦克风的应用（如微信语音通话、抖音等）后重试。';
    }
    showModal('🎙️ ' + msg, `
      <div style="line-height:1.8;font-size:14px;color:#333;padding:8px 0;">
        <p style="margin:8px 0;color:#E91E63;font-weight:600;">${msg}</p>
        <p style="margin:8px 0;font-size:13px;color:#666;">${detail}</p>
        <div style="background:#FFF5F8;padding:12px;border-radius:8px;margin:12px 0;">
          <b>💡 备用方案：用iPhone「语音备忘录」录好后上传</b>
          <ol style="margin:6px 0;padding-left:20px;font-size:12px;color:#666;line-height:1.6;">
            <li>打开iPhone「语音备忘录」App录音</li>
            <li>录好后点击分享 → 存储到「文件」</li>
            <li>点击下方「📁 上传录音文件」按钮上传</li>
          </ol>
        </div>
      </div>
    `, [{text:'🔊 前往语音备忘录', primary:false, onClick: () => {
      // 自动跳转iPhone语音备忘录 (深度链接,可能不生效)
      window.location.href = 'shortcuts://'; // 仅供参考
    }}, {text:'📁 去上传录音', primary:true, onClick: () => uploadAudioFile()}]);
  });
}

// 兜底复位：录音状态异常时强制恢复UI与状态，杜绝假录音/后台静默录制
// options.noStop=true 时不再主动 stop（由调用方负责触发保存流程）
function forceResetRecording(options = {}) {
  isRecording = false;
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
  stopLiveTranscription();
  if (!options.noStop && mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch(e) {}
  }
  if (currentPlaybackAudio) {
    try { currentPlaybackAudio.pause(); } catch(e) {}
    currentPlaybackAudio = null;
  }
  const startBtn = document.getElementById('recStartBtn');
  const pauseBtn = document.getElementById('recPauseBtn');
  const stopBtn = document.getElementById('recStopBtn');
  const statusEl = document.getElementById('recStatus');
  const iconEl = document.getElementById('recIcon');
  const timerEl = document.getElementById('recTimer');
  const liveEl = document.getElementById('liveTranscript');
  if (startBtn) { startBtn.style.display = 'inline-block'; startBtn.disabled = false; }
  if (pauseBtn) { pauseBtn.style.display = 'none'; pauseBtn.disabled = false; pauseBtn.textContent = '⏸ 暂停'; }
  if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.disabled = false; stopBtn.classList.remove('rec-live'); }
  if (statusEl) { statusEl.textContent = '准备录音'; statusEl.classList.remove('rec-live'); }
  if (iconEl) { iconEl.textContent = '🎙️'; iconEl.classList.remove('rec-live'); }
  if (timerEl) { timerEl.style.display = 'none'; timerEl.textContent = '00:00'; }
  if (liveEl) liveEl.style.display = 'none';
}

// ===== 暂停/继续录音 =====
function togglePauseRecording() {
  if (!mediaRecorder || !isRecording) return;
  const pauseBtn = document.getElementById('recPauseBtn');
  const statusEl = document.getElementById('recStatus');
  const timerEl = document.getElementById('recTimer');
  if (mediaRecorder.state === 'recording') {
    try { mediaRecorder.pause(); } catch(e) {}
    if (pauseBtn) pauseBtn.textContent = '▶ 继续';
    if (statusEl) statusEl.textContent = '⏸ 已暂停';
    if (timerEl) { timerEl.style.opacity = '0.5'; }
    showToast('⏸ 录音已暂停');
  } else if (mediaRecorder.state === 'paused') {
    try { mediaRecorder.resume(); } catch(e) {}
    if (pauseBtn) pauseBtn.textContent = '⏸ 暂停';
    if (statusEl) statusEl.textContent = '● 录音中... 实时转写已开启';
    if (timerEl) { timerEl.style.opacity = '1'; }
    showToast('▶ 录音继续');
  }
}

// ===== 上传本地音频文件（支持苹果语音备忘录导出的 m4a）=====
function uploadAudioFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.m4a,.mp3,.wav,.aac,.caf,.amr,.ogg,.opus,.flac,.aiff';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // 1. 读取真实时长（元数据）
    let duration = 0;
    try {
      const url = URL.createObjectURL(file);
      duration = await new Promise(resolve => {
        const a = new Audio();
        let done = false;
        const finish = v => { if (!done) { done = true; resolve(v); } };
        a.onloadedmetadata = () => finish(Math.round(a.duration) || 0);
        a.onerror = () => finish(0);
        a.src = url;
        setTimeout(() => finish(0), 6000); // 6s 超时兜底
      });
      URL.revokeObjectURL(url);
    } catch(err) { duration = 0; }
    // 2. 音频 blob 存入 IndexedDB（与内部录制同等待遇）
    const id = 'rec_' + Date.now();
    try { await AudioDB.save(id, file); }
    catch(err) { showToast('❌ 音频保存失败，请重试'); return; }
    const rec = {
      id,
      date: formatDateTime(new Date()),
      filename: file.name,
      size: file.size,
      duration: duration,
      mimeType: file.type || (file.name.toLowerCase().endsWith('.m4a') ? 'audio/mp4' : 'audio/*'),
      source: 'upload',
      hasAudio: true,
      customerName: '', customerPhone: '',
      transcript: '', segments: [], autoTranscribed: false
    };
    const recordings = Store.get('recordings', []);
    recordings.push(rec);
    Store.set('recordings', recordings);
    // 3. 刷新列表
    refreshRecordingList();
    showToast('✅ 已导入：' + file.name + (duration ? '（' + Math.floor(duration/60) + '分' + Math.floor(duration%60) + '秒）' : ''));
    speak('导入成功');
    // 4. 引导绑定顾客档案（可跳过）
    showLinkCustomerModal(id);
  };
  input.click();
}

// 刷新录音列表（兼容不同视图容器）
function refreshRecordingList() {
  const container = document.getElementById('reviewTabContent');
  if (container) { renderReviewTabContent(); return; }
  const v = document.getElementById('view-recording_review');
  if (v) { renderRecordingReview(v); return; }
  const v2 = document.getElementById('view-recording');
  if (v2) renderRecording(v2);
}

// 上传/录音完成后引导绑定顾客（可选：选择已有顾客 或 暂不关联）
function showLinkCustomerModal(id) {
  const customers = Store.get('customers', []);
  const activeCustomers = customers.filter(c => !c.completed);
  let html = `
    <div class="modal-header">
      <div class="modal-title">👤 关联顾客档案（可选）</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:13px;color:var(--text-light);margin-bottom:10px;">录音将跟随所选顾客档案归档，历史可随时回看</div>
  `;
  if (activeCustomers.length > 0) {
    html += `<div style="max-height:260px;overflow-y:auto;">`;
    activeCustomers.forEach(c => {
      html += `<div style="padding:12px;border-bottom:1px solid #F5F5F5;cursor:pointer;border-radius:6px;" onclick="doLinkRecording('${id}','${c.name.replace(/'/g, "\\'")}','${(c.contact||'').replace(/'/g, "\\'")}')">
        <div style="font-weight:700;">${c.name}</div>
        <div style="font-size:12px;color:var(--text-light);">${c.contact||'未留电话'} · ${(c.projects||[]).map(p=>p.name).join('、')||'暂无项目'}</div>
      </div>`;
    });
    html += `</div>`;
  } else {
    html += `<div class="empty-state"><div class="es-icon">👥</div><div class="es-text">暂无顾客档案</div></div>`;
  }
  html += `<div style="display:flex;gap:8px;margin-top:10px;">
    <button class="btn btn-outline" style="flex:1;" onclick="showAddCustomerPrefilled('', '')">➕ 新建顾客</button>
    <button class="btn btn-primary" style="flex:1;" onclick="closeModal()">暂不关联</button>
  </div>`;
  showModal(html);
}

function updateRecordingUI() {
  const startBtn = document.getElementById('recStartBtn');
  const pauseBtn = document.getElementById('recPauseBtn');
  const stopBtn = document.getElementById('recStopBtn');
  const statusEl = document.getElementById('recStatus');
  const iconEl = document.getElementById('recIcon');
  const timerEl = document.getElementById('recTimer');
  const liveEl = document.getElementById('liveTranscript');
  if (startBtn) { startBtn.style.display = 'none'; startBtn.disabled = true; }
  if (pauseBtn) { pauseBtn.style.display = 'inline-block'; pauseBtn.disabled = false; pauseBtn.textContent = '⏸ 暂停'; }
  if (stopBtn) { stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.classList.add('rec-live'); }
  if (statusEl) { statusEl.textContent = '● 录音中... 实时转写已开启'; statusEl.classList.add('rec-live'); }
  if (iconEl) { iconEl.textContent = '🔴'; iconEl.classList.add('rec-live'); }
  if (liveEl) liveEl.style.display = 'block';
  if (timerEl) {
    timerEl.style.display = 'block';
    timerEl.style.opacity = '1';
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
  // 兜底：无录音器或已停止时，仍强制复位UI与状态（确保按钮永远可点）
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    if (isRecording) {
      isRecording = false;
      if (recordingTimer) clearInterval(recordingTimer);
      stopLiveTranscription();
    }
    forceResetRecording();
    showToast('录音已停止');
    return;
  }
  isRecording = false;
  if (recordingTimer) clearInterval(recordingTimer);
  stopLiveTranscription();
  // 按钮立即复位，避免等待 saveRecordingBlob 异步完成导致二次点击无响应
  forceResetRecording({ noStop: true });
  try {
    mediaRecorder.stop();
  } catch(e) {
    showToast('⚠️ 录音停止异常，已自动复位');
  }
  showToast('录音已保存，正在整理文字稿...');
  speak('录音结束');
}

async function saveRecordingBlob() {
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(audioChunks, { type: mimeType });
  const id = 'rec_' + Date.now();
  const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
  // 保存实时转写的文字稿
  const transcript = liveTranscriptText.trim();
  const segments = liveTranscriptSegments.length > 0 ? [...liveTranscriptSegments] : [];
  const rec = {
    id, date: formatDateTime(new Date()), duration,
    hasAudio: true,
    mimeType: mimeType,
    source: 'record',
    transcript: transcript,
    segments: segments,
    autoTranscribed: transcript.length > 0,
    customerName: '', customerPhone: ''
  };
  await AudioDB.save(id, blob);
  const recordings = Store.get('recordings', []);
  recordings.push(rec);
  Store.set('recordings', recordings);
  // 清空实时转写状态
  liveTranscriptText = '';
  liveTranscriptSegments = [];
  // 重新渲染（复用统一刷新入口）
  refreshRecordingList();
  // 如果有转写文字，自动提示
  if (transcript) {
    setTimeout(() => showToast('✅ 文字稿已自动生成（' + transcript.length + '字）'), 500);
  }
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
      ${rec.source === 'upload' ? '<span class="tag tag-blue" style="margin-left:6px;">外部导入</span>' : ''}
    </div>
    ${rec.source === 'upload' || !rec.segments || rec.segments.length === 0 ? `
    <div style="background:#FFF5F8;padding:12px;border-radius:8px;margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;color:var(--pink);margin-bottom:6px;">🤖 AI 一键转写</div>
      <div style="font-size:12px;color:#999;margin-bottom:8px;">上传的录音文件无法用浏览器语音识别，推荐用 AI 云端转写自动生成完整中文文稿</div>
      <button class="btn btn-primary btn-full btn-sm" onclick="transcribeWithAI('${id}')" style="font-size:13px;">🎙️ 开始 AI 转写</button>
    </div>
    ` : ''}
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

// 根据录音信息推断上传文件名扩展名（Whisper 需要）
function getAudioExt(rec) {
  const mime = (rec.mimeType || '').toLowerCase();
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('flac')) return 'flac';
  const fn = (rec.filename || '').toLowerCase();
  const m = fn.match(/\.([a-z0-9]{2,4})$/);
  if (m) return m[1];
  return 'webm';
}

// ===== AI 云端转写（Whisper兼容接口，内外录音通用）=====
async function transcribeWithAI(id) {
  const recordings = Store.get('recordings', []);
  const rec = recordings.find(r => r.id === id);
  if (!rec) return;
  const settings = getAISettings();
  if (!settings.asrApiKey) {
    showModal('🎙️ 需要配置语音转写服务', `
      <div style="line-height:1.8;font-size:14px;color:#333;padding:8px 0;">
        <p style="margin:8px 0;color:#E91E63;font-weight:600;">⚡ AI转写需要配置语音转写服务</p>
        <p style="margin:8px 0;font-size:13px;color:#666;">外部导入的音频（如苹果语音备忘录）用 AI 云端转写自动生成中文文稿，支持 OpenAI Whisper 及兼容接口（阿里云百炼等）。</p>
        <p style="margin:8px 0;font-size:13px;color:#666;">配置位置：设置 → 🤖 AI智能分析 → 🎙️ 语音转写服务</p>
      </div>
    `, [
      { text: '🔧 去配置', primary: true, onClick: () => { closeModal(); switchView('settings'); setTimeout(() => showAISettingsModal(), 300); } },
      { text: '📝 手动输入', primary: false, onClick: () => transcribeRecording(id) }
    ]);
    return;
  }
  const asr = AI_CONFIG.asr[settings.asrProvider] || AI_CONFIG.asr.openai;
  const base = (settings.asrBaseUrl || asr.base).replace(/\/+$/, '');
  const model = settings.asrModel || 'whisper-1';
  const blob = await AudioDB.get(id);
  if (!blob) { showToast('❌ 音频文件丢失，无法转写'); return; }

  showModal('🎙️ AI转写中', `
    <div style="text-align:center;padding:20px;">
      <div style="font-size:36px;margin-bottom:10px;">🎙️</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:8px;">正在AI转写音频...</div>
      <div style="font-size:13px;color:var(--text-light);">${rec.filename || '录音'} · ${rec.duration ? Math.floor(rec.duration/60)+'分'+rec.duration%60+'秒' : ''}</div>
      <div style="margin-top:12px;font-size:12px;color:var(--pink);">⏳ 音频越长耗时越久，请耐心等待</div>
    </div>
  `);
  try {
    const ext = getAudioExt(rec);
    const fd = new FormData();
    fd.append('file', blob, 'recording.' + ext);
    fd.append('model', model);
    fd.append('language', 'zh');
    fd.append('response_format', 'verbose_json'); // 获取分段时间戳，支持播放定位高亮
    const res = await fetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.asrApiKey}` },
      body: fd
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`转写服务返回 ${res.status}: ${errText.slice(0,150)}`);
    }
    const data = await res.json();
    let text = (data && data.text || '').trim();
    if (!text && typeof data === 'string') text = data.trim();
    if (!text) throw new Error('转写结果为空，请检查音频是否有人声');
    // 解析带时间戳的分段（verbose_json），兼容仅返回纯文本的服务
    let segs = [];
    if (Array.isArray(data.segments)) {
      segs = data.segments.map(s => ({
        text: (s.text || '').trim(),
        timeStart: Math.round(s.start || 0),
        timeEnd: Math.round(s.end || 0) + 1
      })).filter(s => s.text);
    }
    // 保存转写结果
    const idx = recordings.findIndex(r => r.id === id);
    if (idx >= 0) {
      recordings[idx].transcript = text;
      recordings[idx].segments = segs;
      recordings[idx].autoTranscribed = true;
      Store.set('recordings', recordings);
      // 归集到顾客档案
      if (recordings[idx].customerName) {
        autoLinkToCustomerProfile(id, recordings[idx].customerName, recordings[idx].customerPhone || '', text, 'recording');
      }
    }
    closeModal();
    showToast('✅ AI转写完成（' + text.length + '字）');
    setTimeout(() => viewTranscriptSync(id), 400);
  } catch(e) {
    console.error('AI转写失败:', e);
    closeModal();
    showModal('❌ AI转写失败', `
      <div style="line-height:1.8;font-size:14px;color:#333;padding:8px 0;">
        <p style="color:var(--red);font-weight:600;">错误信息：${e.message}</p>
        <p style="margin-top:10px;font-size:13px;color:#666;">常见原因：API Key 错误、接口不支持跨域(CORS)、音频格式不支持</p>
      </div>
    `, [
      { text: '🔧 去设置', primary: false, onClick: () => { closeModal(); switchView('settings'); setTimeout(() => showAISettingsModal(), 300); } },
      { text: '📝 手动输入', primary: true, onClick: () => { closeModal(); transcribeRecording(id); } }
    ]);
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
  const activeCustomers = customers.filter(c => !c.completed);
  if (activeCustomers.length === 0) {
    html += `<div class="empty-state"><div class="es-icon">👥</div><div class="es-text">暂无顾客档案，请先在顾客跟进中添加</div></div>`;
  } else {
    activeCustomers.forEach(c => {
      html += `<div style="padding:12px;border-bottom:1px solid #F5F5F5;cursor:pointer;" onclick="doLinkRecording('${id}','${c.name.replace(/'/g, "\\'")}','${(c.contact||'').replace(/'/g, "\\'")}')">
        <div style="font-weight:700;">${c.name}</div>
        <div style="font-size:12px;color:var(--text-light);">${c.contact||'未留电话'} · ${(c.projects||[]).map(p=>p.name).join('、')||'暂无项目'}</div>
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
  // 刷新录音复盘页面
  const container = document.getElementById('reviewTabContent');
  if (container && reviewTab === 'recording') {
    renderRecordingContent(container);
  }
  showToast('✅ 已关联顾客: ' + name);
}

function deleteRecording(id) {
  if (!confirm('确定删除这条录音吗？')) return;
  AudioDB.del(id).catch(() => {});
  let recordings = Store.get('recordings', []);
  recordings = recordings.filter(r => r.id !== id);
  Store.set('recordings', recordings);
  const container = document.getElementById('reviewTabContent');
  if (container) renderRecordingContent(container);
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

  // 检查是否已有AI报告
  const reviews = Store.get('reviewReports', []);
  const existing = reviews.find(rv => rv.recordingId === recordingId);
  if (existing) {
    showReviewDetail(existing.id);
    return;
  }

  // 检查AI API配置
  const settings = getAISettings();
  if (!settings.apiKey) {
    // 无API Key，提示配置
    showModal('🤖 AI智能分析', `
      <div style="line-height:1.8;font-size:14px;color:#333;padding:8px 0;">
        <p style="margin:8px 0;color:#E91E63;font-weight:600;">⚡ AI智能分析需要配置API密钥</p>
        <p style="margin:8px 0;font-size:13px;color:#666;">AI将自动分析面诊对话，提取6大结构化信息：</p>
        <ul style="margin:8px 0;padding-left:20px;font-size:13px;color:#666;line-height:1.8;">
          <li>① 顾客基础情况（皮肤/衰老/痛点）</li>
          <li>② 顾客诉求（改善方向/期待效果）</li>
          <li>③ 异议&顾虑（价格/风险/对比/预算）</li>
          <li>④ 意向项目（匹配门店品项）</li>
          <li>⑤ 预算信息（可接受范围/付款方式）</li>
          <li>⑥ 跟进建议（下一步动作/沟通重点）</li>
        </ul>
        <p style="margin:12px 0;font-size:13px;color:#666;">支持 DeepSeek / 通义千问 / OpenAI 等API</p>
        <div style="background:#FFF5F8;padding:12px;border-radius:8px;margin:12px 0;">
          <b>📌 推荐使用 DeepSeek API</b><br>
          <span style="font-size:12px;color:#999;">注册即送500万tokens免费额度，中文理解能力强</span><br>
          <a href="https://platform.deepseek.com" target="_blank" style="font-size:12px;color:var(--pink);">前往 platform.deepseek.com 注册 →</a>
        </div>
      </div>
    `, [
      { text: '📋 去设置API', primary: true, onClick: () => { closeModal(); switchView('settings'); setTimeout(() => showAISettingsModal(), 300); } },
      { text: '使用规则分析', primary: false, onClick: () => runRuleBasedReview(recordingId) }
    ]);
    return;
  }

  // 开始AI分析
  showModal('🤖 AI分析中', `
    <div style="text-align:center;padding:20px;">
      <div style="font-size:36px;margin-bottom:10px;">🤖</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:8px;">正在分析面诊对话...</div>
      <div style="font-size:13px;color:var(--text-light);">文稿长度：${rec.transcript.length}字</div>
      <div style="margin-top:12px;font-size:12px;color:var(--pink);">⏳ 预计需要10-30秒，请耐心等待</div>
    </div>
  `);

  callAIAPI(rec.transcript).then(result => {
    if (!result.ok) {
      closeModal();
      showToast('❌ AI分析失败: ' + (result.reason || '未知错误'));
      // 提供降级方案
      if (result.reason === 'NO_API_KEY') {
        switchView('settings');
        setTimeout(() => showAISettingsModal(), 300);
      } else {
        showModal('⚠️ AI分析失败', `
          <div style="line-height:1.8;font-size:14px;color:#333;padding:8px 0;">
            <p style="color:var(--red);font-weight:600;">错误信息：${result.reason}</p>
            <p style="margin-top:10px;font-size:13px;color:#666;">您可以使用基于规则的分析作为替代方案</p>
          </div>
        `, [
          { text: '🔧 去设置API', primary: false, onClick: () => { closeModal(); switchView('settings'); setTimeout(() => showAISettingsModal(), 300); } },
          { text: '📋 使用规则分析', primary: true, onClick: () => { closeModal(); runRuleBasedReview(recordingId); } }
        ]);
      }
      return;
    }

    // 保存AI结构化报告
    const aiData = result.data;
    const review = {
      id: 'review_' + Date.now(),
      recordingId,
      customerName: rec.customerName || '未知顾客',
      date: formatDateTime(new Date()),
      type: 'ai_structured',
      aiData: aiData,
      raw: result.raw,
      summary: aiData.summary || 'AI分析完成',
      transcript: rec.transcript,
      // 兼容旧字段
      issues: [],
      suggestions: [],
      totalWords: rec.transcript.length,
      segCount: (rec.segments || []).length
    };
    const reviews2 = Store.get('reviewReports', []);
    const oldIdx = reviews2.findIndex(r => r.recordingId === recordingId);
    if (oldIdx >= 0) reviews2[oldIdx] = review; else reviews2.push(review);
    Store.set('reviewReports', reviews2);

    // 同步到顾客档案
    if (rec.customerName) {
      let customers = Store.get('customers', []);
      const custIdx = customers.findIndex(c => c.name === rec.customerName);
      if (custIdx >= 0) {
        if (!customers[custIdx].reviews) customers[custIdx].reviews = [];
        customers[custIdx].reviews.push({ reviewId: review.id, date: review.date, summary: review.summary });
        Store.set('customers', customers);
      }
    }

    closeModal();
    showReviewDetail(review.id);
    showToast('✅ AI分析完成');
    speak('分析完成');
  });
}

// ===== 音频-文字同步播放 =====
async function playRecordingSync(id) {
  const recordings = Store.get('recordings', []);
  const rec = recordings.find(r => r.id === id);
  if (!rec) return;
  // 如果已在播放，停止
  if (currentPlaybackAudio) {
    currentPlaybackAudio.pause();
    currentPlaybackAudio = null;
  }
  if (currentPlaybackHighlightTimer) {
    clearInterval(currentPlaybackHighlightTimer);
    currentPlaybackHighlightTimer = null;
  }
  const blob = await AudioDB.get(id);
  if (!blob) { showToast('音频文件丢失'); return; }
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentPlaybackAudio = audio;
  // 如果有带时间戳的分段，打开同步文稿
  if (rec.segments && rec.segments.length > 0) {
    viewTranscriptSync(id);
    audio.ontimeupdate = () => {
      const cur = audio.currentTime;
      const segs = document.querySelectorAll('.ts-sync-seg');
      segs.forEach(el => el.classList.remove('ts-active'));
      // 找到当前时间对应的文字段
      let found = false;
      for (let i = rec.segments.length - 1; i >= 0; i--) {
        if (cur >= rec.segments[i].timeStart) {
          const el = document.getElementById('tsSeg_' + i);
          if (el) {
            el.classList.add('ts-active');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            found = true;
          }
          break;
        }
      }
    };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      currentPlaybackAudio = null;
      const segs = document.querySelectorAll('.ts-sync-seg');
      segs.forEach(el => el.classList.remove('ts-active'));
      const btn = document.getElementById('syncPlayBtn');
      if (btn) { btn.textContent = '▶ 播放'; }
    };
  } else {
    audio.onended = () => { URL.revokeObjectURL(url); currentPlaybackAudio = null; };
  }
  audio.play();
  showToast('▶ 正在播放...');
}

// ===== 同步文稿查看 =====
function viewTranscriptSync(id) {
  const recordings = Store.get('recordings', []);
  const rec = recordings.find(r => r.id === id);
  if (!rec || !rec.transcript) { showToast('暂无文稿'); return; }
  let html = `
    <div class="modal-header">
      <div class="modal-title">📄 录音文稿（同步播放）</div>
      <button class="modal-close" onclick="closeModal();stopPlayback()">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-light);margin-bottom:12px;">
      ${rec.customerName ? '👤 '+rec.customerName+' · ' : ''}${rec.date} · ${rec.transcript.length}字
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button class="btn btn-sm btn-primary" id="syncPlayBtn" onclick="togglePlayback('${id}')">⏸ 暂停</button>
      <button class="btn btn-sm btn-outline" onclick="copyText('${rec.transcript.replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/"/g,'&quot;')}')">📋 复制全文</button>
    </div>
    <div id="transcriptSyncContainer" style="background:var(--pink-soft);border-radius:12px;padding:14px;max-height:55vh;overflow-y:auto;line-height:2;font-size:14px;">
  `;
  if (rec.segments && rec.segments.length > 0) {
    rec.segments.forEach((seg, i) => {
      const mm = String(Math.floor(seg.timeStart/60)).padStart(2,'0');
      const ss = String(seg.timeStart%60).padStart(2,'0');
      html += `<span class="ts-sync-seg" id="tsSeg_${i}" data-time="${seg.timeStart}" onclick="seekTo(${seg.timeStart})">
        <span class="ts-time">[${mm}:${ss}]</span>${seg.text} 
      </span>`;
    });
  } else {
    html += `<div style="white-space:pre-wrap;color:var(--text);">${rec.transcript}</div>`;
  }
  html += `</div>`;
  html += `<div style="margin-top:12px;display:flex;gap:8px;">
    <button class="btn btn-outline btn-full btn-sm" onclick="editTranscript('${id}')">✏️ 编辑文稿</button>
    <button class="btn btn-primary btn-full btn-sm" onclick="closeModal();runAIReview('${id}')">🤖 AI分析</button>
  </div>`;
  showModal(html);
}

function stopPlayback() {
  if (currentPlaybackAudio) {
    currentPlaybackAudio.pause();
    currentPlaybackAudio = null;
  }
  if (currentPlaybackHighlightTimer) {
    clearInterval(currentPlaybackHighlightTimer);
    currentPlaybackHighlightTimer = null;
  }
}

function togglePlayback(id) {
  if (!currentPlaybackAudio) {
    playRecordingSync(id);
    return;
  }
  const btn = document.getElementById('syncPlayBtn');
  if (currentPlaybackAudio.paused) {
    currentPlaybackAudio.play();
    if (btn) btn.textContent = '⏸ 暂停';
  } else {
    currentPlaybackAudio.pause();
    if (btn) btn.textContent = '▶ 继续';
  }
}

function seekTo(seconds) {
  if (currentPlaybackAudio) {
    currentPlaybackAudio.currentTime = seconds;
  } else {
    // 如果未在播放，先开始播放
    const recId = document.querySelector('.ts-sync-seg')?.closest('[id]')?.id;
    // 直接使用最近的录音ID
    const recordings = Store.get('recordings', []);
    const activeSeg = document.querySelector('.ts-sync-seg');
    if (activeSeg) {
      // 通过data-time找到录音ID不太直接，简化处理
    }
  }
}

// 编辑文稿
function editTranscript(id) {
  const recordings = Store.get('recordings', []);
  const rec = recordings.find(r => r.id === id);
  if (!rec) return;
  let html = `
    <div class="modal-header">
      <div class="modal-title">✏️ 编辑文字稿</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <input class="input-field" id="editTransName" placeholder="顾客姓名" value="${(rec.customerName||'').replace(/"/g,'&quot;')}">
    <textarea class="input-field" id="editTransText" style="min-height:300px;font-size:13px;line-height:1.8;" placeholder="编辑文字稿...">${(rec.transcript||'').replace(/</g,'&lt;')}</textarea>
    <div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">提示：可使用【咨询师】：和【顾客】：标记发言人</div>
    <button class="btn btn-primary btn-full" onclick="saveEditTranscript('${id}')">💾 保存</button>
  `;
  showModal(html);
}

function saveEditTranscript(id) {
  const name = document.getElementById('editTransName').value.trim();
  const text = document.getElementById('editTransText').value.trim();
  if (!text) { showToast('文稿不能为空'); return; }
  const recordings = Store.get('recordings', []);
  const idx = recordings.findIndex(r => r.id === id);
  if (idx < 0) return;
  // 重新解析分段
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
  recordings[idx].transcript = text;
  recordings[idx].segments = segments.length > 0 ? segments : recordings[idx].segments || [];
  recordings[idx].customerName = name;
  Store.set('recordings', recordings);
  if (name) autoLinkToCustomerProfile(id, name, recordings[idx].customerPhone || '', text, 'recording');
  closeModal();
  showToast('✅ 文稿已更新');
  const view = document.getElementById('view-recording_review');
  if (view) renderRecordingReview(view);
}

// ===== AI API 集成 =====
const AI_CONFIG = {
  // 默认使用DeepSeek API（性价比高，支持中文，CORS友好）
  providers: {
    deepseek: {
      name: 'DeepSeek',
      url: 'https://api.deepseek.com/v1/chat/completions',
      models: ['deepseek-chat', 'deepseek-reasoner']
    },
    qwen: {
      name: '通义千问',
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      models: ['qwen-turbo', 'qwen-plus', 'qwen-max']
    },
    openai: {
      name: 'OpenAI兼容',
      url: '',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo']
    }
  },
  // 语音转写服务（Whisper兼容 /audio/transcriptions 端点）
  asr: {
    openai: { name: 'OpenAI Whisper', base: 'https://api.openai.com/v1', model: 'whisper-1' },
    custom: { name: '自定义兼容端点', base: '', model: 'whisper-1' }
  }
};

function getAISettings() {
  return Store.get('aiSettings', {
    provider: 'deepseek',
    apiKey: '',
    model: 'deepseek-chat',
    customUrl: '',
    asrProvider: 'openai',
    asrApiKey: '',
    asrBaseUrl: '',
    asrModel: 'whisper-1'
  });
}

function saveAISettings(settings) {
  Store.set('aiSettings', settings);
}

// 门店项目列表（用于AI分析匹配）
const CLINIC_PROJECTS = [
  '美瑶时光机', '超光子', '舒敏之星', '童颜炮',
  '肉毒除皱', '清绣', '填充',
  '水光针', '热玛吉', '超声炮', '光子嫩肤',
  '玻尿酸', '胶原蛋白', '线雕', '皮秒', '黄金微针'
];

// 构建AI分析prompt
// 构建AI分析prompt（升级版：固定6大模块 + 参考样例）
function buildAIPrompt(transcript) {
  return `你是一位资深的医美咨询师AI助手。请分析以下面诊录音转写文本，提取关键信息并**固定输出6大结构化模块**（可直接用于顾客跟进台账）。

## 面诊对话文本：
${transcript}

## 门店可选项目列表（意向项目只能从这里选）：
${CLINIC_PROJECTS.join('、')}

## 输出要求（严格JSON格式，不要输出任何其他内容，不要用markdown代码块包裹）：
{
  "customerBasics": {
    "skinIssues": "顾客的皮肤问题（斑点/毛孔/暗沉/痘印等），未提及填'未提及'",
    "agingIssues": "顾客的衰老问题（法令纹/松弛/下垂/眼袋/泪沟等），未提及填'未提及'",
    "painPoints": "顾客最在意的核心痛点（一句话说清）"
  },
  "customerNeeds": {
    "wantsToImprove": "顾客想改善的具体问题",
    "expectedResults": "顾客期待的效果（如'自然'/'性价比高'/'一次见效'等）",
    "priceSensitivity": "价格敏感度判断（高/中/低）及依据"
  },
  "objections": [
    {"type": "价格顾虑|风险顾虑|竞品对比|预算顾虑|其他", "content": "顾客原话或转述的顾虑内容"}
  ],
  "interestedProjects": ["从门店项目列表中精确匹配顾客表现出兴趣的项目，一个元素一个项目"],
  "budget": {
    "acceptableBudget": "顾客可接受的预算金额范围（如'3000元以内'/'5000-8000元'，未提及填'未提及'）",
    "paymentMethod": "付款方式信息（分期/一次性/按次付费等，未提及填'未提及'）",
    "depositInfo": "收款/定金/尾款/欠款信息（未提及填'未提及'）"
  },
  "followUpSuggestions": {
    "nextActions": "给咨询师的下一步具体跟进动作（建议分1-2-3条）",
    "keyPoints": "下次沟通重点（如针对某顾虑的讲解要点）"
  },
  "summary": "一句话总结本次面诊"
}

## 输出参考样例（学习其格式与颗粒度，不要照搬内容）：
{
  "customerBasics": {"skinIssues": "眼袋膨出，泪沟凹陷", "agingIssues": "眼袋明显，显疲惫感", "painPoints": "眼袋影响形象，想尽快改善"},
  "customerNeeds": {"wantsToImprove": "改善眼袋，去掉显老感", "expectedResults": "自然平整，性价比高", "priceSensitivity": "高，多处比价"},
  "objections": [{"type": "竞品对比", "content": "外部咨询1500元做眼袋，对比本店3000元起"}, {"type": "价格顾虑", "content": "担心价格偏高"}, {"type": "风险顾虑", "content": "担忧手术风险和恢复期"}],
  "interestedProjects": ["眶隔释放眼袋"],
  "budget": {"acceptableBudget": "上限3000元", "paymentMethod": "未提及", "depositInfo": "未提及"},
  "followUpSuggestions": {"nextActions": ["微信发送不同术式对比要点", "提供门店真实案例对比图", "三天后回访跟进"], "keyPoints": "重点讲解不同术式差异，不强求当场成交"},
  "summary": "顾客对眼袋改善需求明确，预算有限且关注性价比，需以案例和专业讲解建立信任"
}

## 注意：
1. 每项必须输出，未提及的填"未提及"，不要编造
2. 仔细识别医美口语化表达（如'做个眼睛'=眼整形、'打水光'=水光针、'美瑶'=美瑶时光机）
3. 金额、数字、时间必须原样保留（如'3000'不要写成'三千'）
4. objections 只列顾客真实表达过的顾虑，type 从枚举中选
5. interestedProjects 只匹配门店项目列表中的名称`;
}

// 调用AI API
async function callAIAPI(transcript) {
  const settings = getAISettings();
  if (!settings.apiKey) {
    return { ok: false, reason: 'NO_API_KEY' };
  }
  const provider = AI_CONFIG.providers[settings.provider] || AI_CONFIG.providers.deepseek;
  const url = settings.customUrl || provider.url;
  const model = settings.model || 'deepseek-chat';
  const prompt = buildAIPrompt(transcript);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: '你是一位专业的医美咨询师AI助手，擅长分析面诊对话并提取关键信息。必须严格按照要求输出纯JSON，不要用markdown代码块包裹。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 2500
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, reason: `API错误(${res.status}): ${errText.slice(0,200)}` };
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    // 提取JSON（兼容 markdown 代码块包裹）
    let jsonStr = content;
    const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1];
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
    const parsed = JSON.parse(jsonStr);
    return { ok: true, data: parsed, raw: content };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
}
// ===== 复盘报告展示 =====
function showReviewDetail(reviewId) {
  const reviews = Store.get('reviewReports', []);
  const review = reviews.find(r => r.id === reviewId);
  if (!review) return;
  if (review.type === 'ai_structured' && review.aiData) {
    showAIStructuredDetail(review);
  } else {
    showRuleBasedDetail(review);
  }
}

// 规则分析报告展示（旧版AI复盘样式）
function showRuleBasedDetail(review) {
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

// ===== AI结构化报告展示（6大模块）=====
function showAIStructuredDetail(review) {
  const d = review.aiData || {};
  const basics = d.customerBasics || {};
  const needs = d.customerNeeds || {};
  const objections = Array.isArray(d.objections) ? d.objections : [];
  const projects = Array.isArray(d.interestedProjects) ? d.interestedProjects : [];
  const budget = d.budget || {};
  const follow = d.followUpSuggestions || {};

  const esc = (s) => (s == null ? '未提及' : String(s).replace(/</g, '&lt;'));

  let html = `
    <div class="modal-header">
      <div class="modal-title">🤖 AI智能分析报告</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-light);margin-bottom:12px;">
      👤 ${esc(review.customerName)} · ${review.date} · 基于${review.totalWords}字对话
    </div>
  `;

  // ① 顾客基础情况
  html += `<div class="ai-summary-box"><div style="font-weight:700;font-size:14px;margin-bottom:6px;">① 顾客基础情况</div>
    <div class="ai-field"><div class="ai-field-label">🟤 皮肤问题</div><div class="ai-field-value">${esc(basics.skinIssues)}</div></div>
    <div class="ai-field"><div class="ai-field-label">👵 衰老问题</div><div class="ai-field-value">${esc(basics.agingIssues)}</div></div>
    <div class="ai-field"><div class="ai-field-label">💔 核心痛点</div><div class="ai-field-value">${esc(basics.painPoints)}</div></div>
  </div>`;

  // ② 顾客诉求
  html += `<div class="ai-summary-box"><div style="font-weight:700;font-size:14px;margin-bottom:6px;">② 顾客诉求</div>
    <div class="ai-field"><div class="ai-field-label">✨ 想改善什么</div><div class="ai-field-value">${esc(needs.wantsToImprove)}</div></div>
    <div class="ai-field"><div class="ai-field-label">🎯 期待效果</div><div class="ai-field-value">${esc(needs.expectedResults)}</div></div>
  </div>`;

  // ③ 异议&顾虑
  html += `<div class="ai-summary-box"><div style="font-weight:700;font-size:14px;margin-bottom:6px;">③ 异议 &amp; 顾虑 <span style="font-size:11px;color:var(--text-light);font-weight:400;">${objections.length ? '(' + objections.length + '条)' : ''}</span></div>`;
  if (objections.length > 0) {
    objections.forEach(o => {
      html += `<div class="ai-objection-item"><span class="ai-obj-type">${esc(o.type || '顾虑')}</span><span style="color:var(--text);">${esc(o.content)}</span></div>`;
    });
  } else {
    html += `<div class="ai-field"><div class="ai-field-value" style="color:var(--text-light);">对话中未提及明显异议</div></div>`;
  }
  html += `</div>`;

  // ④ 意向项目
  html += `<div class="ai-summary-box"><div style="font-weight:700;font-size:14px;margin-bottom:6px;">④ 意向项目</div>`;
  if (projects.length > 0) {
    html += projects.map(p => `<span class="ai-project-chip">${esc(p)}</span>`).join('');
  } else {
    html += `<div class="ai-field"><div class="ai-field-value" style="color:var(--text-light);">未识别到明确意向项目</div></div>`;
  }
  html += `</div>`;

  // ⑤ 预算信息
  html += `<div class="ai-summary-box"><div style="font-weight:700;font-size:14px;margin-bottom:6px;">⑤ 预算信息</div>
    <div class="ai-field"><div class="ai-field-label">💰 可接受预算</div><div class="ai-field-value">${esc(budget.acceptableBudget)}</div></div>
    <div class="ai-field"><div class="ai-field-label">💳 付款方式</div><div class="ai-field-value">${esc(budget.paymentMethod)}</div></div>
    <div class="ai-field"><div class="ai-field-label">🧾 欠款尾款</div><div class="ai-field-value">${esc(budget.depositInfo)}</div></div>
  </div>`;

  // ⑥ 跟进建议
  html += `<div class="ai-summary-box"><div style="font-weight:700;font-size:14px;margin-bottom:6px;">⑥ 跟进建议</div>
    <div class="ai-field"><div class="ai-field-label">📌 后续跟进动作</div><div class="ai-field-value">${esc(follow.nextActions)}</div></div>
    <div class="ai-field"><div class="ai-field-label">💬 下次沟通重点</div><div class="ai-field-value">${esc(follow.keyPoints)}</div></div>
  </div>`;

  // 总结 + 操作按钮
  html += `
    <div class="ai-summary-box" style="background:#FFF8E1;"><div style="font-weight:700;font-size:14px;margin-bottom:6px;">📋 面诊小结</div>
      <div class="ai-field-value">${esc(d.summary)}</div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
      <button class="btn btn-outline" style="flex:1;min-width:100px;" onclick="copyAIResult('${review.id}')">📋 复制报告</button>
      <button class="btn btn-primary" style="flex:1;min-width:140px;" onclick="fillFollowupFromAI('${review.recordingId}')">📝 回填顾客跟进</button>
    </div>
    <button class="btn btn-outline btn-full btn-sm" style="margin-top:8px;" onclick="closeModal()">✅ 关闭</button>
  `;
  showModal(html);
}

// 复制AI结构化报告为文本
function copyAIResult(reviewId) {
  const reviews = Store.get('reviewReports', []);
  const review = reviews.find(r => r.id === reviewId);
  if (!review || !review.aiData) { showToast('未找到AI报告'); return; }
  const d = review.aiData;
  const f = (s) => (s == null || s === '' ? '未提及' : s);
  const lines = [];
  lines.push('【AI智能分析报告】' + (review.customerName ? ' - ' + review.customerName : ''));
  lines.push('时间：' + review.date);
  lines.push('━━━━━━━━━━━━');
  lines.push('① 顾客基础情况');
  lines.push('皮肤问题：' + f(d.customerBasics?.skinIssues));
  lines.push('衰老问题：' + f(d.customerBasics?.agingIssues));
  lines.push('核心痛点：' + f(d.customerBasics?.painPoints));
  lines.push('━━━━━━━━━━━━');
  lines.push('② 顾客诉求');
  lines.push('想改善：' + f(d.customerNeeds?.wantsToImprove));
  lines.push('期待效果：' + f(d.customerNeeds?.expectedResults));
  lines.push('━━━━━━━━━━━━');
  lines.push('③ 异议&顾虑');
  if (Array.isArray(d.objections) && d.objections.length > 0) {
    d.objections.forEach(o => lines.push('· ' + (o.type || '顾虑') + '：' + f(o.content)));
  } else {
    lines.push('· 未提及');
  }
  lines.push('━━━━━━━━━━━━');
  lines.push('④ 意向项目：' + ((Array.isArray(d.interestedProjects) && d.interestedProjects.length) ? d.interestedProjects.join('、') : '未提及'));
  lines.push('━━━━━━━━━━━━');
  lines.push('⑤ 预算信息');
  lines.push('可接受预算：' + f(d.budget?.acceptableBudget));
  lines.push('付款方式：' + f(d.budget?.paymentMethod));
  lines.push('欠款尾款：' + f(d.budget?.depositInfo));
  lines.push('━━━━━━━━━━━━');
  lines.push('⑥ 跟进建议');
  lines.push('后续动作：' + f(d.followUpSuggestions?.nextActions));
  lines.push('沟通重点：' + f(d.followUpSuggestions?.keyPoints));
  lines.push('━━━━━━━━━━━━');
  lines.push('小结：' + f(d.summary));
  copyText(lines.join('\n'));
}

// AI结果回填顾客跟进记录
function fillFollowupFromAI(recordingId) {
  const recordings = Store.get('recordings', []);
  const rec = recordings.find(r => r.id === recordingId);
  const reviews = Store.get('reviewReports', []);
  const review = reviews.find(rv => rv.recordingId === recordingId && rv.aiData);
  if (!review) { showToast('未找到AI分析结果'); return; }
  const d = review.aiData;
  const f = (s) => (s == null || s === '' ? '未提及' : s);
  const projects = Array.isArray(d.interestedProjects) ? d.interestedProjects.filter(p => p && p !== '未提及') : [];

  const contentLines = [];
  contentLines.push('【AI智能分析 - ' + (rec && rec.customerName ? rec.customerName : '面诊顾客') + '】');
  contentLines.push('📌 顾客基础：皮肤(' + f(d.customerBasics?.skinIssues) + ')，衰老(' + f(d.customerBasics?.agingIssues) + ')，痛点(' + f(d.customerBasics?.painPoints) + ')');
  contentLines.push('🎯 诉求：想改善(' + f(d.customerNeeds?.wantsToImprove) + ')，期待(' + f(d.customerNeeds?.expectedResults) + ')');
  if (Array.isArray(d.objections) && d.objections.length > 0) {
    contentLines.push('⚠️ 异议：' + d.objections.map(o => (o.type || '顾虑') + '(' + f(o.content) + ')').join('；'));
  }
  if (projects.length > 0) {
    contentLines.push('💎 意向项目：' + projects.join('、'));
  }
  contentLines.push('💰 预算：可接受(' + f(d.budget?.acceptableBudget) + ')，付款(' + f(d.budget?.paymentMethod) + ')，欠款尾款(' + f(d.budget?.depositInfo) + ')');
  contentLines.push('📝 跟进：动作(' + f(d.followUpSuggestions?.nextActions) + ')，重点(' + f(d.followUpSuggestions?.keyPoints) + ')');
  const content = contentLines.join('\n');

  // 已关联顾客 → 直接预填跟进表单；否则 → 预填新增顾客
  if (rec && rec.customerName) {
    const customers = Store.get('customers', []);
    const cust = customers.find(c => c.name === rec.customerName);
    if (cust) {
      showAddFollowupPrefilled(cust.id, content, projects);
      return;
    }
  }
  showAddCustomerPrefilled(rec ? rec.customerName : '', content, projects);
}

// 预填跟进记录表单（AI内容）
function showAddFollowupPrefilled(cid, content, projects) {
  let customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const c = customers.find(cu => cu.id === cid);
  if (!c) return;

  const aiProjectHint = (projects && projects.length > 0)
    ? `<div style="font-size:12px;color:var(--pink);background:var(--pink-soft);border:1px dashed #FFD1DC;border-radius:8px;padding:8px 10px;margin-bottom:10px;">💎 AI识别意向项目：${projects.map(p => '<b>' + p + '</b>').join('、')}<br><span style="color:var(--text-light);">可稍后在顾客档案中新增对应项目</span></div>`
    : '';

  let projectSelectHtml = '';
  if (c.projects && c.projects.length > 0) {
    projectSelectHtml = '<select class="input-field" id="followupProject"><option value="">不关联项目</option>' +
      c.projects.map(p => `<option value="${p.id}">${p.name}${p.completed ? ' (已完成)' : ''}</option>`).join('') +
      '</select>';
  }

  const html = `
    <div class="modal-header">
      <div class="modal-title">📝 记录跟进 - ${c.name}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">AI分析结果已自动填入，可修改后保存</div>
    ${projectSelectHtml}
    ${aiProjectHint}
    <textarea class="input-field" id="followupContent" rows="7" autofocus style="font-size:13px;line-height:1.7;">${content.replace(/</g, '&lt;')}</textarea>
    <input class="input-field" type="date" id="followupNextRevisit" placeholder="下次约定回访时间">
    <button class="btn btn-primary btn-full" onclick="saveFollowup('${cid}')">💾 保存跟进记录</button>
  `;
  showModal(html);
}

// 预填新增顾客表单（AI内容，无档案时）
function showAddCustomerPrefilled(name, content, projects) {
  const projectStr = (projects && projects.length > 0) ? projects.join('、') : '';
  const html = `
    <div class="modal-header">
      <div class="modal-title">✨ 新建顾客档案并保存AI分析</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">该录音未关联顾客档案，请补充信息后保存（AI分析已自动填入）</div>
    <input class="input-field" id="custName" placeholder="顾客姓名" value="${(name || '').replace(/"/g, '&quot;')}" autofocus oninput="checkCustName(this.value)">
    <div id="custNameHint" style="font-size:12px;margin-top:-6px;margin-bottom:8px;display:none;"></div>
    <input class="input-field" id="custContact" placeholder="联系方式（手机号/微信号）">
    <input class="input-field" id="custProject" placeholder="铺垫项目（如：热玛吉/水光针）" value="${projectStr.replace(/"/g, '&quot;')}">
    <textarea class="input-field" id="custThought" placeholder="顾客想法/分析" rows="5" style="font-size:13px;line-height:1.7;">${content.replace(/</g, '&lt;')}</textarea>
    <input class="input-field" type="date" id="custRevisit" placeholder="约定回访时间">
    <div class="section-title">跟进优先级</div>
    <div class="cust-priority-selector">
      <div class="cust-priority-opt urgent active" data-priority="urgent" onclick="selectPriority(this)">7天紧急回访</div>
      <div class="cust-priority-opt month" data-priority="month" onclick="selectPriority(this)">1个月内回访</div>
      <div class="cust-priority-opt long" data-priority="long" onclick="selectPriority(this)">长期慢慢跟进</div>
    </div>
    <button class="btn btn-primary btn-full" onclick="saveNewCustomer()">💾 保存并建档</button>
  `;
  showModal(html);
}

// ===== 规则分析降级方案（无API Key时）=====
function runRuleBasedReview(recordingId) {
  const recordings = Store.get('recordings', []);
  const rec = recordings.find(r => r.id === recordingId);
  if (!rec || !rec.transcript) { showToast('请先完成录音转写'); return; }
  const text = rec.transcript;
  const issues = [];
  const suggestions = [];
  const hasPrice = /价格|多少钱|贵|预算|优惠|折扣|分期|付款/.test(text);
  const hasEffect = /效果|改善|变美|紧致|提拉|淡斑|嫩肤|年轻/.test(text);
  const hasRisk = /风险|副作用|恢复期|疼|痛|会不会|安全|过敏/.test(text);
  const hasPlan = /回访|下次|联系|跟进|考虑|决定/.test(text);

  if (hasPrice && !hasEffect) {
    issues.push({ severity: 'high', type: '只谈价格未讲效果', desc: '对话主要围绕价格讨论，未充分讲解项目效果与价值，顾客容易只比价格、不成交，建议补充效果与案例讲解。' });
  }
  if (!hasPrice) {
    issues.push({ severity: 'medium', type: '未触及预算', desc: '对话中未了解顾客预算范围与付款方式，建议后续沟通中主动询问，便于推荐匹配方案。' });
  }
  if (!hasRisk) {
    issues.push({ severity: 'medium', type: '未讲解风险与恢复期', desc: '未向顾客说明项目风险、副作用及恢复期，容易造成成交后退单或差评，建议主动如实告知。' });
  }
  if (!hasPlan) {
    issues.push({ severity: 'medium', type: '缺少跟进规划', desc: '未约定下次联系时间与方式，顾客容易流失，建议在结束前明确回访安排。' });
  }
  if (issues.length === 0) {
    suggestions.push('沟通覆盖较全面，保持效果与风险双向讲解，继续强化信任。');
  }
  suggestions.push(hasPrice ? '已了解预算信息，可为其准备对应价位的组合方案。' : '下次沟通重点：了解顾客预算与可接受的付款方式。');
  suggestions.push('用真实案例照片/视频讲解预期效果，增强顾客信任感。');
  suggestions.push('约定明确的回访时间并做好到店提醒，跟进意向项目。');

  const review = {
    id: 'review_' + Date.now(),
    recordingId,
    customerName: rec.customerName || '未知顾客',
    date: formatDateTime(new Date()),
    type: 'rule_based',
    issues: issues,
    suggestions: suggestions,
    summary: '（基于关键词规则的快速分析）' + text.slice(0, 120) + (text.length > 120 ? '…' : ''),
    totalWords: text.length,
    segCount: (rec.segments || []).length
  };
  const reviews = Store.get('reviewReports', []);
  const oldIdx = reviews.findIndex(r => r.recordingId === recordingId);
  if (oldIdx >= 0) reviews[oldIdx] = review; else reviews.push(review);
  Store.set('reviewReports', reviews);
  closeModal();
  showReviewDetail(review.id);
  showToast('✅ 规则分析完成');
}

// ===== AI API 设置弹窗 =====
function showAISettingsModal() {
  const s = getAISettings();
  const providerOptions = Object.keys(AI_CONFIG.providers).map(k =>
    `<option value="${k}" ${s.provider === k ? 'selected' : ''}>${AI_CONFIG.providers[k].name}</option>`
  ).join('');
  const html = `
    <div class="modal-header">
      <div class="modal-title">🤖 AI智能分析设置</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <label style="font-size:13px;font-weight:600;color:#333;display:block;margin:4px 0 6px;">API服务商</label>
    <select class="input-field" id="aiProvider" onchange="updateAIModelOptions()">${providerOptions}</select>
    <label style="font-size:13px;font-weight:600;color:#333;display:block;margin:12px 0 6px;">模型</label>
    <select class="input-field" id="aiModel"></select>
    <label style="font-size:13px;font-weight:600;color:#333;display:block;margin:12px 0 6px;">API Key</label>
    <input class="input-field" id="aiApiKey" type="password" placeholder="sk-..." value="${(s.apiKey || '').replace(/"/g, '&quot;')}">
    <label style="font-size:13px;font-weight:600;color:#333;display:block;margin:12px 0 6px;">自定义接口地址（可选）</label>
    <input class="input-field" id="aiCustomUrl" placeholder="留空使用默认地址" value="${(s.customUrl || '').replace(/"/g, '&quot;')}">
    <div style="height:1px;background:#F0F0F0;margin:14px 0;"></div>
    <div style="font-size:13px;font-weight:700;color:var(--pink);margin-bottom:4px;">🎙️ 语音转写服务（音频文件转文字）</div>
    <div style="font-size:11px;color:#999;margin-bottom:8px;">外部导入的录音（如苹果语音备忘录）用此服务转写；需 Whisper 兼容接口</div>
    <label style="font-size:13px;font-weight:600;color:#333;display:block;margin:4px 0 6px;">转写服务商</label>
    <select class="input-field" id="asrProvider" onchange="updateAsrOptions()">
      <option value="openai" ${s.asrProvider !== 'custom' ? 'selected' : ''}>OpenAI Whisper</option>
      <option value="custom" ${s.asrProvider === 'custom' ? 'selected' : ''}>自定义兼容端点</option>
    </select>
    <label style="font-size:13px;font-weight:600;color:#333;display:block;margin:12px 0 6px;">转写 API Key</label>
    <input class="input-field" id="asrApiKey" type="password" placeholder="sk-..." value="${(s.asrApiKey || '').replace(/"/g, '&quot;')}">
    <div id="asrCustomBox" style="display:${s.asrProvider === 'custom' ? 'block' : 'none'};">
      <label style="font-size:13px;font-weight:600;color:#333;display:block;margin:12px 0 6px;">转写接口地址（自定义）</label>
      <input class="input-field" id="asrBaseUrl" placeholder="https://api.openai.com/v1" value="${(s.asrBaseUrl || '').replace(/"/g, '&quot;')}">
    </div>
    <label style="font-size:13px;font-weight:600;color:#333;display:block;margin:12px 0 6px;">转写模型</label>
    <input class="input-field" id="asrModel" placeholder="whisper-1" value="${(s.asrModel || 'whisper-1').replace(/"/g, '&quot;')}">
    <div style="background:#FFF5F8;padding:12px;border-radius:8px;margin:12px 0;">
      <b style="font-size:13px;">📌 说明</b><br>
      <span style="font-size:12px;color:#999;">若使用 OpenAI 官方 Key，可与上方分析 Key 相同（sk- 通用）。也支持阿里云百炼等 Whisper 兼容端点。</span>
    </div>
    <button class="btn btn-primary btn-full" onclick="saveAISettingsModal()">💾 保存设置</button>
  `;
  showModal(html);
  updateAIModelOptions();
  updateAsrOptions();
}

function updateAsrOptions() {
  const sel = document.getElementById('asrProvider');
  const box = document.getElementById('asrCustomBox');
  if (!sel || !box) return;
  box.style.display = sel.value === 'custom' ? 'block' : 'none';
}

function updateAIModelOptions() {
  const sel = document.getElementById('aiModel');
  if (!sel) return;
  const provider = document.getElementById('aiProvider').value;
  const models = (AI_CONFIG.providers[provider] && AI_CONFIG.providers[provider].models) || [];
  const cur = Store.get('aiSettings', {}).model;
  sel.innerHTML = models.map(m => `<option value="${m}" ${cur === m ? 'selected' : ''}>${m}</option>`).join('');
}

function saveAISettingsModal() {
  const provider = document.getElementById('aiProvider').value;
  const model = document.getElementById('aiModel').value;
  const apiKey = document.getElementById('aiApiKey').value.trim();
  const customUrl = document.getElementById('aiCustomUrl').value.trim();
  // ASR 转写配置（可留空，AI分析Key与转写Key可分别配置）
  const asrProvider = document.getElementById('asrProvider').value;
  const asrApiKey = document.getElementById('asrApiKey').value.trim();
  const asrBaseUrl = document.getElementById('asrBaseUrl').value.trim();
  const asrModel = document.getElementById('asrModel').value.trim() || 'whisper-1';
  if (!apiKey) { showToast('请填写API Key'); return; }
  saveAISettings({ provider, model, apiKey, customUrl, asrProvider, asrApiKey, asrBaseUrl, asrModel });
  closeModal();
  showToast('✅ AI设置已保存');
  const view = document.getElementById('view-settings');
  if (view) renderSettings(view);
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
