const DATA_URL = 'data/jobs.json';
const CONFIG_URL = 'config.json';
const STATUS_URL = 'data/status.json';

let jobs = [];
let config = {};
let sourceStatus = {};
let activeTag = 'all';

const $ = (id) => document.getElementById(id);
const localKey = (kind) => `academic-job-radar:${kind}`;
const getSet = (kind) => new Set(JSON.parse(localStorage.getItem(localKey(kind)) || '[]'));
const saveSet = (kind, set) => localStorage.setItem(localKey(kind), JSON.stringify([...set]));

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(value) {
  const d = safeDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function daysFromToday(value) {
  const d = safeDate(value);
  if (!d) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.ceil((target - today) / 86400000);
}

function esc(text = '') {
  return String(text).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));
}

function classifyType(job) {
  const text = `${job.title} ${job.tags?.join(' ') || ''}`.toLowerCase();
  if (/postdoc|postdoctoral/.test(text)) return 'postdoc';
  if (/extension/.test(text)) return 'extension';
  if (/professor|faculty|lecturer/.test(text)) return 'faculty';
  return 'research';
}

function isNew(job) {
  const d = safeDate(job.firstSeen || job.postedDate);
  if (!d) return false;
  return (Date.now() - d.getTime()) <= 7 * 86400000;
}

function localState(job) {
  return {
    saved: getSet('saved').has(job.id),
    applied: getSet('applied').has(job.id),
    hidden: getSet('hidden').has(job.id)
  };
}

function toggleLocal(kind, id) {
  const set = getSet(kind);
  set.has(id) ? set.delete(id) : set.add(id);
  saveSet(kind, set);
  render();
}

function jobMatches(job) {
  const q = $('searchInput').value.trim().toLowerCase();
  const minScore = Number($('scoreFilter').value || 0);
  const type = $('typeFilter').value;
  const state = $('stateFilter').value;
  const local = localState(job);

  if ((job.score || 0) < minScore) return false;
  if (type !== 'all' && classifyType(job) !== type) return false;

  if (state === 'active' && (!job.active || local.hidden)) return false;
  if (state === 'saved' && !local.saved) return false;
  if (state === 'applied' && !local.applied) return false;
  if (state === 'hidden' && !local.hidden) return false;

  const haystack = [job.title, job.institution, job.location, job.source, ...(job.tags || []), ...(job.matchReasons || [])]
    .join(' ').toLowerCase();
  if (q && !haystack.includes(q)) return false;
  if (activeTag !== 'all' && !haystack.includes(activeTag)) return false;
  return true;
}

function sortJobs(list) {
  const mode = $('sortBy').value;
  return [...list].sort((a, b) => {
    if (mode === 'newest') {
      return (safeDate(b.firstSeen || b.postedDate)?.getTime() || 0) - (safeDate(a.firstSeen || a.postedDate)?.getTime() || 0) || (b.score || 0) - (a.score || 0);
    }
    if (mode === 'deadline') {
      const aTime = safeDate(a.deadline)?.getTime() || Number.MAX_SAFE_INTEGER;
      const bTime = safeDate(b.deadline)?.getTime() || Number.MAX_SAFE_INTEGER;
      return aTime - bTime || (b.score || 0) - (a.score || 0);
    }
    return (b.score || 0) - (a.score || 0) || (safeDate(b.firstSeen)?.getTime() || 0) - (safeDate(a.firstSeen)?.getTime() || 0);
  });
}

function renderCard(job) {
  const local = localState(job);
  const deadlineDays = daysFromToday(job.deadline);
  const deadlineClass = deadlineDays !== null && deadlineDays >= 0 && deadlineDays <= 14 ? 'deadline-soon' : '';
  const reasonTags = (job.matchReasons || []).slice(0, 5).map(t => `<span class="tag match">${esc(t)}</span>`).join('');
  const normalTags = (job.tags || []).slice(0, 5).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const newPill = isNew(job) ? '<span class="new-pill">NEW</span>' : '';
  const activeText = job.active ? '' : '<span class="tag">可能已下架</span>';

  return `
    <article class="job-card">
      <div class="score-badge" title="依 config.json 的關鍵字規則計算">
        <strong>${Number(job.score || 0)}</strong><span>適合度</span>
      </div>
      <div class="job-main">
        <h3 class="job-title"><a href="${esc(job.url)}" target="_blank" rel="noopener noreferrer">${esc(job.title || 'Untitled position')}</a></h3>
        <div class="job-meta">
          <span>${esc(job.institution || 'Institution unknown')}</span>
          <span>${esc(job.location || 'Location not listed')}</span>
          <span>${esc(job.source || '')}</span>
          ${newPill}
          ${activeText}
        </div>
        <div class="job-meta">
          <span>發現：${fmtDate(job.firstSeen)}</span>
          ${job.postedDate ? `<span>刊登：${fmtDate(job.postedDate)}</span>` : ''}
          ${job.deadline ? `<span class="${deadlineClass}">截止：${fmtDate(job.deadline)}${deadlineDays !== null && deadlineDays >= 0 ? `（${deadlineDays} 天）` : ''}</span>` : '<span>截止：未列出</span>'}
        </div>
        <div class="tags">${reasonTags}${normalTags}</div>
      </div>
      <div class="job-actions">
        <button class="icon-btn ${local.saved ? 'on' : ''}" data-action="saved" data-id="${esc(job.id)}" type="button">${local.saved ? '★ 已收藏' : '☆ 收藏'}</button>
        <button class="icon-btn ${local.applied ? 'on' : ''}" data-action="applied" data-id="${esc(job.id)}" type="button">${local.applied ? '✓ 已申請' : '標記申請'}</button>
        <button class="icon-btn danger ${local.hidden ? 'on' : ''}" data-action="hidden" data-id="${esc(job.id)}" type="button">${local.hidden ? '↩ 取消隱藏' : '隱藏'}</button>
      </div>
    </article>`;
}

function renderStats() {
  const visibleActive = jobs.filter(j => j.active);
  $('activeCount').textContent = visibleActive.length;
  $('highCount').textContent = visibleActive.filter(j => (j.score || 0) >= 80).length;
  $('newCount').textContent = visibleActive.filter(isNew).length;
}

function renderSourceStatus() {
  const box = $('sourceStatus');
  const failures = (sourceStatus.sources || []).filter(s => !s.ok);
  if (!failures.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<strong>部分來源本次更新失敗：</strong> ${failures.map(s => esc(s.name)).join('、')}。舊資料已保留，可從頁面下方直接開啟來源確認。`;
}

function renderSourceLinks() {
  const el = $('sourceLinks');
  el.innerHTML = (config.sources || []).map(s => `
    <a class="source-link" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
      <strong>${esc(s.name)}</strong><span>開啟來源 ↗</span>
    </a>`).join('');
}

function render() {
  renderStats();
  renderSourceStatus();
  const filtered = sortJobs(jobs.filter(jobMatches));
  $('jobList').innerHTML = filtered.map(renderCard).join('');
  $('resultCount').textContent = `${filtered.length} 個結果`;
  $('emptyState').hidden = filtered.length !== 0;
}

async function init() {
  try {
    const [jobRes, configRes, statusRes] = await Promise.all([
      fetch(DATA_URL, { cache: 'no-store' }),
      fetch(CONFIG_URL, { cache: 'no-store' }),
      fetch(STATUS_URL, { cache: 'no-store' }).catch(() => null)
    ]);
    if (!jobRes.ok) throw new Error(`jobs.json ${jobRes.status}`);
    jobs = await jobRes.json();
    config = configRes.ok ? await configRes.json() : {};
    if (statusRes?.ok) sourceStatus = await statusRes.json();
    $('lastUpdated').textContent = sourceStatus.updatedAt ? fmtDate(sourceStatus.updatedAt) : (jobs[0]?.lastSeen ? fmtDate(jobs[0].lastSeen) : '尚未自動更新');
    renderSourceLinks();
    render();
  } catch (err) {
    console.error(err);
    $('jobList').innerHTML = `<div class="empty"><h3>資料讀取失敗</h3><p>若你是直接雙擊 index.html，瀏覽器可能會擋 JSON 載入。請用 GitHub Pages，或在本機資料夾執行 <code>python -m http.server</code> 後開啟。</p></div>`;
  }
}

['searchInput','scoreFilter','typeFilter','stateFilter','sortBy'].forEach(id => $(id).addEventListener('input', render));

document.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeTag = btn.dataset.tag || 'all';
  render();
}));

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action][data-id]');
  if (!btn) return;
  toggleLocal(btn.dataset.action, btn.dataset.id);
});

$('resetLocal').addEventListener('click', () => {
  if (!confirm('要清除這台瀏覽器的收藏、已申請與隱藏標記嗎？')) return;
  ['saved','applied','hidden'].forEach(k => localStorage.removeItem(localKey(k)));
  render();
});

init();
