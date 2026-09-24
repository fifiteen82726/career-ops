import { calendarRange, renderScanStatus, statusRowsForFilters, todayWindow, validStatusRow } from './scan-status.js';
const PRIORITY_RANK = { priority: 0, suggested: 1, low: 2 };
const searchableFields = ['scanDate', 'priority', 'priorityLabel', 'score', 'company', 'title', 'category', 'location', 'workMode', 'postedDate', 'primaryGap', 'resume', 'recommendation', 'referralMessage', 'applyUrl', 'recommendationUrl', 'linkedinPeopleUrl'];

export function quickRange(today, days) {
  const end = new Date(`${today}T12:00:00Z`);
  const start = new Date(end.getTime() - ((days - 1) * 86_400_000));
  return { start: start.toISOString().slice(0, 10), end: today };
}

export function defaultFilters(today) {
  return { query: '', priorities: new Set(['priority', 'suggested']), referralsOnly: false, ...quickRange(today, 7) };
}

function normalized(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase();
}

export function filterJobs(jobs, filters) {
  const query = normalized(filters.query).trim();
  const timeMatches = job => {
    if (!filters.windowStart || !filters.windowEnd) return job.scanDate >= filters.start && job.scanDate <= filters.end;
    const at = new Date(job.scannedAt || `${job.scanDate}T23:59:59.999Z`);
    if (job.scannedAtPrecision === 'day-end-fallback') return job.scanDate <= filters.end && Math.min(at.getTime(), filters.windowEnd.getTime()) >= filters.windowStart.getTime();
    return at >= filters.windowStart && at <= filters.windowEnd;
  };
  return jobs.filter(job => filters.priorities.has(job.priority)
    && timeMatches(job)
    && (!filters.referralsOnly || hasReferralContacts(job))
    && (!query || searchableFields.some(field => normalized(job[field]).includes(query)) || normalized(referralSearchText(job)).includes(query)));
}

export function referralSearchText(job) { return (job.referralContacts || []).flatMap(contact => [contact.fullName, contact.currentEmployer, contact.currentTitle, contact.profileUrl]).join(' '); }
export function hasReferralContacts(job) { return Array.isArray(job.referralContacts) && job.referralContacts.length > 0; }

export function filterReferralJobs(jobs, filters) {
  return filterJobs(jobs, { ...filters, referralsOnly: true });
}

function canonicalJobUrl(job) {
  const raw = job.applyUrl || job.recommendationUrl || job.id || '';
  try { const url = new URL(raw); url.hash = ''; return url.href; }
  catch { return raw; }
}

function connectionSortDate(connection) {
  return connection.connectedAtLatest || connection.connectedAtEarliest || connection.lastObservedAt?.slice(0, 10) || '';
}

export function groupReferralConnections(jobs) {
  const groups = new Map();
  for (const job of jobs) for (const contact of job.referralContacts || []) {
    const profileUrl = String(contact.profileUrl || '').trim();
    const currentEmployer = String(contact.currentEmployer || job.company || '').trim();
    if (!profileUrl || !currentEmployer) continue;
    const key = `${profileUrl}|${normalized(currentEmployer)}`;
    if (!groups.has(key)) groups.set(key, { key, ...contact, profileUrl, currentEmployer, jobs: [], jobKeys: new Set() });
    const group = groups.get(key); const jobKey = `${job.scanDate}|${canonicalJobUrl(job)}`;
    if (!group.jobKeys.has(jobKey)) { group.jobKeys.add(jobKey); group.jobs.push(job); }
  }
  return [...groups.values()].map(({ jobKeys, ...group }) => group).sort((a, b) =>
    connectionSortDate(b).localeCompare(connectionSortDate(a)) || String(a.fullName || '').localeCompare(String(b.fullName || '')));
}

export function buildReferralMessage({ company, jobs }) {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('Select at least one job');
  const multiple = jobs.length > 1;
  const list = jobs.map(job => `- ${job.title}\n  ${job.applyUrl || job.recommendationUrl || job.id || ''}`).join('\n\n');
  return `Thank you so much for connecting with me. I really appreciate your time and support.\n\nI’m very interested in the following ${multiple ? 'positions' : 'position'} at ${company}:\n\n${list}\n\nWould you feel comfortable referring me for ${multiple ? 'these roles' : 'this role'}? I’ve attached my resume for your reference. Here is my information in case it’s needed for the referral:\n\n---\n\nFirst Name: Yi-Yun\nLast Name: Liao\nEmail: yiyunliao21@gmail.com\nPhone: 929-313-3362`;
}

export function sortJobs(jobs, sort) {
  const multiplier = sort.direction === 'asc' ? 1 : -1;
  return jobs.map((job, index) => ({ job, index })).sort((left, right) => {
    const a = left.job; const b = right.job;
    let comparison = 0;
    if (sort.key === 'scanDate') comparison = a.scanDate.localeCompare(b.scanDate);
    else if (sort.key === 'priority') comparison = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    else if (sort.key === 'score') comparison = a.score - b.score;
    else return (b.scanDate.localeCompare(a.scanDate) || b.score - a.score || a.company.localeCompare(b.company) || a.title.localeCompare(b.title)) || left.index - right.index;
    return comparison ? comparison * multiplier : left.index - right.index;
  }).map(({ job }) => job);
}

function localToday(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function display(value) { return value || '—'; }

async function copy(text, notice) {
  try { await navigator.clipboard.writeText(text); notice.textContent = '已複製'; }
  catch { notice.textContent = '無法複製，請手動選取'; }
  setTimeout(() => { notice.textContent = ''; }, 1800);
}

function copyButton(value, label, notice) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'copy'; button.title = `複製${label}`; button.setAttribute('aria-label', `複製${label}`); button.textContent = '複製';
  button.addEventListener('click', () => copy(value, notice));
  return button;
}

function cell(value, label, notice, options = {}) {
  const td = document.createElement('td');
  const content = document.createElement('span'); content.className = options.preview ? 'preview' : 'value';
  if (options.href) {
    const link = document.createElement('a'); link.href = options.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = display(value); content.append(link);
  } else content.textContent = display(value);
  td.append(content, copyButton(options.copyValue ?? value ?? '', label, notice));
  return td;
}

function referralCell(contacts, notice) {
  const td = document.createElement('td');
  if (!hasReferralContacts({ referralContacts: contacts })) { td.textContent = '—'; return td; }
  const list = document.createElement('div'); list.className = 'referral-list';
  for (const contact of contacts) {
    const item = document.createElement('div'); item.className = 'referral-contact';
    const link = document.createElement('a'); link.href = contact.profileUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; link.textContent = contact.fullName;
    const meta = document.createElement('span'); meta.className = 'referral-meta'; meta.textContent = [contact.currentEmployer, contact.currentTitle, contact.connectedLabelRaw].filter(Boolean).join(' · ');
    const copies = document.createElement('div'); copies.className = 'copy-row'; copies.append(copyButton(contact.fullName || '', '姓名', notice), copyButton(contact.profileUrl || '', '連結', notice));
    item.append(link, meta, copies); list.append(item);
  }
  td.append(list); return td;
}

function referralStatus(snapshot) {
  if (snapshot.referralDataStatus === 'ok' || snapshot.referralDataStatus === 'partial') return snapshot.referralDataUpdatedAt ? `內推資料更新：${snapshot.referralDataUpdatedAt}` : '內推資料已更新';
  if (snapshot.referralDataStatus && snapshot.referralDataStatus !== 'not_configured') return '內推資料暫時無法更新；仍顯示最後有效的配對。';
  return '目前尚未設定內推資料。';
}

function priorityLabel(job) { return job.priorityLabel || ({ priority: '優先投遞', suggested: '建議投遞', low: '低優先' }[job.priority]); }

function renderRows(table, jobs, notice) {
  const body = table.tBodies[0]; body.replaceChildren();
  for (const job of jobs) {
    const row = document.createElement('tr');
    row.append(
      cell(job.scanDate, '掃描日期', notice),
      cell(priorityLabel(job), '優先序', notice),
      cell(String(job.score), '推薦分數', notice),
      cell(job.recommendation, '建議', notice, { href: job.recommendationUrl, copyValue: job.recommendationUrl || job.recommendation }),
      cell(job.company, '公司', notice), cell(job.title, '職缺', notice), cell(job.category, '分類', notice),
      cell(job.location, '地點', notice), cell(job.workMode, '工作模式', notice), cell(job.postedDate, '發布日期', notice),
      cell(job.primaryGap, '主要缺口', notice), cell(job.resume, '使用履歷', notice),
      cell(job.applyUrl ? '申請職缺' : '', '申請連結', notice, { href: job.applyUrl, copyValue: job.applyUrl }),
      cell(job.linkedinPeopleUrl ? '找內推人' : '', 'LinkedIn People', notice, { href: job.linkedinPeopleUrl, copyValue: job.linkedinPeopleUrl }),
      referralCell(job.referralContacts, notice),
      cell(job.referralMessage, '內推訊息', notice, { preview: true }),
    );
    body.append(row);
  }
}

function jobSelectionKey(job) { return `${job.scanDate}|${canonicalJobUrl(job)}`; }

function pruneConnectionSelections(selections, groups) {
  const visible = new Map(groups.map(group => [group.key, new Set(group.jobs.map(jobSelectionKey))]));
  for (const [groupKey, selected] of selections) {
    const allowed = visible.get(groupKey);
    if (!allowed) { selections.delete(groupKey); continue; }
    for (const jobKey of selected) if (!allowed.has(jobKey)) selected.delete(jobKey);
    if (!selected.size) selections.delete(groupKey);
  }
}

function connectionJobRow(job, checked, onChange) {
  const row = document.createElement('label'); row.className = 'connection-job';
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = checked; checkbox.addEventListener('change', () => onChange(checkbox.checked));
  const role = document.createElement('span'); role.className = 'connection-job-role';
  const link = document.createElement('a'); link.href = job.applyUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = job.title;
  const detail = document.createElement('span'); detail.textContent = [job.location, job.resume].filter(Boolean).join(' · ');
  role.append(link, detail);
  const priority = document.createElement('span'); priority.className = `connection-priority ${job.priority}`; priority.textContent = priorityLabel(job);
  const score = document.createElement('span'); score.className = 'connection-score'; score.textContent = `${job.score} 分`;
  const posted = document.createElement('span'); posted.className = 'connection-posted'; posted.textContent = job.postedDate ? `${job.postedDate} 發布` : '發布日未提供';
  row.append(checkbox, role, priority, score, posted); return row;
}

function renderConnections(container, groups, selections, openMessage) {
  container.replaceChildren();
  for (const group of groups) {
    const card = document.createElement('article'); card.className = 'connection-card';
    const heading = document.createElement('div'); heading.className = 'connection-heading';
    const identity = document.createElement('div'); identity.className = 'connection-identity';
    const nameLine = document.createElement('div'); nameLine.className = 'connection-name-line';
    const profile = document.createElement('a'); profile.href = group.profileUrl; profile.target = '_blank'; profile.rel = 'noopener noreferrer'; profile.referrerPolicy = 'no-referrer'; profile.textContent = group.fullName || 'LinkedIn Connection';
    const connected = document.createElement('span'); connected.textContent = group.connectedLabelRaw || '';
    nameLine.append(profile, connected);
    const meta = document.createElement('p'); meta.textContent = [group.currentTitle, group.currentEmployer].filter(Boolean).join(' · ');
    identity.append(nameLine, meta);
    const count = document.createElement('span'); count.className = 'connection-count'; count.textContent = `${group.jobs.length} 個可內推職缺`;
    heading.append(identity, count);

    const jobList = document.createElement('div'); jobList.className = 'connection-jobs';
    const selected = selections.get(group.key) || new Set();
    const footer = document.createElement('div'); footer.className = 'connection-actions';
    const selectedCount = document.createElement('span');
    const generate = document.createElement('button'); generate.type = 'button'; generate.className = 'primary-action'; generate.textContent = '產生內推訊息';
    const refreshActions = () => { selectedCount.textContent = selected.size ? `已選 ${selected.size} 個職缺` : '尚未選擇職缺'; generate.disabled = selected.size === 0; };
    for (const job of group.jobs) {
      const jobKey = jobSelectionKey(job);
      jobList.append(connectionJobRow(job, selected.has(jobKey), checked => {
        if (checked) selected.add(jobKey); else selected.delete(jobKey);
        if (selected.size) selections.set(group.key, selected); else selections.delete(group.key);
        refreshActions();
      }));
    }
    generate.addEventListener('click', () => openMessage(group, group.jobs.filter(job => selected.has(jobSelectionKey(job)))));
    refreshActions(); footer.append(selectedCount, generate); card.append(heading, jobList, footer); container.append(card);
  }
}

async function initialize() {
  const error = document.querySelector('#load-error'); const notice = document.querySelector('#notice');
  try {
    const response = await fetch('./data/jobs.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.jobs)) throw new Error('invalid snapshot');
    const today = localToday(snapshot.timeZone || 'America/New_York');
    const timeZone = snapshot.timeZone || 'America/New_York'; const state = { filters: { ...defaultFilters(today), ...todayWindow(new Date(), timeZone) }, sort: { key: 'default', direction: 'desc' }, connectionSelections: new Map(), statusDays: [] };
    const table = document.querySelector('table'); const query = document.querySelector('#query'); const start = document.querySelector('#start-date'); const end = document.querySelector('#end-date'); const resultCount = document.querySelector('#result-count'); const referralsOnly = document.querySelector('#referrals-only');
    const connectionsList = document.querySelector('#connections-list'); const connectionsCount = document.querySelector('#connections-count'); const connectionsEmpty = document.querySelector('#connections-empty');
    const statusBody = document.querySelector('#scan-status tbody'); const statusError = document.querySelector('#scan-status-error');
    fetch('./data/scan-status.json', { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }).then(doc => { if (doc.schemaVersion !== 1 || !Array.isArray(doc.days) || !doc.days.every(validStatusRow)) throw new Error('invalid status'); state.statusDays = doc.days; update(); }).catch(() => { state.statusDays = []; statusError.hidden = false; statusError.textContent = '無法載入掃描狀態；顯示未執行日期。'; update(); });
    const dialog = document.querySelector('#referral-dialog'); const dialogContext = document.querySelector('#referral-dialog-context'); const editor = document.querySelector('#referral-message-editor');
    document.querySelector('#referral-status').textContent = referralStatus(snapshot);
    start.value = state.filters.start; end.value = state.filters.end;
    const closeDialog = () => { if (dialog.open) dialog.close(); };
    const openMessage = (group, jobs) => {
      if (!jobs.length) return;
      editor.value = buildReferralMessage({ company: group.currentEmployer, jobs });
      dialogContext.textContent = `${group.fullName || 'LinkedIn Connection'} · ${group.currentEmployer} · 已選 ${jobs.length} 個職缺`;
      if (!dialog.open) dialog.showModal();
    };
    document.querySelector('#referral-dialog-close').addEventListener('click', closeDialog); document.querySelector('#referral-dialog-cancel').addEventListener('click', closeDialog);
    document.querySelector('#referral-dialog-copy').addEventListener('click', () => copy(editor.value, notice));
    dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
    const update = () => {
      state.filters.query = query.value; state.filters.start = start.value; state.filters.end = end.value;
      state.filters.priorities = new Set([...document.querySelectorAll('[data-priority]:checked')].map(input => input.dataset.priority)); state.filters.referralsOnly = referralsOnly.checked;
      if (!state.filters.start || !state.filters.end || state.filters.start > state.filters.end) { error.hidden = false; error.textContent = '日期範圍無效：開始日期必須早於或等於結束日期。'; return; }
      error.hidden = true; const visible = sortJobs(filterJobs(snapshot.jobs, state.filters), state.sort); renderRows(table, visible, notice); resultCount.textContent = `${visible.length} 個結果`;
      renderScanStatus(statusBody, statusRowsForFilters(state.statusDays, state.filters, timeZone));
      const referralJobs = sortJobs(filterReferralJobs(snapshot.jobs, state.filters), state.sort); const groups = groupReferralConnections(referralJobs); pruneConnectionSelections(state.connectionSelections, groups); renderConnections(connectionsList, groups, state.connectionSelections, openMessage);
      connectionsCount.textContent = `${groups.length} 位可聯絡`; connectionsEmpty.hidden = groups.length > 0;
    };
    query.addEventListener('input', update);
    for (const input of document.querySelectorAll('[data-priority], #start-date, #end-date, #referrals-only')) input.addEventListener('change', () => { if (input.matches('#start-date, #end-date')) { delete state.filters.windowStart; delete state.filters.windowEnd; document.querySelectorAll('[data-range]').forEach(button => { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false'); }); } update(); });
    for (const button of document.querySelectorAll('[data-range]')) button.addEventListener('click', () => { const range = button.dataset.range === 'today' ? todayWindow(new Date(), timeZone) : calendarRange(new Date(), Number(button.dataset.range), timeZone); delete state.filters.windowStart; delete state.filters.windowEnd; Object.assign(state.filters, range); start.value = range.start; end.value = range.end; document.querySelectorAll('[data-range]').forEach(candidate => { const active = candidate === button; candidate.classList.toggle('active', active); candidate.setAttribute('aria-pressed', String(active)); }); update(); });
    for (const button of document.querySelectorAll('th button[data-sort]')) button.addEventListener('click', () => { const key = button.dataset.sort; state.sort = { key, direction: state.sort.key === key && state.sort.direction === 'desc' ? 'asc' : 'desc' }; document.querySelectorAll('th[data-sort]').forEach(header => { const active = header.dataset.sort === key; header.setAttribute('aria-sort', active ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'); header.querySelector('button').textContent = `${header.dataset.label} ${active ? (state.sort.direction === 'asc' ? '↑' : '↓') : '↕'}`; }); update(); });
    update();
  } catch (cause) { error.hidden = false; error.textContent = '無法載入本機職缺快照。請執行 refresh 指令後重新整理頁面。'; console.error(cause); }
}

if (typeof document !== 'undefined') initialize();
