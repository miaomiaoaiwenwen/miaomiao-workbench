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

let exerciseCategory = '全身';

// ===== LocalStorage 管理 =====
let _backupTimer = null;
let _cloudSyncTimer = null;
let _lastAutoBackup = 0;      // 上次备份时间戳（节流用）
let _lastCloudSync = 0;       // 上次云同步时间戳（节流用）
const DATA_KEYS = ['tasks', 'completions', 'leaves', 'reminders', 'accounting', 'voiceOn', 'customers', 'consumption', 'voicePrefs', 'notes'];

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

// ===== 三道工作流（发现 / 分配 / 检查） =====
// 工作流状态存 localStorage（mm_workflow）
const WORKFLOW_KEY = 'workflow';
function getWorkflowState() {
  return Store.get(WORKFLOW_KEY, { lastDiscoverDate: '', lastAssignDate: '', lastCheckDate: '', tonightChecks: [] });
}
function setWorkflowState(s) { Store.set(WORKFLOW_KEY, s); }

// === 1. 发现工作 ===
// 每日首次触发 / 每小时扫描：到期未回访 + 已回访未出方案 → 弹窗提醒
async function runDailyDiscover(forceShow) {
  const today = todayKey();
  const state = getWorkflowState();
  if (!forceShow && state.lastDiscoverDate === today) return; // 今天已跑过
  const customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const todayStr = today;

  // 已到期未回访（priority=urgent 且 revisitDate<=今天 + 未完成）
  const dueCustomers = customers.filter(c =>
    !c.completed && c.priority === 'urgent' &&
    c.revisitDate && c.revisitDate <= todayStr
  );

  // 已回访但未出方案：今天有过 followup 但无 active project（待铺垫）
  const recentlyFollowedUp = customers.filter(c => {
    if (c.completed) return false;
    const todayF = (c.followups || []).filter(f => f.date === todayStr);
    if (todayF.length === 0) return false;
    const hasActiveProject = (c.projects || []).some(p => !p.completed);
    return !hasActiveProject;
  });

  if (dueCustomers.length > 0 || recentlyFollowedUp.length > 0) {
    showDiscoverAlert(dueCustomers, recentlyFollowedUp);
  }

  state.lastDiscoverDate = today;
  setWorkflowState(state);
}

// 发现弹窗
function showDiscoverAlert(dueList, noPlanList) {
  let body = '';
  if (dueList.length) {
    body += `<div style="background:#FFEBEE;border-radius:10px;padding:10px 12px;margin-bottom:10px;">
      <div style="font-size:12px;color:#C62828;font-weight:700;margin-bottom:6px;">⏰ ${dueList.length} 位紧急回访已到期</div>
      ${dueList.slice(0, 8).map(c => `<div style="font-size:12px;color:#333;padding:3px 0;cursor:pointer;" onclick="closeModal();showCustomerDetail('${c.id}')">· ${c.name} ${c.revisitDate ? '<span style="color:#C62828;font-size:11px;">(回访日 '+c.revisitDate+')</span>' : ''}</div>`).join('')}
    </div>`;
  }
  if (noPlanList.length) {
    body += `<div style="background:#FFF3E0;border-radius:10px;padding:10px 12px;margin-bottom:10px;">
      <div style="font-size:12px;color:#E65100;font-weight:700;margin-bottom:6px;">📋 ${noPlanList.length} 位今天跟进后尚未出方案</div>
      ${noPlanList.slice(0, 8).map(c => `<div style="font-size:12px;color:#333;padding:3px 0;cursor:pointer;" onclick="closeModal();showCustomerDetail('${c.id}')">· ${c.name}</div>`).join('')}
    </div>`;
  }
  body += `<button class="btn btn-primary btn-full" onclick="closeModal()">知道了</button>`;
  showModal(`<div class="modal-header"><div class="modal-title">🔍 发现工作 · 待办提醒</div><button class="modal-close" onclick="closeModal()">✕</button></div>${body}`);
}

// === 2. 分配工作 ===
// 根据顾客 priority 把"回访/发规划/邀约"等自动插入当日衍生任务（每天只生成一次）
async function autoGenerateDailyTasks() {
  const today = todayKey();
  const state = getWorkflowState();
  if (state.lastAssignDate === today) return;

  const customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const todayStr = today;

  // 按优先级生成衍生任务
  const generated = [];
  // 7天紧急：到期回访 / 到期未回访
  const urgentDue = customers.filter(c =>
    !c.completed && c.priority === 'urgent' && c.revisitDate && c.revisitDate <= todayStr
  );
  urgentDue.forEach(c => generated.push({ id: 'w_urgent_' + c.id, title: '紧急回访：' + c.name, desc: '约定回访日 '+c.revisitDate+' 已到，请尽快联系', icon: '⏰', timed: true, generated: true, customerId: c.id, autoComplete: false }));

  // 1个月：当日跟进 / 发规划
  const monthCust = customers.filter(c => !c.completed && c.priority === 'month');
  monthCust.slice(0, 5).forEach(c => generated.push({ id: 'w_month_' + c.id, title: '1月内跟进：' + c.name, desc: '保持月度触达，发规划/案例', icon: '📆', timed: true, generated: true, customerId: c.id, autoComplete: false }));

  // 长期：邀约回店
  const longCust = customers.filter(c => !c.completed && c.priority === 'long').slice(0, 3);
  longCust.forEach(c => generated.push({ id: 'w_long_' + c.id, title: '邀约回店：' + c.name, desc: '长期跟进顾客，尝试邀约', icon: '📨', timed: true, generated: true, customerId: c.id, autoComplete: false }));

  // 未出方案的：发规划提醒（取前 3）
  const noPlanCust = customers.filter(c => {
    if (c.completed) return false;
    const hasActiveProject = (c.projects || []).some(p => !p.completed);
    return !hasActiveProject && (c.followups || []).length > 0;
  }).slice(0, 3);
  noPlanCust.forEach(c => generated.push({ id: 'w_plan_' + c.id, title: '为 ' + c.name + ' 出方案', desc: '已沟通但未出方案，建议尽快生成变美规划', icon: '📋', timed: true, generated: true, customerId: c.id, autoComplete: false }));

  // 写入任务表（不覆盖用户已有任务）
  const tasks = Store.get('tasks', DEFAULT_TASKS);
  const existingIds = new Set(tasks.map(t => t.id));
  const newTasks = generated.filter(t => !existingIds.has(t.id));
  if (newTasks.length > 0) {
    tasks.push(...newTasks);
    Store.set('tasks', tasks);
  }

  state.lastAssignDate = today;
  setWorkflowState(state);
}

// === 3. 检查工作 ===
// 每日 21:00 触发晚检：核对当日回访/录音转写/备注补全 → 漏项标红
function scheduleEveningCheck() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(21, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const ms = target - now;
  setTimeout(() => {
    runEveningCheck();
    // 之后每天 21:00 触发
    setInterval(runEveningCheck, 24 * 60 * 60 * 1000);
  }

, ms);
}

async function runEveningCheck() {
  const today = todayKey();
  const state = getWorkflowState();
  if (state.lastCheckDate === today) return;

  const customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const todayStr = today;

  // 1. 当日回访缺失：priority=urgent 但 revisitDate<=今天 且 今天无 followup
  const missingFollowups = customers.filter(c =>
    !c.completed && c.priority === 'urgent' &&
    c.revisitDate && c.revisitDate <= todayStr &&
    !(c.followups || []).some(f => f.date === todayStr)
  );

  // 2. 当日回访但未补全备注（consultNotes 为空）
  const todayFollowed = customers.filter(c =>
    (c.followups || []).some(f => f.date === todayStr)
  );
  const noNotes = todayFollowed.filter(c => !c.consultNotes || !c.consultNotes.trim());

  // 3. 当日录音未完成转写（从 IndexedDB 查，但这里只能查元数据；改用提示"请确认录音已转写"）
  const audioPending = await countRecordingsNeedingTranscription();

  const checks = [];
  if (missingFollowups.length) {
    checks.push({ type: 'missingFollowup', label: `🚨 ${missingFollowups.length} 位紧急回访未跟进`, list: missingFollowups.map(c => c.name) });
  }
  if (noNotes.length) {
    checks.push({ type: 'noNotes', label: `📝 ${noNotes.length} 位今日跟进顾客未补全备注`, list: noNotes.map(c => c.name) });
  }
  if (audioPending > 0) {
    checks.push({ type: 'audioPending', label: `🎙️ ${audioPending} 条录音待转写`, count: audioPending });
  }

  state.lastCheckDate = today;
  state.tonightChecks = checks;
  setWorkflowState(state);

  // 自动弹窗提醒（除非已读）
  const dismissedKey = 'check_dismissed_' + today;
  if (checks.length > 0 && !sessionStorage.getItem(dismissedKey)) {
    showEveningCheckAlert(checks);
    sessionStorage.setItem(dismissedKey, '1');
  }

  // 重新渲染每日工作视图，标记漏项（红色）
  if (typeof renderDaily === 'function') {
    const dailyView = document.getElementById('view-daily');
    if (dailyView) renderDaily(dailyView);
  }
}

// 统计未完成转写的录音数
async function countRecordingsNeedingTranscription() {
  if (!window.indexedDB) return 0;
  try {
    const db = await AudioDB.open();
    return new Promise((resolve) => {
      const tx = db.transaction(AudioDB.store, 'readonly');
      const req = tx.objectStore(AudioDB.store).getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        const pending = all.filter(r => !r.transcript).length;
        resolve(pending);
      };
      req.onerror = () => resolve(0);
    });
  } catch (e) { return 0; }
}

// 晚检弹窗
function showEveningCheckAlert(checks) {
  let body = '';
  checks.forEach(c => {
    body += `<div style="background:#FFEBEE;border-radius:10px;padding:10px 12px;margin-bottom:10px;border-left:3px solid #F44336;">
      <div style="font-size:13px;color:#C62828;font-weight:700;">${c.label}</div>
      ${c.list && c.list.length ? `<div style="font-size:12px;color:#333;margin-top:4px;line-height:1.7;">${c.list.slice(0, 10).map(n => '· ' + n).join('<br>')}</div>` : ''}
    </div>`;
  });
  body += `<button class="btn btn-primary btn-full" onclick="closeModal()">知道了，明天补上</button>`;
  showModal(`<div class="modal-header"><div class="modal-title">🌙 检查工作 · 今日漏项</div><button class="modal-close" onclick="closeModal()">✕</button></div>${body}`);
}

// 读取今日晚检结果（用于每日工作页标红）
function getTonightChecks() {
  const state = getWorkflowState();
  return state.tonightChecks || [];
}

// ===== 初始化 =====
function init() {
  renderMenu();
  setupEvents();
  switchView('daily');
  checkReminders();
  // 启动时自动备份 + 检查备份状态
  autoBackup({ silent: true, isStartup: true });
  // 启动时从云端拉取数据
  initCloudSync();
  // 每分钟检查提醒
  setInterval(checkReminders, 60000);
  // 每5分钟自动备份一次（增量）
  setInterval(() => autoBackup({ silent: true, isIncremental: true }), 300000);
  // ===== 每日凌晨 3:00 全量备份（含录音Blob+转写） =====
  setInterval(checkDailyFullBackup, 60000);
  // ===== 三道工作流启动 =====
  // 发现工作：每日首次进入触发 + 整点扫描
  runDailyDiscover();
  setInterval(runDailyDiscover, 60 * 60 * 1000); // 每小时一次
  // 分配工作：进入每日工作视图时调用
  autoGenerateDailyTasks();
  // 检查工作：设置 21:00 定时晚检
  scheduleEveningCheck();
}

// 检查是否到凌晨3:00 → 触发全量备份（每日一次）
let _lastFullBackupDate = localStorage.getItem('mm_last_full_backup_date') || '';
function checkDailyFullBackup() {
  const now = new Date();
  const today = todayKey();
  if (now.getHours() === 3 && now.getMinutes() < 2 && _lastFullBackupDate !== today) {
    _lastFullBackupDate = today;
    localStorage.setItem('mm_last_full_backup_date', today);
    autoBackup({ silent: false, isFull: true, isScheduled: true });
  }
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
                                    case 'calendar': renderCalendar(view); break;
    case 'accounting': renderAccounting(view); break;
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

  // ===== 晚检漏项提醒（标红） =====
  const tonightChecks = getTonightChecks();
  if (tonightChecks.length > 0) {
    html += `<div style="background:#FFEBEE;border-radius:10px;padding:12px 14px;margin-bottom:12px;border:1px solid #FFCDD2;">
      <div style="font-size:13px;color:#C62828;font-weight:700;margin-bottom:6px;">🚨 今日晚检漏项（${tonightChecks.length}条）</div>
      ${tonightChecks.map(c => `<div style="font-size:12px;color:#5D4037;line-height:1.6;padding:2px 0;">${c.label}</div>
    `).join('')}
    </div>`;
  }

  // ===== 备份状态条（每日提醒） =====
  const backupTime = localStorage.getItem(BACKUP_TIME_KEY);
  if (backupTime) {
    const t = new Date(backupTime);
    const ago = Math.floor((Date.now() - t.getTime()) / 60000);
    const agoText = ago < 60 ? `${ago}分钟前` : ago < 1440 ? `${Math.floor(ago/60)}小时前` : `${Math.floor(ago/1440)}天前`;
    html += `<div class="backup-status-bar" onclick="showBackupHistoryModal()">
      <span class="bs-icon">☁️</span>
      <span class="bs-text">数据已备份（${agoText}）</span>
      <span class="bs-action">查看/回滚 ›</span>
    </div>`;
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
    <div class="quick-card quick-card-recording" onclick="showQuickRecordingModal()">
      <div class="quick-card-icon qc-recording">🎙️</div>
      <div class="quick-card-name">录音归档</div>
      <div class="quick-card-badge">面诊录音→AI复盘</div>
    </div>
    <div class="quick-card" onclick="switchView('consumption')">
      <div class="quick-card-icon qc-gold">💳</div>
      <div class="quick-card-name">成交记录</div>
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
    const dataMap = {};
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
    // 新字段默认空（兼容老数据，不影响已存信息）
    if (typeof c.consultNotes !== 'string') c.consultNotes = '';
    if (typeof c.casualNotes !== 'string') c.casualNotes = '';
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

  // 搜索过滤：标题 + 详细备注 + 联系方式（覆盖顾客姓、项目名/备注、跟进内容）
  let filtered = allActivities;
  if (keyword) {
    filtered = allActivities.filter(a =>
      a.customerName.toLowerCase().includes(keyword) ||
      (a.customerContact || '').toLowerCase().includes(keyword) ||
      (a.projectName || '').toLowerCase().includes(keyword) ||
      (a.summary || '').toLowerCase().includes(keyword) ||
      (a.detail || '').toLowerCase().includes(keyword)
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
          ${custConsumption.length > 0 ? `<div>消费 ${custConsumption.length}笔</div>` : ''}
        </div>
      </div>
    </div>
    <!-- 操作按钮 -->
    <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;">
      ${!c.completed ? `<button class="cust-action-btn" onclick="closeModal();showAddFollowup('${c.id}')">💬 记跟进</button>` : ''}
      ${!c.completed ? `<button class="cust-action-btn" onclick="closeModal();showAddProject('${c.id}')">📌 新增项目</button>` : ''}
      ${!c.completed ? `<button class="cust-action-btn" onclick="closeModal();showCustomerRecordings('${c.id}')">🎙️ 录音归档</button>` : ''}
      ${!c.completed ? `<button class="cust-action-btn success" onclick="toggleCustomerDone('${c.id}');setTimeout(closeModal,300)">✅ 完成成交</button>` : `<button class="cust-action-btn" onclick="toggleCustomerDone('${c.id}');setTimeout(closeModal,300)">↩️ 恢复跟进</button>`}
      ${custConsumption.length > 0 ? `<button class="cust-cross-link" onclick="closeModal();switchView('consumption');setTimeout(()=>{const el=document.getElementById('consumptionSearch');if(el){el.value='${c.name}';onConsumptionSearch('${c.name}');}},100)">💳 消费(${custConsumption.length})</button>` : ''}
    </div>
  `;

  // === 面诊痛点备注 + 客情随手记（AI 提取/手动维护） ===
  const hasConsult = c.consultNotes && c.consultNotes.trim();
  const hasCasual = c.casualNotes && c.casualNotes.trim();
  if (hasConsult || hasCasual) {
    html += `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">`;
    if (hasConsult) {
      html += `
        <div style="background:#FFF8E1;border-radius:10px;padding:10px 12px;border-left:3px solid var(--pink);">
          <div style="font-size:11px;color:var(--pink);font-weight:700;margin-bottom:4px;">🎯 面诊痛点备注</div>
          <div style="font-size:13px;line-height:1.6;color:#333;white-space:pre-wrap;">${(c.consultNotes||'').replace(/</g,'&lt;')}</div>
        </div>
      `;
    }
    if (hasCasual) {
      html += `
        <div style="background:#F3E5F5;border-radius:10px;padding:10px 12px;border-left:3px solid var(--lavender);">
          <div style="font-size:11px;color:var(--lavender);font-weight:700;margin-bottom:4px;">💬 客情随手记</div>
          <div style="font-size:13px;line-height:1.6;color:#333;white-space:pre-wrap;">${(c.casualNotes||'').replace(/</g,'&lt;')}</div>
        </div>
      `;
    }
    html += `</div>`;
  }

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
    <textarea class="input-field" id="custConsultNotes" placeholder="面诊痛点备注（如：口周凹陷、法令纹深、敏感肌）" rows="2"></textarea>
    <textarea class="input-field" id="custCasualNotes" placeholder="客情随手记（如：今天陪朋友来做水光、孩子刚高考完）" rows="2"></textarea>
    <input class="input-field" type="date" id="custRevisit" placeholder="约定回访时间">
    <div class="section-title">回访紧急等级</div>
    <div class="cust-priority-selector">
      <div class="cust-priority-opt urgent active" data-priority="urgent" onclick="selectPriority(this)">🔴 7天紧急</div>
      <div class="cust-priority-opt month" data-priority="month" onclick="selectPriority(this)">🟡 1个月</div>
      <div class="cust-priority-opt long" data-priority="long" onclick="selectPriority(this)">🩷 长期跟进</div>
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
  const consultNotes = document.getElementById('custConsultNotes').value.trim();
  const casualNotes = document.getElementById('custCasualNotes').value.trim();
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
    // 新字段：只在用户填写时才覆盖，不影响已有数据
    if (consultNotes) c.consultNotes = (c.consultNotes || '') ? (c.consultNotes + '\n' + consultNotes) : consultNotes;
    if (casualNotes) c.casualNotes = (c.casualNotes || '') ? (c.casualNotes + '\n' + casualNotes) : casualNotes;
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
      projects: [],
      consultNotes: consultNotes,
      casualNotes: casualNotes
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
    <textarea class="input-field" id="editCustConsultNotes" placeholder="面诊痛点备注" rows="3">${(c.consultNotes||'').replace(/</g,'&lt;')}</textarea>
    <textarea class="input-field" id="editCustCasualNotes" placeholder="客情随手记" rows="3">${(c.casualNotes||'').replace(/</g,'&lt;')}</textarea>
    <div class="section-title">回访紧急等级</div>
    <div class="cust-priority-selector">
      <div class="cust-priority-opt urgent ${c.priority==='urgent'?'active':''}" data-priority="urgent" onclick="selectPriority(this)">🔴 7天紧急</div>
      <div class="cust-priority-opt month ${c.priority==='month'?'active':''}" data-priority="month" onclick="selectPriority(this)">🟡 1个月</div>
      <div class="cust-priority-opt long ${c.priority==='long'?'active':''}" data-priority="long" onclick="selectPriority(this)">🩷 长期跟进</div>
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
  const consultNotes = document.getElementById('editCustConsultNotes').value;
  const casualNotes = document.getElementById('editCustCasualNotes').value;

  const customers = Store.get('customers', []);
  const idx = customers.findIndex(cu => cu.id === cid);
  if (idx < 0) return;
  customers[idx].name = name;
  customers[idx].contact = contact;
  customers[idx].revisitDate = revisitDate;
  customers[idx].priority = selectedPriority;
  customers[idx].consultNotes = consultNotes;
  customers[idx].casualNotes = casualNotes;
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

    // 备注
    if (r.notes) {
      html += `<div class="cons-detail-group"><div class="cons-detail-group-title">💬 备注</div><div style="font-size:13px;color:var(--text);padding:4px 0;">${r.notes}</div></div>`;
    }

    // 操作按钮
    html += `<div class="consumption-item-actions">`;
    html += `<button onclick="event.stopPropagation();showEditConsumption('${r.id}')">✏️ 编辑</button>`;
    if (hasFollowup) html += `<button onclick="event.stopPropagation();jumpToFollowup('${r.name.replace(/'/g, "\\'")}')">👥 跟进档案</button>`;
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
      <button class="btn btn-outline btn-full btn-sm" onclick="onInstantFullBackup()" style="margin-bottom:8px;">⏫ 立即全量备份（含录音）</button>
      <button class="btn btn-outline btn-full btn-sm" onclick="showBackupHistoryModal()" style="margin-bottom:8px;">📦 备份历史与按日期回滚</button>
      <button class="btn btn-outline btn-full btn-sm" onclick="pushBackupToGitHub()" style="margin-bottom:8px;">🔄 推送到 GitHub 归档</button>
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

async function exportData() {
  showToast('⏳ 正在打包数据（含录音文件）...');
  const data = {};
  DATA_KEYS.forEach(k => { data[k] = Store.get(k); });
  // 打包录音
  try {
    data._recordings = await collectRecordingsForBackup();
  } catch (e) {
    console.warn('export recordings failed:', e);
  }
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '妙妙工作台_全量备份_' + todayKey() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast(`✅ 已导出（${(json.length/1024).toFixed(1)}KB，含${data._recordings ? data._recordings.length : 0}条录音）`);
  speak('已导出');
}

// 从外部 JSON 导入时同时恢复录音
async function importRecordingsFromBackup(recordings) {
  if (!recordings || !Array.isArray(recordings) || recordings.length === 0) return 0;
  if (typeof AudioDB === 'undefined') return 0;
  let restored = 0;
  for (const r of recordings) {
    try {
      const blob = r.blobBase64 ? await base64ToBlob(r.blobBase64, r.mimeType || 'audio/m4a') : null;
      await AudioDB.save({
        id: r.id, customerId: r.customerId, fileName: r.fileName,
        mimeType: r.mimeType, size: r.size, createdAt: r.createdAt,
        transcript: r.transcript || '', transcriptAt: r.transcriptAt || 0,
        analysis: r.analysis || null, blob: blob
      });
      restored++;
    } catch (e) { console.warn('restore rec failed:', r.id, e); }
  }
  return restored;
}

// ===== 自动备份（双重存储：localStorage 当前态 + 按日期历史快照）=====
const BACKUP_KEY = 'mm_backup';
const BACKUP_TIME_KEY = 'mm_backup_time';
const BACKUP_HISTORY_INDEX_KEY = 'mm_backup_history_index';
const BACKUP_HISTORY_MAX = 30; // 保留最近30份快照

// Blob 转 base64（用于把录音 Blob 序列化进 JSON）
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) { resolve(''); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result || '';
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// 从 IndexedDB 导出所有录音元数据 + 转写文稿 + 分析结果（Blob 走 base64）
async function collectRecordingsForBackup() {
  if (typeof AudioDB === 'undefined' || !AudioDB.open) return [];
  try {
    const db = await AudioDB.open();
    return new Promise((resolve) => {
      const tx = db.transaction(AudioDB.store, 'readonly');
      const req = tx.objectStore(AudioDB.store).getAll();
      req.onsuccess = async () => {
        const recs = req.result || [];
        const out = [];
        for (const r of recs) {
          try {
            const b64 = await blobToBase64(r.blob);
            out.push({
              id: r.id,
              customerId: r.customerId,
              fileName: r.fileName,
              mimeType: r.mimeType,
              size: r.size,
              createdAt: r.createdAt,
              transcript: r.transcript || '',
              transcriptAt: r.transcriptAt || 0,
              analysis: r.analysis || null,
              blobBase64: b64
            });
          } catch (e) {
            // 单条失败不影响整体
            console.warn('backup recording failed:', r.id, e);
          }
        }
        resolve(out);
      };
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    console.warn('collectRecordingsForBackup failed:', e);
    return [];
  }
}

// 自动备份主函数
// opts: { silent?, isFull?, isIncremental?, isScheduled?, isStartup? }
async function autoBackup(opts = {}) {
  // 节流：距上次备份不足 60 秒则跳过（增量）
  const now = Date.now();
  if (!opts.isFull && !opts.isScheduled && now - _lastAutoBackup < 60000) return;
  _lastAutoBackup = now;
  try {
    const data = {};
    let hasData = false;
    DATA_KEYS.forEach(k => {
      data[k] = Store.get(k);
      if (data[k] !== null && data[k] !== undefined) hasData = true;
    });

    // 全量备份时把录音 Blob 一起打包（基线压缩：只取 base64 + 转写）
    if (opts.isFull || opts.isScheduled) {
      try {
        data._recordings = await collectRecordingsForBackup();
      } catch (e) {
        console.warn('录音备份失败:', e);
      }
    }

    if (hasData || data._recordings) {
      const json = JSON.stringify(data);
      const backupSize = json.length;

      // 1) 当前态备份（永远保留一份）
      try {
        localStorage.setItem(BACKUP_KEY, json);
        localStorage.setItem(BACKUP_TIME_KEY, new Date().toISOString());
      } catch (e) {
        // 配额超限：尝试只保留录音元数据 + 转写（去掉 blobBase64）
        if (data._recordings) {
          data._recordings = data._recordings.map(r => ({ ...r, blobBase64: '' }));
          const slim = JSON.stringify(data);
          try {
            localStorage.setItem(BACKUP_KEY, slim);
            localStorage.setItem(BACKUP_TIME_KEY, new Date().toISOString());
            if (!opts.silent) showToast('⚠️ 录音文件过大已跳过，仅备份元数据');
          } catch (e2) {
            if (!opts.silent) showToast('❌ 备份失败：' + (e2.message || '存储已满'));
            return;
          }
        } else {
          if (!opts.silent) showToast('❌ 备份失败：' + (e.message || '存储已满'));
          return;
        }
      }

      // 2) 历史快照（全量备份/定时备份才写历史快照，避免每5分钟写一堆）
      if (opts.isFull || opts.isScheduled) {
        const today = todayKey();
        const snapKey = 'mm_backup_snap_' + today;
        try {
          localStorage.setItem(snapKey, json);
          let index = [];
          try { index = JSON.parse(localStorage.getItem(BACKUP_HISTORY_INDEX_KEY) || '[]'); } catch (e) { index = []; }
          if (!index.includes(today)) {
            index.push(today);
            // 仅保留最近 N 份
            if (index.length > BACKUP_HISTORY_MAX) {
              const toRemove = index.splice(0, index.length - BACKUP_HISTORY_MAX);
              toRemove.forEach(d => { try { localStorage.removeItem('mm_backup_snap_' + d); } catch (e) {} });
            }
            localStorage.setItem(BACKUP_HISTORY_INDEX_KEY, JSON.stringify(index));
          }
        } catch (e) {
          console.warn('保存历史快照失败:', e);
        }
        // 凌晨全量备份 → 弹 Toast 报告
        if (opts.isScheduled && !opts.silent) {
          showToast(`🌙 凌晨全量备份完成（${(backupSize/1024).toFixed(1)}KB，含${data._recordings ? data._recordings.length : 0}条录音）`);
        }
      } else if (!opts.silent && !opts.isStartup) {
        // 增量备份反馈
        showToast(`☁️ 已增量备份（${(backupSize/1024).toFixed(1)}KB）`);
      }
    }
  } catch(e) {
    console.warn('Auto backup failed:', e);
    if (!opts.silent) showToast('❌ 备份失败：' + (e.message || '未知错误'));
  }
}

// 主动强制全量备份（用户点"立即备份"按钮时）
async function onInstantFullBackup() {
  showToast('⏳ 正在执行全量备份...');
  await autoBackup({ silent: true, isFull: true });
  showToast('✅ 全量备份完成（含录音Blob+转写文稿）');
  speak('全量备份完成');
}

// 按日期回滚：用户选择历史日期 → 恢复该日期快照
function showBackupHistoryModal() {
  let index = [];
  try { index = JSON.parse(localStorage.getItem(BACKUP_HISTORY_INDEX_KEY) || '[]'); } catch (e) { index = []; }
  if (index.length === 0) {
    showConfirm('📦 暂无历史快照', '执行全量备份', async () => {
      await autoBackup({ silent: true, isFull: true });
      setTimeout(() => showBackupHistoryModal(), 500);
    });
    return;
  }
  const items = index.slice().reverse().map(date => {
    let size = 0;
    try { size = (localStorage.getItem('mm_backup_snap_' + date) || '').length; } catch (e) {}
    return `<div class="history-item" onclick="confirmRollback('${date}')">
      <div class="history-date">📅 ${date}</div>
      <div class="history-size">${(size/1024).toFixed(1)}KB</div>
    </div>`;
  }).join('');
  const html = `
    <div class="modal-header">
      <div class="modal-title">📦 备份历史快照</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-light);margin-bottom:10px;">
      点击日期可回滚到该日的备份（恢复会覆盖当前数据，请谨慎）
    </div>
    <div class="history-list">${items}</div>
    <button class="btn btn-primary btn-full" style="margin-top:14px;" onclick="onInstantFullBackup();setTimeout(closeModal, 200);">⏫ 立即创建全量备份</button>
  `;
  showModal(html);
}

function confirmRollback(date) {
  showConfirm(`⚠️ 确认回滚到 ${date} 的备份？\n当前数据将被覆盖`, '确认回滚', async () => {
    const snapKey = 'mm_backup_snap_' + date;
    const snap = localStorage.getItem(snapKey);
    if (!snap) { showToast('快照不存在'); return; }
    try {
      const data = JSON.parse(snap);
      let restored = 0;
      DATA_KEYS.forEach(k => {
        if (data[k] !== null && data[k] !== undefined) {
          Store.set(k, data[k]);
          restored++;
        }
      });
      // 恢复录音（含 Blob）
      if (data._recordings && Array.isArray(data._recordings) && typeof AudioDB !== 'undefined') {
        for (const r of data._recordings) {
          try {
            const blob = r.blobBase64 ? await base64ToBlob(r.blobBase64, r.mimeType || 'audio/m4a') : null;
            const rec = {
              id: r.id, customerId: r.customerId, fileName: r.fileName,
              mimeType: r.mimeType, size: r.size, createdAt: r.createdAt,
              transcript: r.transcript || '', transcriptAt: r.transcriptAt || 0,
              analysis: r.analysis || null, blob: blob
            };
            await AudioDB.save(rec);
          } catch (e) { console.warn('restore rec failed:', r.id, e); }
        }
      }
      showToast(`✅ 已回滚到 ${date}（恢复 ${restored} 项数据）`);
      speak('数据已回滚');
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      showToast('回滚失败：' + (e.message || '快照损坏'));
    }
  });
}

// base64 → Blob（回滚时把录音还原回 IndexedDB）
function base64ToBlob(b64, mime) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch (e) {
    return null;
  }
}

// 手动推送到 GitHub 归档分支（可选，需在 AI 设置中配置 token）
async function pushBackupToGitHub() {
  const settings = getAISettings();
  const token = settings.githubToken;
  if (!token) {
    showConfirm('🔑 推送 GitHub 归档需要 Token', '去配置', () => {
      closeModal();
      showAISettingsModal();
    });
    return;
  }
  const json = localStorage.getItem(BACKUP_KEY);
  if (!json) { showToast('暂无备份数据'); return; }
  const today = todayKey();
  const branchName = 'archive-' + today;
  const path = 'backups/' + today + '.json';
  showToast('⏳ 正在推送到 GitHub...');
  try {
    // 1. 检查/创建分支
    const repo = settings.githubRepo || 'miaomiaoaiwenwen/miaomiao-workbench';
    const [owner, repoName] = repo.split('/');
    const apiBase = 'https://api.github.com/repos/' + owner + '/' + repoName;
    const headers = { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' };
    let branchExists = false;
    try {
      const br = await fetch(`${apiBase}/branches/${branchName}`, { headers });
      if (br.ok) branchExists = true;
    } catch (e) {}

    if (!branchExists) {
      // 取主分支 SHA
      const mainRef = await fetch(`${apiBase}/git/ref/heads/main`, { headers });
      if (!mainRef.ok) throw new Error('获取主分支失败');
      const mainRefData = await mainRef.json();
      // 创建新分支
      const create = await fetch(`${apiBase}/git/refs`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainRefData.object.sha })
      });
      if (!create.ok) throw new Error('创建分支失败');
    }

    // 2. 上传文件到新分支（用 Contents API）
    const content = btoa(unescape(encodeURIComponent(json)));
    const upload = await fetch(`${apiBase}/contents/${path}?ref=${branchName}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `backup: ${today}`, branch: branchName, content })
    });
    if (!upload.ok) throw new Error('推送失败: ' + upload.status);
    const result = await upload.json();
    showToast(`✅ 已推送到 ${branchName}/${path}`);
    speak('备份已同步到 GitHub');
    return result;
  } catch (e) {
    console.error(e);
    showToast('❌ 推送失败：' + (e.message || '未知错误'));
  }
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

async function restoreFromBackup() {
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
    let recCount = 0;
    if (data._recordings && data._recordings.length > 0) {
      recCount = await importRecordingsFromBackup(data._recordings);
    }
    const tip = recCount > 0 ? `✅ 已恢复 ${restored} 项数据 + ${recCount} 条录音` : `✅ 已从备份恢复 ${restored} 项数据`;
    showToast(tip);
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
        // 录音恢复（异步执行，不阻塞UI）
        if (data._recordings && data._recordings.length > 0) {
          importRecordingsFromBackup(data._recordings).then(recCount => {
            if (recCount > 0) showToast(`✅ 已导入 ${restored} 项数据 + ${recCount} 条录音`);
          });
        }
        autoBackup({ silent: true }); // 立即备份
        showToast(`✅ 成功导入 ${restored} 项数据`);
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
// voices 缓存 + 一次性 voiceschanged 监听
// 解决 Chrome/Safari 首次 getVoices() 返回空数组的问题
let voices = [];
let voicesReady = false;
let voicesTried = 0; // 重试次数，避免无限重试
function loadVoices() {
  if (!window.speechSynthesis) return;
  voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    voicesReady = true;
  }
}
// 一次性绑定 voiceschanged 监听（多次绑定会重复触发）
if (window.speechSynthesis) {
  loadVoices();
  try { window.speechSynthesis.onvoiceschanged = loadVoices; } catch (e) {}
}

// 判断当前环境是否支持中文语音讲解（用于决定是否隐藏【听讲解】按钮）
function isSpeechAvailable() {
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return false;
  if (voicesReady && voices.length === 0) return false;
  // voicesReady=false 时不确定，按"可用"处理，等真正 speak 时再判断
  return true;
}

// 选择最佳中文音色（优先匹配用户预设的性别）
function pickChineseVoice(preset) {
  if (!voicesReady) voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  if (voices.length === 0) return null;
  const zhVoices = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('zh'));
  if (zhVoices.length === 0) return null;
  if (!preset) return zhVoices[0];
  const femaleHints = ['female', 'tingting', 'xiaoxiao', 'yaoyao', 'hui', 'mei', '女', '婷婷', '晓晓', '瑶瑶', '美', '慧', '小美', 'Yating', 'Hanhan', 'Zhiyu'];
  const maleHints = ['male', 'kangkang', 'yunyang', '男', '云扬', '康康', '云希', '云野'];
  const hints = preset.gender === 'female' ? femaleHints : maleHints;
  const match = zhVoices.find(v => hints.some(h => v.name.toLowerCase().includes(h.toLowerCase())));
  return match || zhVoices[0];
}

function speak(text, rate, volume, pitch) {
  if (!text) return;
  if (!Store.get('voiceOn', true)) return; // 用户关闭了语音播报
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    showToast('该内容暂不支持语音讲解');
    return;
  }
  // 尝试触发一次 cancel（容错）
  try { window.speechSynthesis.cancel(); } catch (e) {}

  const prefs = Store.get('voicePrefs', { presetId: 'v_female_elegant', rate: 0.85, volume: 1.0 });
  const preset = typeof VOICE_PRESETS !== 'undefined'
    ? (VOICE_PRESETS.find(p => p.id === prefs.presetId) || (VOICE_PRESETS[6] || VOICE_PRESETS[0] || null))
    : null;

  const u = new SpeechSynthesisUtterance(String(text));
  u.lang = 'zh-CN';
  u.rate = rate || (preset ? preset.rate : 0.85);
  u.pitch = pitch || (preset ? preset.pitch : 1.1);
  u.volume = volume != null ? volume : (preset ? preset.volume : 1.0);

  // 选择音色（若 voices 还没加载完，延迟重试）
  const attachVoiceAndSpeak = () => {
    const v = pickChineseVoice(preset);
    if (v) {
      u.voice = v;
    } else if (voicesReady && voices.length === 0) {
      // 真正确认无任何音色
      showToast('该内容暂不支持语音讲解');
      return;
    }
    // onstart / onend / onerror 反馈
    u.onstart = () => {
      const hint = document.getElementById('voiceHint');
      if (hint) { hint.textContent = '🔊 播放中'; hint.style.display = 'block'; }
    };
    u.onend = () => {
      const hint = document.getElementById('voiceHint');
      if (hint) hint.style.display = 'none';
    };
    u.onerror = (e) => {
      const hint = document.getElementById('voiceHint');
      if (hint) hint.style.display = 'none';
      // canceled/interrupted 是 cancel() 主动触发，不算错误
      if (e && e.error && e.error !== 'canceled' && e.error !== 'interrupted') {
        console.warn('语音播报错误:', e.error);
        showToast('该内容暂不支持语音讲解');
      }
    };
    try {
      window.speechSynthesis.speak(u);
    } catch (err) {
      console.warn('speak 抛出异常:', err);
      showToast('该内容暂不支持语音讲解');
    }
  };

  if (!voicesReady) {
    // 再取一次（部分浏览器首次即可拿到）
    loadVoices();
    if (voices.length === 0) {
      // 等一会再试，最多 3 次（约 1.5s）
      voicesTried++;
      if (voicesTried <= 3) {
        setTimeout(attachVoiceAndSpeak, voicesTried * 500);
        showToast('🔇 正在加载语音引擎，请稍候');
        return;
      }
      showToast('该内容暂不支持语音讲解');
      return;
    }
    voicesReady = true;
  }
  attachVoiceAndSpeak();
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

// ===== 录音归档（绑定顾客 + AI 智能分析）=====
const AudioDB = {
  dbName: 'mm_audio',
  store: 'recordings',
  _db: null,

  // 打开/初始化 IndexedDB
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.store)) {
          const os = db.createObjectStore(this.store, { keyPath: 'id' });
          os.createIndex('customerId', 'customerId', { unique: false });
          os.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },

  // 保存录音 blob（支持大文件）
  async save(rec) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, 'readwrite');
      tx.objectStore(this.store).put(rec);
      tx.oncomplete = () => resolve(rec.id);
      tx.onerror = () => reject(tx.error);
    });
  },

  // 获取某顾客的所有录音
  async listByCustomer(customerId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, 'readonly');
      const idx = tx.objectStore(this.store).index('customerId');
      const req = idx.getAll(IDBKeyRange.only(customerId));
      req.onsuccess = () => {
        const arr = (req.result || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(arr);
      };
      req.onerror = () => reject(req.error);
    });
  },

  // 删除单条录音
  async remove(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, 'readwrite');
      tx.objectStore(this.store).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  // 获取单条录音（含 blob）
  async get(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, 'readonly');
      const req = tx.objectStore(this.store).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
};

// 上传录音文件到指定顾客
async function uploadCustomerRecording(customerId, file) {
  if (!file) return;
  if (!/^audio\//.test(file.type) && !/\.(m4a|mp3|wav|mp4|aac|ogg|webm)$/i.test(file.name)) {
    showToast('请上传音频文件（m4a/mp3/wav）');
    return;
  }
  const id = 'r' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    customerId,
    fileName: file.name,
    mimeType: file.type || 'audio/m4a',
    size: file.size,
    blob: file,
    createdAt: Date.now(),
    transcript: '',
    analysis: null
  };
  try {
    await AudioDB.save(rec);
    showToast('✅ 录音已上传');
    await refreshCustomerRecordings(customerId);
    // 自动触发转写
    transcribeCustomerRecording(customerId, id);
  } catch (e) {
    console.error('上传失败', e);
    showToast('上传失败：' + (e.message || '未知错误'));
  }
}

// 首页录音快捷入口：选择顾客→上传→自动转写+AI复盘
function showQuickRecordingModal() {
  const customers = (Store.get('customers', []) || [])
    .filter(c => !c.completed)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
  window._quickRecCustomers = customers;
  window._quickRecSelectedId = '';
  const html = `
    <div class="modal-header">
      <div class="modal-title">🎙️ 录音归档（首页入口）</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="recording-tips" style="background:var(--lavender-light);padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.7;margin-bottom:12px;">
      💡 上传录音后将自动转写→AI复盘→关键痛点自动写入顾客「面诊痛点备注」字段
    </div>
    <div class="section-title" style="font-size:13px;">1️⃣ 选择顾客档案</div>
    <div class="customer-selector" id="quickRecCustomerSelector">
      <div class="cs-trigger" id="quickRecTrigger" onclick="toggleQuickRecPanel()">
        <span class="cs-trigger-icon">👤</span>
        <span class="cs-trigger-text" id="quickRecTriggerText">— 请选择顾客 —</span>
        <span class="cs-trigger-arrow">▼</span>
      </div>
      <div class="cs-panel" id="quickRecPanel" style="display:none;">
        <div class="cs-search-wrap">
          <input class="cs-search-input" id="quickRecSearch" type="text" placeholder="🔍 输入姓名/手机号快速检索" oninput="filterQuickRecList(this.value)">
        </div>
        <div class="cs-list" id="quickRecList">
          ${renderQuickRecList(customers)}
        </div>
        <div class="cs-empty" id="quickRecEmpty" style="display:none;">未找到匹配的顾客</div>
      </div>
    </div>
    <div id="quickRecCustomerHint" style="font-size:12px;color:var(--text-light);margin:8px 0 12px 0;display:none;"></div>
    <div class="section-title" style="font-size:13px;">2️⃣ 选择录音文件</div>
    <input type="file" id="quickRecFile" accept="audio/*,.m4a,.mp3,.wav,.mp4,.aac" style="margin-bottom:12px;">
    <div id="quickRecFileInfo" style="font-size:12px;color:var(--text-light);display:none;margin-bottom:12px;"></div>
    <button class="btn btn-primary btn-full" id="quickRecUploadBtn" onclick="doQuickRecordingUpload()">📤 上传并自动复盘</button>
    <button class="btn btn-outline btn-full" style="margin-top:8px;" onclick="closeModal();switchView('customers');">👥 先去顾客跟进选档案</button>
  `;
  showModal(html);

  // 绑定文件选择显示
  setTimeout(() => {
    const fileInput = document.getElementById('quickRecFile');
    if (fileInput) {
      fileInput.onchange = function() {
        const f = this.files[0];
        const info = document.getElementById('quickRecFileInfo');
        if (f) {
          info.style.display = 'block';
          info.innerHTML = `📎 ${f.name}（${(f.size/1024).toFixed(1)} KB）`;
        } else {
          info.style.display = 'none';
        }
      };
    }
    // 外部点击关闭面板
    setTimeout(() => {
      document.addEventListener('click', onClickOutsideQuickRecPanel, true);
    }, 100);
  }, 50);
}

// 顾客列表项 HTML 生成
function renderQuickRecList(customers) {
  if (!customers || customers.length === 0) {
    return '<div class="cs-list-empty">暂无未完成顾客</div>';
  }
  return customers.map(c => {
    const initials = (c.name || '?').slice(0, 1).toUpperCase();
    const priorityClass = c.priority === 'urgent' ? 'cs-prio-urgent' : (c.priority === 'month' ? 'cs-prio-month' : 'cs-prio-long');
    const priorityText = c.priority === 'urgent' ? '🔴7天' : (c.priority === 'month' ? '🟡1月' : '🩷长期');
    const lastFollowup = c.entries && c.entries.length > 0 ? c.entries[c.entries.length - 1].date : (c.revisitDate || '');
    return `
      <div class="cs-item" data-cid="${c.id}" onclick="pickQuickRecCustomer('${c.id}')">
        <div class="cs-avatar ${priorityClass}">${initials}</div>
        <div class="cs-info">
          <div class="cs-name">${escapeHtml(c.name)}${c.contact ? ' <span class="cs-contact">' + escapeHtml(c.contact) + '</span>' : ''}</div>
          <div class="cs-meta">
            <span class="cs-prio-tag ${priorityClass}">${priorityText}</span>
            ${lastFollowup ? '<span class="cs-date">' + escapeHtml(lastFollowup) + '</span>' : ''}
            ${c.consultNotes ? '<span class="cs-tag-note">有痛点备注</span>' : ''}
          </div>
        </div>
        <span class="cs-check">✓</span>
      </div>
    `;
  }).join('');
}

function pickQuickRecCustomer(cid) {
  const c = (window._quickRecCustomers || []).find(x => x.id === cid);
  if (!c) return;
  window._quickRecSelectedId = cid;
  // 回显触发按钮
  const text = document.getElementById('quickRecTriggerText');
  if (text) {
    text.innerHTML = `<b>${escapeHtml(c.name)}</b>${c.contact ? ' <span style="color:var(--text-light);font-weight:400;">· ' + escapeHtml(c.contact) + '</span>' : ''}`;
  }
  // 关闭面板
  toggleQuickRecPanel(false);
  // 显示痛点备注提示
  const hint = document.getElementById('quickRecCustomerHint');
  if (hint) {
    if (c.consultNotes) {
      hint.style.display = 'block';
      const snippet = c.consultNotes.length > 80 ? c.consultNotes.slice(0, 80) + '...' : c.consultNotes;
      hint.innerHTML = `📝 已有痛点备注：<span style="color:var(--text-light);">${escapeHtml(snippet)}</span>`;
    } else {
      hint.style.display = 'none';
    }
  }
  // 标记选中
  document.querySelectorAll('.cs-item').forEach(el => {
    el.classList.toggle('cs-item-selected', el.dataset.cid === cid);
  });
}

function toggleQuickRecPanel(force) {
  const panel = document.getElementById('quickRecPanel');
  const wrap = document.getElementById('quickRecCustomerSelector');
  if (!panel) return;
  const show = typeof force === 'boolean' ? force : (panel.style.display === 'none');
  panel.style.display = show ? 'block' : 'none';
  if (wrap) wrap.classList.toggle('cs-open', show);
  if (show) {
    const search = document.getElementById('quickRecSearch');
    if (search) {
      search.value = '';
      filterQuickRecList('');
      setTimeout(() => search.focus(), 50);
    }
  }
}

function filterQuickRecList(keyword) {
  const list = document.getElementById('quickRecList');
  const empty = document.getElementById('quickRecEmpty');
  if (!list) return;
  const kw = (keyword || '').trim().toLowerCase();
  const all = window._quickRecCustomers || [];
  const matched = !kw
    ? all
    : all.filter(c =>
        (c.name || '').toLowerCase().includes(kw) ||
        (c.contact || '').toLowerCase().includes(kw) ||
        ((c.projects || []).some(p => (p.name || '').toLowerCase().includes(kw)))
      );
  list.innerHTML = renderQuickRecList(matched);
  if (empty) empty.style.display = matched.length === 0 ? 'block' : 'none';
}

function onClickOutsideQuickRecPanel(e) {
  const wrap = document.getElementById('quickRecCustomerSelector');
  if (!wrap) return;
  if (!wrap.contains(e.target)) {
    const panel = document.getElementById('quickRecPanel');
    if (panel && panel.style.display !== 'none') toggleQuickRecPanel(false);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function doQuickRecordingUpload() {
  const cid = window._quickRecSelectedId;
  const file = document.getElementById('quickRecFile').files[0];
  if (!cid) { showToast('请先选择顾客档案'); toggleQuickRecPanel(true); return; }
  if (!file) { showToast('请选择录音文件'); return; }
  // 校验 API Key
  const settings = getAISettings();
  if (!settings.apiKey && !settings.asrApiKey) {
    showConfirm('⚙️ 录音转写需要先配置 AI Key', '去设置', () => {
      closeModal();
      showAISettingsModal();
    });
    return;
  }
  const btn = document.getElementById('quickRecUploadBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 上传中...';
  try {
    await uploadCustomerRecording(cid, file);
    closeModal();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '📤 上传并自动复盘';
  }
}

// 转写单条录音
async function transcribeCustomerRecording(customerId, recId) {
  const rec = await AudioDB.get(recId);
  if (!rec) return;
  const settings = getAISettings();
  const asrKey = settings.asrApiKey || settings.apiKey;
  if (!asrKey) {
    showToast('请先在 AI 设置中配置转写 Key');
    return;
  }
  const asrBase = settings.asrProvider === 'custom'
    ? (settings.asrBaseUrl || 'https://api.openai.com/v1')
    : 'https://api.openai.com/v1';
  const asrModel = settings.asrModel || 'whisper-1';

  showToast('🎙️ 正在转写录音...');
  try {
    const formData = new FormData();
    formData.append('file', rec.blob, rec.fileName || 'recording.m4a');
    formData.append('model', asrModel);
    formData.append('language', 'zh');
    formData.append('response_format', 'verbose_json');
    // 注入美业关键词作为 prompt 上下文，引导 Whisper 精准识别医美词汇
    if (typeof ASR_PROMPT_PREFIX !== 'undefined') {
      formData.append('prompt', ASR_PROMPT_PREFIX);
    }

    const res = await fetch(`${asrBase}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${asrKey}` },
      body: formData
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`转写失败(${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    rec.transcript = (data.text || '').trim();
    rec.transcriptAt = Date.now();
    rec.transcriptRaw = data;
    await AudioDB.save(rec);
    showToast('✅ 转写完成，正在做 AI 分析...');
    await refreshCustomerRecordings(customerId);
    // 自动触发 AI 分析
    analyzeCustomerRecording(customerId, recId);
  } catch (e) {
    console.error(e);
    showToast('转写失败：' + (e.message || '未知错误'));
    await refreshCustomerRecordings(customerId);
  }
}

// AI 分析单条录音
async function analyzeCustomerRecording(customerId, recId) {
  const rec = await AudioDB.get(recId);
  if (!rec || !rec.transcript) {
    showToast('请先完成转写');
    return;
  }
  showToast('🤖 正在进行 AI 智能分析...');
  const r = await callAIAPI(rec.transcript);
  if (!r.ok) {
    showToast('AI 分析失败：' + (r.reason || '未知错误'));
    return;
  }
  rec.analysis = r.data;
  rec.analyzedAt = Date.now();
  await AudioDB.save(rec);

  // 自动同步关键字段到对应顾客档案
  const customers = Store.get('customers', []);
  const idx = customers.findIndex(c => c.id === customerId);
  if (idx >= 0) {
    const c = customers[idx];
    const a = r.data;
    const parts = [];
    if (a.customerBasics?.facialPainPoints && a.customerBasics.facialPainPoints !== '未提及') {
      parts.push(`面部痛点：${a.customerBasics.facialPainPoints}`);
    }
    if (a.interestedProjects && a.interestedProjects.length) {
      parts.push(`在意项目：${a.interestedProjects.join('、')}`);
    }
    if (a.visitIntent?.evidence && a.visitIntent.evidence !== '未提及') {
      parts.push(`到店意向：${a.visitIntent.level || ''}（${a.visitIntent.evidence}）`);
    }
    if (parts.length) {
      const stamp = formatDate(new Date());
      const newLine = `[${stamp} AI提取] ${parts.join(' | ')}`;
      c.consultNotes = c.consultNotes ? (c.consultNotes + '\n' + newLine) : newLine;
      Store.set('customers', customers);
    }
  }

  showToast('✅ AI 分析完成，已同步到顾客面诊痛点');
  await refreshCustomerRecordings(customerId);
}

// 删除录音
async function deleteCustomerRecording(customerId, recId) {
  if (!confirm('确定删除这条录音吗？')) return;
  try {
    await AudioDB.remove(recId);
    showToast('已删除');
    await refreshCustomerRecordings(customerId);
  } catch (e) {
    showToast('删除失败');
  }
}

// 显示顾客录音归档弹窗
async function showCustomerRecordings(customerId) {
  const customers = Store.get('customers', []);
  customers = migrateCustomers(customers);
  const c = customers.find(cu => cu.id === customerId);
  if (!c) return;

  let recordings = [];
  try { recordings = await AudioDB.listByCustomer(customerId); }
  catch (e) { recordings = []; }

  const html = `
    <div class="modal-header">
      <div class="modal-title">🎙️ ${c.name} · 面诊录音归档</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="background:#FFF5F8;border-radius:10px;padding:10px 12px;font-size:12px;color:#666;margin-bottom:12px;">
      📌 上传面诊录音 → 自动转文字 → AI 智能分析（提取面部痛点/在意项目/到店意向，自动同步到顾客面诊痛点备注）<br>
      💡 支持 m4a/mp3/wav；需在 AI 设置中配置转写 API Key
      ${(!getAISettings().asrApiKey && !getAISettings().apiKey) ? '<br><a style="color:var(--pink);" onclick="closeModal();showAISettingsModal()">👉 点此配置转写 Key</a>' : ''}
    </div>
    <div style="display:flex;gap:6px;margin-bottom:12px;">
      <label class="btn btn-primary" style="flex:1;text-align:center;">
        📤 上传录音
        <input type="file" accept="audio/*,.m4a,.mp3,.wav" style="display:none;" onchange="uploadCustomerRecording('${customerId}', this.files[0]);this.value='';">
      </label>
      <button class="btn btn-outline" onclick="closeModal();showCustomerDetail('${customerId}')">↩️ 返回档案</button>
    </div>
    <div id="customerRecordingsList">${renderRecordingsList(recordings, customerId)}</div>
  `;
  showModal(html);
}

function renderRecordingsList(recordings, customerId) {
  if (!recordings.length) {
    return `<div style="text-align:center;padding:30px;color:#999;font-size:13px;">📂 暂无录音，点击上方"上传录音"添加</div>`;
  }
  let html = '';
  recordings.forEach(r => {
    const dateStr = new Date(r.createdAt).toLocaleString('zh-CN');
    const hasTranscript = !!r.transcript;
    const hasAnalysis = !!r.analysis;
    let status = '⏳ 待转写';
    let statusColor = '#999';
    if (hasAnalysis) { status = '✅ 已 AI 分析'; statusColor = '#388E3C'; }
    else if (hasTranscript) { status = '🔄 转写完成，分析中'; statusColor = '#E65100'; }

    html += `
      <div style="background:#fff;border-radius:10px;padding:12px;margin-bottom:8px;border:1px solid #F0F0F0;">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#333;">🎙️ ${(r.fileName || '录音').slice(0, 30)}</div>
            <div style="font-size:11px;color:#999;margin-top:2px;">📅 ${dateStr} · ${(r.size/1024).toFixed(1)}KB</div>
            <div style="font-size:11px;color:${statusColor};margin-top:4px;font-weight:600;">${status}</div>
          </div>
          <button style="background:none;border:none;color:#999;font-size:18px;cursor:pointer;" onclick="deleteCustomerRecording('${customerId}','${r.id}')">✕</button>
        </div>
        ${hasTranscript ? `
          <details style="margin-top:8px;">
            <summary style="font-size:12px;color:var(--pink);cursor:pointer;font-weight:600;">📝 查看转写文本（${r.transcript.length}字）</summary>
            <div style="background:#F8F8F8;border-radius:6px;padding:8px;margin-top:6px;font-size:12px;line-height:1.6;max-height:200px;overflow-y:auto;">${r.transcript.replace(/</g,'&lt;')}</div>
          </details>
        ` : (!getAISettings().asrApiKey && !getAISettings().apiKey) ? '' : `<button class="btn btn-sm btn-outline" style="margin-top:8px;" onclick="transcribeCustomerRecording('${customerId}','${r.id}')">🎙️ 开始转写</button>`}

        ${hasAnalysis ? renderAnalysisPreview(r.analysis) : (hasTranscript ? `<button class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="analyzeCustomerRecording('${customerId}','${r.id}')">🤖 AI 智能分析</button>` : '')}
      </div>
    `;
  });
  return html;
}

// 渲染 AI 分析预览（自我复盘 + 优化话术 + 关联项目）
function renderAnalysisPreview(a) {
  let html = `<details style="margin-top:8px;"><summary style="font-size:12px;color:var(--pink);cursor:pointer;font-weight:600;">🤖 AI 分析结果</summary><div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">`;

  // 基础信息
  if (a.customerBasics?.facialPainPoints && a.customerBasics.facialPainPoints !== '未提及') {
    html += `<div style="background:#FFF8E1;border-radius:8px;padding:8px 10px;">
      <div style="font-size:11px;color:var(--pink);font-weight:700;">🎯 面部痛点</div>
      <div style="font-size:12px;margin-top:2px;">${(a.customerBasics.facialPainPoints||'').replace(/</g,'&lt;')}</div>
    </div>`;
  }
  if (a.interestedProjects && a.interestedProjects.length) {
    html += `<div style="background:#E3F2FD;border-radius:8px;padding:8px 10px;">
      <div style="font-size:11px;color:#1976D2;font-weight:700;">💎 在意项目</div>
      <div style="font-size:12px;margin-top:2px;">${a.interestedProjects.join('、')}</div>
    </div>`;
  }
  if (a.visitIntent) {
    html += `<div style="background:#F3E5F5;border-radius:8px;padding:8px 10px;">
      <div style="font-size:11px;color:#7B1FA2;font-weight:700;">📅 到店意向：${a.visitIntent.level||'-'}</div>
      <div style="font-size:12px;margin-top:2px;">${(a.visitIntent.evidence||'').replace(/</g,'&lt;')}</div>
      ${a.visitIntent.expectedVisitWindow && a.visitIntent.expectedVisitWindow !== '未提及' ? `<div style="font-size:11px;color:#999;margin-top:2px;">预计：${a.visitIntent.expectedVisitWindow}</div>` : ''}
    </div>`;
  }

  // 自我复盘
  if (a.selfReview) {
    if (a.selfReview.empathyHits && a.selfReview.empathyHits.length) {
      html += `<div style="background:#E8F5E9;border-radius:8px;padding:8px 10px;">
        <div style="font-size:11px;color:#388E3C;font-weight:700;">💚 共情到位的语句（${a.selfReview.empathyHits.length}）</div>
        ${a.selfReview.empathyHits.slice(0,3).map(h => `<div style="font-size:12px;margin-top:4px;line-height:1.6;">·「${(h.quote||'').replace(/</g,'&lt;')}」<br><span style="color:#666;font-size:11px;">${(h.why||'').replace(/</g,'&lt;')}</span></div>`).join('')}
      </div>`;
    }
    if (a.selfReview.missedConcerns && a.selfReview.missedConcerns.length) {
      html += `<div style="background:#FFEBEE;border-radius:8px;padding:8px 10px;">
        <div style="font-size:11px;color:#C62828;font-weight:700;">⚠️ 没接住的顾虑（${a.selfReview.missedConcerns.length}）</div>
        ${a.selfReview.missedConcerns.slice(0,3).map(m => `<div style="font-size:12px;margin-top:4px;line-height:1.6;">·顾客：${(m.quote||'').replace(/</g,'&lt;')}<br><span style="color:#666;">应对：${(m.missedResponse||'').replace(/</g,'&lt;')}</span><br><span style="color:#388E3C;">建议：${(m.betterApproach||'').replace(/</g,'&lt;')}</span></div>`).join('')}
      </div>`;
    }
    if (a.selfReview.empathyScore) {
      html += `<div style="font-size:12px;color:#666;text-align:center;padding:4px;">共情评分：<b style="color:var(--pink);">${a.selfReview.empathyScore}/10</b></div>`;
    }
  }

  // 优化话术
  if (a.optimizedReplies && a.optimizedReplies.length) {
    html += `<div style="background:#E0F7FA;border-radius:8px;padding:8px 10px;">
      <div style="font-size:11px;color:#00838F;font-weight:700;">💡 优化话术参考（${a.optimizedReplies.length}）</div>
      ${a.optimizedReplies.slice(0,3).map(o => `<div style="font-size:12px;margin-top:4px;line-height:1.6;">·顾客：${(o.customerConcern||'').replace(/</g,'&lt;')}<br><span style="color:#388E3C;">优化：${(o.optimizedReply||'').replace(/</g,'&lt;')}</span>${o.professionalTerms ? `<br><span style="color:#666;font-size:11px;">专业词：${(o.professionalTerms||'').replace(/</g,'&lt;')}</span>` : ''}</div>`).join('')}
    </div>`;
  }

  // 关联项目表述
  if (a.projectStatements && Object.keys(a.projectStatements).length) {
    html += `<div style="background:#FFF3E0;border-radius:8px;padding:8px 10px;">
      <div style="font-size:11px;color:#E65100;font-weight:700;">📋 关联项目稳妥表述</div>
      ${Object.entries(a.projectStatements).map(([k, v]) => `<div style="font-size:12px;margin-top:4px;line-height:1.6;"><b>${k}：</b>${(v||'').replace(/</g,'&lt;')}</div>`).join('')}
    </div>`;
  }

  // 变美规划
  if (a.followUpSuggestions?.beautyPlan) {
    html += `<div style="background:#FCE4EC;border-radius:8px;padding:8px 10px;">
      <div style="font-size:11px;color:#C2185B;font-weight:700;">✨ 专属变美规划</div>
      <div style="font-size:12px;margin-top:2px;line-height:1.6;">${(a.followUpSuggestions.beautyPlan||'').replace(/</g,'&lt;')}</div>
    </div>`;
  }

  html += `</div></details>`;
  return html;
}

// 局部刷新录音列表（上传/转写/分析/删除后）
async function refreshCustomerRecordings(customerId) {
  const container = document.getElementById('customerRecordingsList');
  if (!container) return;
  try {
    const recordings = await AudioDB.listByCustomer(customerId);
    container.innerHTML = renderRecordingsList(recordings, customerId);
  } catch (e) {
    console.error(e);
  }
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
// 构建AI分析prompt（升级版：基础结构 + 自我复盘 + 优化话术 + 关联项目稳妥表述）
function buildAIPrompt(transcript) {
  return `你是一位资深的医美咨询师AI助手。请分析以下面诊录音转写文本，并按要求输出**严格 JSON** 格式的分析结果（直接用于顾客跟进台账）。

## 面诊对话文本：
${transcript}

## 门店可选项目列表（意向项目只能从这里选）：
${CLINIC_PROJECTS.join('、')}
${typeof getGlossaryHintBlock === 'function' ? getGlossaryHintBlock() : ''}

## 输出要求（严格JSON格式，不要输出任何其他内容，不要用markdown代码块包裹）：
{
  "customerBasics": {
    "skinIssues": "顾客的皮肤问题（斑点/毛孔/暗沉/痘印等），未提及填'未提及'",
    "agingIssues": "顾客的衰老问题（法令纹/松弛/下垂/眼袋/泪沟等），未提及填'未提及'",
    "facialPainPoints": "顾客面诊时表达的面部痛点（用顾客口语原话简短列举，如'口周凹陷/苹果肌下垂/鼻基底低'），逗号分隔，未提及填'未提及'",
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
  "interestedProjects": ["从门店项目列表中精确匹配顾客表现出兴趣的项目"],
  "visitIntent": {
    "level": "高/中/低（结合价格敏感度+异议指向综合判断）",
    "evidence": "判断到店意向的具体依据（一两句话）",
    "expectedVisitWindow": "预计到店时间窗（如'一周内'/'本月内'/'暂缓'），未提及填'未提及'"
  },
  "budget": {
    "acceptableBudget": "顾客可接受的预算金额范围（如'3000元以内'），未提及填'未提及'",
    "paymentMethod": "付款方式信息（分期/一次性/按次付费等），未提及填'未提及'",
    "depositInfo": "收款/定金/尾款/欠款信息，未提及填'未提及'"
  },
  "selfReview": {
    "empathyHits": [
      {"quote": "咨询师说的具体一句话或一小段话", "why": "为什么这句共情到位（贴合顾客情绪/给予安全感/快速建立信任）"}
    ],
    "missedConcerns": [
      {"quote": "顾客提出的具体顾虑原话", "missedResponse": "咨询师当时是怎么回应的（或沉默/绕开）", "betterApproach": "更好的处理方式（一两句话）"}
    ],
    "empathyScore": "本场面诊共情/接住顾客的整体评分（1-10）"
  },
  "optimizedReplies": [
    {
      "customerConcern": "顾客的某个具体疑问或顾虑",
      "currentResponse": "当前咨询师给的回应（来自对话）",
      "optimizedReply": "更贴合美业场景的优化回答（专业+共情+可执行）",
      "professionalTerms": "可以引用的专业术语或项目参数（如分层注射/SMAS层/嗨体1.5ml等）"
    }
  ],
  "projectStatements": {
    "<项目名>": "<针对该顾客情况，可稳妥使用的专业表述，含预期效果、维持周期、适合人群>"
  },
  "followUpSuggestions": {
    "nextActions": "给咨询师的下一步具体跟进动作（建议分1-2-3条）",
    "keyPoints": "下次沟通重点（如针对某顾虑的讲解要点）",
    "beautyPlan": "顾客专属变美规划草案（结合顾客面部痛点+在意项目+预算，列3-5步分阶段方案）"
  },
  "summary": "一句话总结本次面诊"
}

## 输出参考样例（学习格式与颗粒度，不要照搬内容）：
{
  "customerBasics": {"skinIssues": "眼袋膨出，泪沟凹陷", "agingIssues": "眼袋明显，显疲惫感", "facialPainPoints": "眼袋膨出,泪沟凹陷,黑眼圈", "painPoints": "眼袋影响形象，想尽快改善"},
  "customerNeeds": {"wantsToImprove": "改善眼袋，去掉显老感", "expectedResults": "自然平整，性价比高", "priceSensitivity": "高，多处比价"},
  "objections": [{"type": "竞品对比", "content": "外部咨询1500元做眼袋，对比本店3000元起"}],
  "interestedProjects": ["眶隔释放眼袋"],
  "visitIntent": {"level": "中", "evidence": "顾客对价格敏感但对面诊流程认可", "expectedVisitWindow": "本周内"},
  "budget": {"acceptableBudget": "上限3000元", "paymentMethod": "未提及", "depositInfo": "未提及"},
  "selfReview": {
    "empathyHits": [{"quote": "我完全理解您的顾虑，眼袋确实对形象影响挺大的", "why": "直接命名顾客感受，给予被理解的感觉"}],
    "missedConcerns": [{"quote": "会不会很疼？恢复多久？", "missedResponse": "没有正面回应疼痛细节", "betterApproach": "明确告知局麻过程、痛感等级、恢复时间"}],
    "empathyScore": 7
  },
  "optimizedReplies": [{
    "customerConcern": "会不会很疼？",
    "currentResponse": "手术都有点快的",
    "optimizedReply": "眶隔释放是局麻，术中基本无痛感，主要不适是术后3天轻微肿胀，我都帮您做好术后冷敷和消肿方案，您放心。",
    "professionalTerms": "眶隔释放/局麻/术后冷敷/消肿方案"
  }],
  "projectStatements": {
    "眶隔释放眼袋": "适合下睑脂肪膨出+皮肤不松弛人群，局麻完成，术后7天消肿，维持5-8年，可同时改善泪沟"
  },
  "followUpSuggestions": {
    "nextActions": ["微信发送术式对比要点", "提供真实案例对比图", "三天后回访"],
    "keyPoints": "重点讲解不同术式差异，不强求当场成交",
    "beautyPlan": "第1步：眶隔释放眼袋改善膨出 → 第2步：嗨体1.5ml填泪沟 → 第3步：3个月后评估是否需要热玛吉紧致眼周"
  },
  "summary": "顾客对眼袋改善需求明确，预算有限且关注性价比，需以案例和专业讲解建立信任"
}

## 注意：
1. 每项必须输出，未提及的填"未提及"，不要编造
2. 仔细识别医美口语化表达（如'做个眼睛'=眼整形、'打水光'=水光针、'美瑶'=美瑶时光机）
3. 金额、数字、时间必须原样保留
4. objections 只列顾客真实表达过的顾虑
5. interestedProjects 只匹配门店项目列表中的名称
6. selfReview 必须给出至少 1 条 empathyHits + 1 条 missedConcerns（对话里若有的话）
7. projectStatements 仅输出顾客表现出兴趣或咨询师推荐过的项目
8. beautyPlan 必须有 3-5 步分阶段建议`;
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
        max_tokens: 4000
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

// ===== 个人成长数据台账 =====
function renderDashboard(view) {
  const customers = Store.get('customers', []);
  const consumption = Store.get('consumption', []);
  const completions = Store.get('completions', {});

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  // 月度统计
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

  // 全量数据统计
  const allConsumptions = consumption.filter(c => c.status !== 'archived');
  const totalRevenue = allConsumptions.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);

  let html = `<div class="section-title">📊 个人成长数据台账</div>`;

  // 核心指标
  html += `
    <div class="consumption-stats" style="margin-bottom:12px;">
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

  // 最近活动
  html += `<div class="section-title">🕐 最近动态</div>`;
  const recentItems = [];
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
