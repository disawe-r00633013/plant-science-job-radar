const STORAGE_KEY = "plantScienceCareerRadarPrefsV3";
const STATE_KEY = "plantScienceCareerRadarJobStateV5";
const V4_STATE_KEY = "plantScienceCareerRadarJobStateV4";
const SYNC_CONFIG_KEY = "plantScienceCareerRadarGithubSyncV5";
const SYNC_TOKEN_KEY = "plantScienceCareerRadarGithubTokenV5";
const SYNC_TOKEN_SESSION_KEY = "plantScienceCareerRadarGithubTokenSessionV5";
const OLD_STATE_KEY = "plantScienceCareerRadarJobStateV3";

let CONFIG = null;
let JOBS = [];
let STATUS = {};
let prefs = null;
let quickTopic = "all";
let activeTab = "new";
let editingJobId = null;
let syncTimer = null;
let syncInFlight = false;
let lastRemoteSha = null;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function escapeHtml(s=""){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function normalize(s=""){ return String(s).toLowerCase().replace(/[–—]/g,"-"); }
function uid(j){ return j.id || `${j.url}|${j.title}|${j.organization}`; }
function today(){ return new Date().toISOString().slice(0,10); }

async function loadData(){
  const [c,j,s] = await Promise.all([
    fetch("config.json?ts="+Date.now()).then(r=>r.json()),
    fetch("data/jobs.json?ts="+Date.now()).then(r=>r.json()).catch(()=>({jobs:[]})),
    fetch("data/status.json?ts="+Date.now()).then(r=>r.json()).catch(()=>({}))
  ]);
  CONFIG=c; JOBS=j.jobs||[]; STATUS=s||{};
  prefs = loadPrefs();
  migrateOldState();
  await loadPublishedProgress();
  buildSettings();
  syncControlsToPrefs();
  renderQuickTopics();
  renderStatus();
  bindPipelineTabs();
  initGithubSyncUI();
  render();
}
function loadPrefs(){
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? {...structuredClone(CONFIG.default_preferences), ...saved, topics:{...CONFIG.default_preferences.topics,...(saved.topics||{})}} : structuredClone(CONFIG.default_preferences);
  }catch(e){ return structuredClone(CONFIG.default_preferences); }
}
function savePrefs(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); }
function migrateOldState(){
  if(localStorage.getItem(STATE_KEY)) return;
  const old=localStorage.getItem(V4_STATE_KEY) || localStorage.getItem(OLD_STATE_KEY);
  if(old){
    try{
      const parsed=JSON.parse(old)||{};
      const now=new Date().toISOString();
      Object.values(parsed).forEach(v=>{ if(v && !v.updatedAt) v.updatedAt=now; });
      localStorage.setItem(STATE_KEY,JSON.stringify(parsed));
    }catch(e){}
  }
}
function loadJobState(){ try{return JSON.parse(localStorage.getItem(STATE_KEY))||{}}catch(e){return{}} }
function updateJobState(id,patch){
  const st=loadJobState();
  st[id]={...(st[id]||{}),...patch,updatedAt:new Date().toISOString()};
  localStorage.setItem(STATE_KEY,JSON.stringify(st));
  refreshSyncSummary();
  scheduleGithubSync();
}
function getJobState(id){ return loadJobState()[id]||{}; }
function bucketFor(job){
  const s=getJobState(uid(job));
  if(s.hidden) return "hidden";
  if(s.applied) return "applied";
  if(s.saved) return "saved";
  return "new";
}

function buildSettings(){
  const roleBox=$("#roleSettings"); roleBox.innerHTML="";
  Object.keys(CONFIG.role_keywords).forEach(role=>{
    const label=document.createElement("label"); label.className="check";
    label.innerHTML=`<input type="checkbox" name="role" value="${escapeHtml(role)}"> ${escapeHtml(role)}`;
    roleBox.appendChild(label);
  });
  const topicBox=$("#topicSettings"); topicBox.innerHTML="";
  Object.keys(CONFIG.topic_keywords).forEach(topic=>{
    const row=document.createElement("div"); row.className="weight-row";
    row.innerHTML=`<div class="weight-label"><strong>${escapeHtml(topic)}</strong><small>${escapeHtml(CONFIG.topic_keywords[topic].slice(0,3).join(" · "))}</small></div>
      <select data-topic="${escapeHtml(topic)}"><option value="high">高</option><option value="medium">普通</option><option value="ignore">忽略</option></select>`;
    topicBox.appendChild(row);
  });
}
function syncControlsToPrefs(){
  $$('input[name="sector"]').forEach(x=>x.checked=prefs.sectors.includes(x.value));
  $$('input[name="role"]').forEach(x=>x.checked=prefs.roles.includes(x.value));
  $$('[data-topic]').forEach(x=>x.value=prefs.topics[x.dataset.topic]||"ignore");
  $("#excludeKeywords").value=(prefs.exclude_keywords||[]).join(", ");
  $("#defaultMinScore").value=String(prefs.min_score ?? 60);
  $("#newDays").value=String(prefs.new_days || CONFIG.app.new_days || 7);
  $("#scoreFilter").value=String(prefs.min_score ?? 60);
}
function readSettingsForm(){
  return {...prefs,
    sectors: $$('input[name="sector"]:checked').map(x=>x.value),
    roles: $$('input[name="role"]:checked').map(x=>x.value),
    topics: Object.fromEntries($$('[data-topic]').map(x=>[x.dataset.topic,x.value])),
    exclude_keywords: $("#excludeKeywords").value.split(",").map(x=>x.trim()).filter(Boolean),
    min_score: Number($("#defaultMinScore").value), new_days: Number($("#newDays").value)
  };
}
function renderQuickTopics(){
  const box=$("#quickTopics"); box.innerHTML="";
  ["all", ...Object.keys(CONFIG.topic_keywords)].forEach(t=>{
    const b=document.createElement("button"); b.className="topic-pill"+(quickTopic===t?" active":"");
    b.textContent=t==="all"?"全部領域":t;
    b.onclick=()=>{quickTopic=t;renderQuickTopics();render();}; box.appendChild(b);
  });
}
function bindPipelineTabs(){
  $$(".pipeline-tab").forEach(btn=>btn.onclick=()=>{
    activeTab=btn.dataset.tab;
    $$(".pipeline-tab").forEach(x=>x.classList.toggle("active",x===btn));
    render();
  });
}
function daysSince(d){
  if(!d) return 999; const x=new Date(d); if(Number.isNaN(+x)) return 999;
  return Math.floor((Date.now()-x.getTime())/86400000);
}
function roleMatches(job){
  const text=normalize(`${job.title} ${job.snippet||""}`);
  return Object.entries(CONFIG.role_keywords).filter(([_,keys])=>keys.some(k=>text.includes(normalize(k)))).map(([r])=>r);
}
function topicMatches(job){
  const text=normalize(`${job.title} ${job.snippet||""} ${(job.tags||[]).join(" ")}`);
  return Object.entries(CONFIG.topic_keywords).filter(([_,keys])=>keys.some(k=>text.includes(normalize(k)))).map(([t])=>t);
}
function scoreJob(job){
  const text=normalize(`${job.title} ${job.organization||""} ${job.snippet||""} ${(job.tags||[]).join(" ")}`);
  let score=35; const matches=topicMatches(job);
  matches.forEach(t=>{ const w=prefs.topics[t]||"ignore"; score += w==="high"?12:w==="medium"?6:0; });
  const roles=roleMatches(job); if(roles.some(r=>prefs.roles.includes(r))) score+=14; else if(roles.length) score-=5;
  if(prefs.sectors.includes(job.sector)) score+=8; else score-=25;
  (prefs.exclude_keywords||[]).forEach(k=>{if(k&&text.includes(normalize(k)))score-=35});
  if(/\b(united states|usa|u\.s\.|us)\b/.test(text)) score+=4;
  if(job.us_only===false)score-=100;
  return Math.max(0,Math.min(100,score));
}
function enrichedJobs(){ return JOBS.map(j=>({...j,_score:scoreJob(j),_topics:topicMatches(j),_roles:roleMatches(j),_bucket:bucketFor(j)})); }
function pipelineCounts(all){
  const qualified=j=>prefs.sectors.includes(j.sector)&&j._score>=Number(prefs.min_score||0);
  return {
    new:all.filter(j=>j._bucket==="new"&&qualified(j)).length,
    saved:all.filter(j=>j._bucket==="saved").length,
    applied:all.filter(j=>j._bucket==="applied").length,
    hidden:all.filter(j=>j._bucket==="hidden").length
  };
}
function filteredJobs(all){
  const q=normalize($("#searchInput").value.trim()), sector=$("#sectorFilter").value, min=Number($("#scoreFilter").value);
  let arr=all.filter(j=>j._bucket===activeTab);
  arr=arr.filter(j=>{
    if(sector!=="all"&&j.sector!==sector)return false;
    if(activeTab==="new"){
      if(!prefs.sectors.includes(j.sector)||j._score<min)return false;
    }
    if(quickTopic!=="all"&&!j._topics.includes(quickTopic))return false;
    if(q&&!normalize(`${j.title} ${j.organization} ${j.location} ${j.snippet} ${(j.tags||[]).join(" ")}`).includes(q))return false;
    return true;
  });
  const sort=$("#sortFilter").value;
  arr.sort((a,b)=>{
    if(sort==="new")return(new Date(b.first_seen||0))-(new Date(a.first_seen||0))||b._score-a._score;
    if(sort==="title")return a.title.localeCompare(b.title);
    return b._score-a._score||(new Date(b.first_seen||0))-(new Date(a.first_seen||0));
  }); return arr;
}
function renderStatus(){
  $("#lastUpdated").textContent=STATUS.last_updated?new Date(STATUS.last_updated).toLocaleDateString("zh-TW"):"尚未更新";
  const errors=STATUS.errors||[]; if(errors.length){$("#sourceAlert").classList.remove("hidden");$("#sourceAlert").innerHTML=`<strong>更新狀態：</strong> ${escapeHtml(errors.join("；"))}`;}else $("#sourceAlert").classList.add("hidden");
}
function tabTitle(){return {new:"新職缺",saved:"已收藏",applied:"已申請",hidden:"已隱藏"}[activeTab]}
function render(){
  const all=enrichedJobs(), counts=pipelineCounts(all), arr=filteredJobs(all), grid=$("#jobsGrid"), tpl=$("#jobTemplate"); grid.innerHTML="";
  $("#newPipelineCount").textContent=counts.new; $("#savedPipelineCount").textContent=counts.saved; $("#appliedPipelineCount").textContent=counts.applied;
  $("#tabNewCount").textContent=counts.new; $("#tabSavedCount").textContent=counts.saved; $("#tabAppliedCount").textContent=counts.applied; $("#tabHiddenCount").textContent=counts.hidden;
  $(".section-head h2").textContent=tabTitle();
  const tracked=activeTab!=="new"?"；追蹤中的職缺不受預設最低適合度限制":"";
  $("#resultSummary").textContent=`顯示 ${arr.length} 筆${tracked}`;
  $("#emptyState").classList.toggle("hidden",arr.length>0);
  $("#emptyState h3").textContent=`目前沒有${tabTitle()}`;
  arr.forEach(j=>{
    const node=tpl.content.cloneNode(true), id=uid(j), js=getJobState(id), badges=node.querySelector(".badges");
    const addBadge=(txt,cls="")=>{const x=document.createElement("span");x.className=`badge ${cls}`;x.textContent=txt;badges.appendChild(x)};
    addBadge(j.sector==="academia"?"Academia":"Industry",j.sector);
    if(daysSince(j.first_seen)<=(prefs.new_days||7))addBadge("NEW","new");
    if(activeTab==="applied"&&js.applicationStatus)addBadge(js.applicationStatus,"application-status");
    if(j.source)addBadge(j.source);
    node.querySelector(".score-value").textContent=j._score; node.querySelector(".job-title").textContent=j.title||"Untitled";
    node.querySelector(".org").textContent=j.organization||""; node.querySelector(".location").textContent=j.location||"United States"; node.querySelector(".snippet").textContent=j.snippet||"";
    const mr=node.querySelector(".match-row"); [...j._topics,...j._roles].slice(0,6).forEach(m=>{const x=document.createElement("span");x.className="match";x.textContent=m;mr.appendChild(x)});
    node.querySelector(".job-meta").textContent=`首次發現：${j.first_seen||"—"}${j.posted_date?` ｜ 刊登：${j.posted_date}`:""}${j.domain?` ｜ ${j.domain}`:""}`;
    if(activeTab==="applied"){
      const detail=document.createElement("div"); detail.className="application-detail";
      const items=[`<strong>狀態：</strong>${escapeHtml(js.applicationStatus||"Applied")}`,`<strong>申請：</strong>${escapeHtml(js.appliedDate||"—")}`];
      if(js.deadline)items.push(`<strong>Deadline：</strong>${escapeHtml(js.deadline)}`); if(js.interviewDate)items.push(`<strong>面試：</strong>${escapeHtml(js.interviewDate.replace("T"," "))}`);
      if(js.notes)items.push(`<strong>備註：</strong>${escapeHtml(js.notes)}`); detail.innerHTML=items.join("<br>"); node.querySelector(".match-row").after(detail);
    }
    node.querySelector(".open-link").href=j.url;
    const save=node.querySelector(".save-btn"), applied=node.querySelector(".applied-btn"), manage=node.querySelector(".manage-btn"), restore=node.querySelector(".restore-btn"), hide=node.querySelector(".hide-btn");
    if(activeTab==="new"){
      save.onclick=()=>{updateJobState(id,{saved:true,hidden:false});render()};
      applied.onclick=()=>{markApplied(j)}; hide.onclick=()=>{updateJobState(id,{hidden:true});render()};
    }else if(activeTab==="saved"){
      save.textContent="移回新職缺"; save.classList.add("saved"); save.onclick=()=>{updateJobState(id,{saved:false});render()};
      applied.onclick=()=>{markApplied(j)}; hide.onclick=()=>{updateJobState(id,{saved:false,hidden:true});render()};
    }else if(activeTab==="applied"){
      save.classList.add("hidden"); applied.classList.add("hidden"); manage.classList.remove("hidden"); hide.classList.add("hidden"); manage.onclick=()=>openApplication(j);
    }else if(activeTab==="hidden"){
      save.classList.add("hidden"); applied.classList.add("hidden"); hide.classList.add("hidden"); restore.classList.remove("hidden");
      restore.onclick=()=>{updateJobState(id,{hidden:false});render()};
    }
    grid.appendChild(node);
  });
}
function markApplied(job){
  const id=uid(job), s=getJobState(id);
  updateJobState(id,{applied:true,hidden:false,appliedDate:s.appliedDate||today(),applicationStatus:s.applicationStatus||"Applied"});
  render(); openApplication(job);
}
function openApplication(job){
  editingJobId=uid(job); const s=getJobState(editingJobId);
  $("#applicationJobTitle").textContent=job.title||"管理申請"; $("#applicationJobOrg").textContent=job.organization||"";
  $("#applicationStatus").value=s.applicationStatus||"Applied"; $("#appliedDate").value=s.appliedDate||today();
  $("#applicationDeadline").value=s.deadline||""; $("#interviewDate").value=s.interviewDate||""; $("#applicationNotes").value=s.notes||"";
  $("#applicationDialog").showModal();
}
$("#saveApplication").onclick=()=>{
  if(!editingJobId)return; updateJobState(editingJobId,{applied:true,hidden:false,applicationStatus:$("#applicationStatus").value,appliedDate:$("#appliedDate").value||today(),deadline:$("#applicationDeadline").value,interviewDate:$("#interviewDate").value,notes:$("#applicationNotes").value.trim()});
  $("#applicationDialog").close();render();
};
$("#moveToSaved").onclick=()=>{
  if(!editingJobId)return; updateJobState(editingJobId,{applied:false,saved:true,hidden:false}); $("#applicationDialog").close(); activeTab="saved"; $$(".pipeline-tab").forEach(x=>x.classList.toggle("active",x.dataset.tab===activeTab)); render();
};

/* ---------------- v5 GitHub progress sync ---------------- */
function defaultSyncConfig(){
  return {
    owner:"disawe-r00633013",
    repo:"plant-science-job-radar",
    branch:"main",
    path:"data/application-progress.json",
    rememberToken:false,
    lastSyncAt:null
  };
}
function loadSyncConfig(){
  try{return {...defaultSyncConfig(),...(JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY))||{})};}
  catch(e){return defaultSyncConfig();}
}
function saveSyncConfig(cfg){ localStorage.setItem(SYNC_CONFIG_KEY,JSON.stringify(cfg)); }
function getGithubToken(){
  return sessionStorage.getItem(SYNC_TOKEN_SESSION_KEY) || localStorage.getItem(SYNC_TOKEN_KEY) || "";
}
function setGithubToken(token,remember){
  sessionStorage.removeItem(SYNC_TOKEN_SESSION_KEY);
  localStorage.removeItem(SYNC_TOKEN_KEY);
  if(!token)return;
  if(remember)localStorage.setItem(SYNC_TOKEN_KEY,token);
  else sessionStorage.setItem(SYNC_TOKEN_SESSION_KEY,token);
}
function progressPayload(){
  return {version:1,updated_at:new Date().toISOString(),states:loadJobState()};
}
function hasMeaningfulState(s){
  return !!(s && (s.saved||s.applied||s.hidden||s.applicationStatus||s.appliedDate||s.deadline||s.interviewDate||s.notes));
}
function progressCount(){
  return Object.values(loadJobState()).filter(hasMeaningfulState).length;
}
function mergeStateMaps(localStates={},remoteStates={}){
  const merged={...localStates};
  for(const [id,remote] of Object.entries(remoteStates||{})){
    const local=merged[id];
    if(!local){merged[id]=remote;continue;}
    const lt=Date.parse(local.updatedAt||"1970-01-01T00:00:00Z")||0;
    const rt=Date.parse(remote.updatedAt||"1970-01-01T00:00:00Z")||0;
    if(rt>lt) merged[id]=remote;
  }
  return merged;
}
function mergeRemoteProgress(payload){
  if(!payload || typeof payload!=="object" || !payload.states)return false;
  const local=loadJobState(), merged=mergeStateMaps(local,payload.states);
  const before=JSON.stringify(local), after=JSON.stringify(merged);
  if(before!==after){
    localStorage.setItem(STATE_KEY,after);
    refreshSyncSummary();
    return true;
  }
  return false;
}
async function loadPublishedProgress(){
  try{
    const r=await fetch("data/application-progress.json?ts="+Date.now(),{cache:"no-store"});
    if(!r.ok)return;
    const p=await r.json();
    mergeRemoteProgress(p);
  }catch(e){}
}
function syncStatus(state,text){
  const el=$("#syncStatus");
  if(!el)return;
  el.dataset.state=state;
  el.textContent=text;
}
function syncMessage(text,type="info"){
  const el=$("#syncMessage");
  if(!el)return;
  if(!text){el.className="sync-message hidden";el.textContent="";return;}
  el.className=`sync-message ${type}`;
  el.textContent=text;
}
function refreshSyncSummary(){
  const count=$("#localProgressCount"); if(count)count.textContent=progressCount();
  const cfg=loadSyncConfig(), last=$("#lastSyncAt");
  if(last)last.textContent=cfg.lastSyncAt?new Date(cfg.lastSyncAt).toLocaleString("zh-TW"):"—";
}
function fillSyncForm(){
  const cfg=loadSyncConfig();
  $("#githubOwner").value=cfg.owner||"";
  $("#githubRepo").value=cfg.repo||"";
  $("#githubBranch").value=cfg.branch||"main";
  $("#githubPath").value=cfg.path||"data/application-progress.json";
  $("#rememberToken").checked=!!localStorage.getItem(SYNC_TOKEN_KEY);
  $("#githubToken").value="";
  refreshSyncSummary();
}
function readSyncForm(){
  const old=loadSyncConfig();
  return {
    ...old,
    owner:$("#githubOwner").value.trim(),
    repo:$("#githubRepo").value.trim(),
    branch:$("#githubBranch").value.trim()||"main",
    path:$("#githubPath").value.trim()||"data/application-progress.json",
    rememberToken:$("#rememberToken").checked
  };
}
function githubHeaders(token){
  return {
    "Accept":"application/vnd.github+json",
    "Authorization":`Bearer ${token}`,
    "X-GitHub-Api-Version":"2022-11-28"
  };
}
function bytesToBase64(str){
  const bytes=new TextEncoder().encode(str);
  let binary="";
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(binary);
}
function base64ToUtf8(b64){
  const clean=String(b64||"").replace(/\s/g,"");
  const binary=atob(clean);
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function githubApiUrl(cfg){
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;
}
async function githubGetProgress(cfg,token){
  const url=githubApiUrl(cfg)+`?ref=${encodeURIComponent(cfg.branch||"main")}&ts=${Date.now()}`;
  const r=await fetch(url,{headers:githubHeaders(token),cache:"no-store"});
  if(r.status===404)return {payload:{version:1,updated_at:null,states:{}},sha:null,missing:true};
  if(!r.ok){
    let msg=""; try{msg=(await r.json()).message||""}catch(e){}
    throw new Error(`GitHub GET ${r.status}${msg?": "+msg:""}`);
  }
  const obj=await r.json();
  const payload=JSON.parse(base64ToUtf8(obj.content));
  return {payload,sha:obj.sha,missing:false};
}
async function githubPutProgress(cfg,token,payload,sha){
  const body={
    message:"chore: sync job application progress",
    content:bytesToBase64(JSON.stringify(payload,null,2)),
    branch:cfg.branch||"main"
  };
  if(sha)body.sha=sha;
  const r=await fetch(githubApiUrl(cfg),{
    method:"PUT",
    headers:{...githubHeaders(token),"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  if(!r.ok){
    let msg=""; try{msg=(await r.json()).message||""}catch(e){}
    const err=new Error(`GitHub PUT ${r.status}${msg?": "+msg:""}`);
    err.status=r.status;
    throw err;
  }
  const obj=await r.json();
  return obj.content?.sha||null;
}
async function pullGithubProgress({silent=false}={}){
  const cfg=loadSyncConfig(), token=getGithubToken();
  if(!cfg.owner||!cfg.repo){if(!silent)syncMessage("請先填 GitHub owner 與 repository。","error");return false;}
  if(!token){if(!silent)syncMessage("尚未提供 GitHub token。","error");syncStatus("off","需要 Token");return false;}
  try{
    syncStatus("busy","拉取中…");
    const remote=await githubGetProgress(cfg,token);
    lastRemoteSha=remote.sha;
    const changed=mergeRemoteProgress(remote.payload);
    cfg.lastSyncAt=new Date().toISOString();saveSyncConfig(cfg);
    refreshSyncSummary();render();
    syncStatus("ok","GitHub 已連線");
    if(!silent)syncMessage(changed?"已從 GitHub 拉回較新的進度。":"GitHub 與本機進度已一致。","ok");
    return true;
  }catch(e){
    console.error(e);syncStatus("error","同步錯誤");
    if(!silent)syncMessage(`無法從 GitHub 讀取：${e.message}`,"error");
    return false;
  }
}
async function syncGithubProgress({silent=false,retry=true}={}){
  if(syncInFlight)return false;
  const cfg=loadSyncConfig(), token=getGithubToken();
  if(!cfg.owner||!cfg.repo||!token){
    syncStatus("off",token?"尚未設定":"尚未設定");
    return false;
  }
  syncInFlight=true;
  try{
    syncStatus("busy","同步中…");
    const remote=await githubGetProgress(cfg,token);
    lastRemoteSha=remote.sha;
    const mergedStates=mergeStateMaps(loadJobState(),remote.payload?.states||{});
    localStorage.setItem(STATE_KEY,JSON.stringify(mergedStates));
    const payload={version:1,updated_at:new Date().toISOString(),states:mergedStates};
    lastRemoteSha=await githubPutProgress(cfg,token,payload,remote.sha);
    cfg.lastSyncAt=payload.updated_at;saveSyncConfig(cfg);
    refreshSyncSummary();render();
    syncStatus("ok","GitHub 已同步");
    if(!silent)syncMessage(`同步完成，共 ${Object.values(mergedStates).filter(hasMeaningfulState).length} 筆追蹤資料。`,"ok");
    return true;
  }catch(e){
    console.error(e);
    if(retry && e.status===409){
      syncInFlight=false;
      return syncGithubProgress({silent,retry:false});
    }
    syncStatus("error","同步錯誤");
    if(!silent)syncMessage(`同步失敗：${e.message}`,"error");
    return false;
  }finally{
    syncInFlight=false;
  }
}
function scheduleGithubSync(){
  clearTimeout(syncTimer);
  if(!getGithubToken())return;
  syncStatus("busy","等待同步…");
  syncTimer=setTimeout(()=>syncGithubProgress({silent:true}),1400);
}
function initGithubSyncUI(){
  const cfg=loadSyncConfig();
  const token=getGithubToken();
  syncStatus(token&&cfg.owner&&cfg.repo?"ok":"off",token&&cfg.owner&&cfg.repo?"GitHub 已連線":"尚未設定");
  refreshSyncSummary();
  if(token&&cfg.owner&&cfg.repo){
    pullGithubProgress({silent:true}).then(()=>syncGithubProgress({silent:true}));
  }
}
$("#syncBtn").onclick=()=>{fillSyncForm();syncMessage("");$("#syncDialog").showModal();};
$("#saveAndSync").onclick=async()=>{
  const cfg=readSyncForm();
  if(!cfg.owner||!cfg.repo){syncMessage("請填 owner 與 repository。","error");return;}
  const typed=$("#githubToken").value.trim();
  const existing=getGithubToken();
  const token=typed||existing;
  if(!token){syncMessage("請輸入 fine-grained personal access token。","error");return;}
  saveSyncConfig(cfg);setGithubToken(token,cfg.rememberToken);
  $("#githubToken").value="";
  syncMessage("正在測試連線並同步…","info");
  await syncGithubProgress({silent:false});
};
$("#pullFromGitHub").onclick=async()=>{
  const cfg=readSyncForm();
  const typed=$("#githubToken").value.trim();
  const token=typed||getGithubToken();
  if(!token){syncMessage("請先輸入 GitHub token。","error");return;}
  saveSyncConfig(cfg);setGithubToken(token,cfg.rememberToken);
  $("#githubToken").value="";
  await pullGithubProgress({silent:false});
};
$("#forgetToken").onclick=()=>{
  sessionStorage.removeItem(SYNC_TOKEN_SESSION_KEY);localStorage.removeItem(SYNC_TOKEN_KEY);
  $("#githubToken").value="";$("#rememberToken").checked=false;
  syncStatus("off","尚未設定");syncMessage("已從這個瀏覽器清除 GitHub token。","ok");
};

$("#settingsBtn").onclick=()=>{syncControlsToPrefs();$("#settingsDialog").showModal()};
$("#saveSettings").onclick=()=>{const next=readSettingsForm();if(!next.sectors.length){alert("Academia / Industry 至少勾選一個。");return}prefs=next;savePrefs();$("#scoreFilter").value=String(prefs.min_score);$("#settingsDialog").close();render();};
$("#restoreDefaults").onclick=()=>{prefs=structuredClone(CONFIG.default_preferences);prefs.new_days=CONFIG.app.new_days||7;syncControlsToPrefs()};
$("#resetBtn").onclick=()=>{$("#searchInput").value="";$("#sectorFilter").value="all";$("#scoreFilter").value=String(prefs.min_score);$("#sortFilter").value="score";quickTopic="all";renderQuickTopics();render()};
$("#showAllBtn").onclick=()=>{quickTopic="all";renderQuickTopics();render()};
["searchInput","sectorFilter","scoreFilter","sortFilter"].forEach(id=>{$("#"+id).addEventListener(id==="searchInput"?"input":"change",render)});
loadData().catch(err=>{console.error(err);$("#resultSummary").textContent="載入失敗，請確認檔案已完整上傳到 GitHub Pages。";});
