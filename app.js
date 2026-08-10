
const PREF_KEY="plantScienceCareerRadarPrefsV9";
const STATE_KEY="plantScienceCareerRadarJobStateV9";
const LEGACY_KEYS=["plantScienceCareerRadarJobStateV8","plantScienceCareerRadarJobStateV7","plantScienceCareerRadarJobStateV6","plantScienceCareerRadarJobStateV5","plantScienceCareerRadarJobStateV4","plantScienceCareerRadarJobStateV3"];
const SYNC_CONFIG_KEY="plantScienceCareerRadarGithubSyncV9";
const SYNC_TOKEN_KEY="plantScienceCareerRadarGithubTokenV9";
const SYNC_TOKEN_SESSION_KEY="plantScienceCareerRadarGithubTokenSessionV9";

let CONFIG=null,JOBS=[],STATUS={},prefs=null,stage="new",quickTopic="all",editingJobId=null,syncTimer=null,syncInFlight=false;
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function norm(s=""){return String(s).toLowerCase().replace(/[–—]/g,"-")}

function decodeAndStripHtml(value=""){
  let text=String(value||"");
  for(let i=0;i<3;i++){
    const ta=document.createElement("textarea");
    ta.innerHTML=text;
    const decoded=ta.value;
    const div=document.createElement("div");
    div.innerHTML=decoded;
    const stripped=(div.textContent||div.innerText||decoded);
    if(stripped===text)break;
    text=stripped;
  }
  return text.replace(/\s+/g," ").replace(/\s+([,.;:])/g,"$1").trim();
}
function makeSummaryBullets(raw,maxItems=5){
  const text=decodeAndStripHtml(raw);
  if(!text)return ["原始來源未提供摘要，請點「查看職缺」閱讀完整內容。"];

  const labels=/(Title|Executive Area|College\/School\/MBU|Department|Work Location|Job Type|Position|Responsibilities|Qualifications|About the job|Job Summary|What You(?:’|')?ll Do|Requirements)\s*:\s*/gi;
  let normalized=text.replace(labels,"\n$1: ");
  let parts=normalized
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(x=>x.trim())
    .filter(Boolean);

  const output=[],seen=new Set();
  for(let p of parts){
    p=p.replace(/^[-–—•·]\s*/,"").trim();
    if(!p||p.length<12)continue;
    if(p.length>260)p=p.slice(0,257).trim()+"…";
    const key=p.toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);
    output.push(p);
    if(output.length>=maxItems)break;
  }
  return output.length?output:[text.slice(0,260)+(text.length>260?"…":"")];
}
function cleanTitle(value=""){
  return decodeAndStripHtml(value).replace(/&amp;/gi,"&");
}
function clone(o){return JSON.parse(JSON.stringify(o))}
function uid(j){return j.id||`${j.url}|${j.title}|${j.organization}`}
function today(){return new Date().toISOString().slice(0,10)}
function daysSince(d){if(!d)return 999;const x=new Date(d);return Number.isNaN(+x)?999:Math.floor((Date.now()-x.getTime())/86400000)}

function migrateLegacy(){
  if(localStorage.getItem(STATE_KEY))return;
  for(const k of LEGACY_KEYS){
    const raw=localStorage.getItem(k); if(!raw)continue;
    try{
      const x=JSON.parse(raw)||{}, now=new Date().toISOString();
      Object.values(x).forEach(v=>{if(v&&!v.updatedAt)v.updatedAt=now});
      localStorage.setItem(STATE_KEY,JSON.stringify(x)); return;
    }catch(e){}
  }
}
function loadState(){try{return JSON.parse(localStorage.getItem(STATE_KEY))||{}}catch(e){return{}}}
function getState(id,aliases=[]){const st=loadState();if(st[id])return st[id];for(const a of aliases||[]){if(st[a])return st[a]}return {}}
function setState(id,patch){
  const s=loadState(); s[id]={...(s[id]||{}),...patch,updatedAt:new Date().toISOString()};
  localStorage.setItem(STATE_KEY,JSON.stringify(s)); refreshSyncSummary(); scheduleGithubSync();
}
function loadPrefs(){
  try{
    const s=JSON.parse(localStorage.getItem(PREF_KEY));
    return s?{...clone(CONFIG.default_preferences),...s,topics:{...CONFIG.default_preferences.topics,...(s.topics||{})}}:clone(CONFIG.default_preferences);
  }catch(e){return clone(CONFIG.default_preferences)}
}
function savePrefs(){localStorage.setItem(PREF_KEY,JSON.stringify(prefs))}

function roleMatches(j){
  const t=norm(`${j.title} ${j.snippet||""}`);
  return Object.entries(CONFIG.role_keywords).filter(([_,ks])=>ks.some(k=>t.includes(norm(k)))).map(([r])=>r)
}
function topicMatches(j){
  const t=norm(`${j.title} ${j.snippet||""} ${(j.tags||[]).join(" ")}`);
  return Object.entries(CONFIG.topic_keywords).filter(([_,ks])=>ks.some(k=>t.includes(norm(k)))).map(([r])=>r)
}
function scoreJob(j){
  const t=norm(`${j.title} ${j.organization||""} ${j.snippet||""} ${(j.tags||[]).join(" ")}`);
  let score=28;
  topicMatches(j).forEach(tp=>{const w=prefs.topics[tp]||"ignore";score+=w==="high"?12:w==="medium"?6:0});
  const roles=roleMatches(j); if(roles.some(r=>prefs.roles.includes(r)))score+=14; else if(roles.length)score-=4;
  if(prefs.sectors.includes(j.sector))score+=8;else score-=40;
  (prefs.exclude_keywords||[]).forEach(k=>{if(k&&t.includes(norm(k)))score-=35});
  if(["Official / ATS","Greenhouse","Lever"].includes(j.source_group))score+=5;
  if(j.source==="LinkedIn"||j.source==="Indeed")score+=1;
  if(j.us_only===false)score-=100;
  return Math.max(0,Math.min(100,score))
}
function jobStage(j){
  const s=getState(uid(j),j.legacy_ids||[]);
  if(s.hidden)return"hidden";
  if(s.applied)return"applied";
  if(s.saved)return"saved";
  return"new"
}

async function loadData(){
  const [c,j,s]=await Promise.all([
    fetch("config.json?ts="+Date.now()).then(r=>r.json()),
    fetch("data/jobs.json?ts="+Date.now()).then(r=>r.json()).catch(()=>({jobs:[]})),
    fetch("data/status.json?ts="+Date.now()).then(r=>r.json()).catch(()=>({}))
  ]);
  CONFIG=c;JOBS=j.jobs||[];STATUS=s||{};migrateLegacy();prefs=loadPrefs();
  buildSettings();syncSettingsForm();buildSourceFilters();renderQuickTopics();renderStatus();bindTabs();initGithubSyncUI();render()
}
function buildSettings(){
  $("#roleSettings").innerHTML="";
  Object.keys(CONFIG.role_keywords).forEach(r=>{
    const l=document.createElement("label");l.className="check";l.innerHTML=`<input type="checkbox" name="role" value="${esc(r)}"> ${esc(r)}`;$("#roleSettings").appendChild(l)
  });
  $("#topicSettings").innerHTML="";
  Object.keys(CONFIG.topic_keywords).forEach(tp=>{
    const d=document.createElement("div");d.className="weight-row";
    d.innerHTML=`<div class="weight-label"><strong>${esc(tp)}</strong><small>${esc(CONFIG.topic_keywords[tp].slice(0,3).join(" · "))}</small></div><select data-topic="${esc(tp)}"><option value="high">高</option><option value="medium">普通</option><option value="ignore">忽略</option></select>`;
    $("#topicSettings").appendChild(d)
  })
}
function syncSettingsForm(){
  $$('input[name="sector"]').forEach(x=>x.checked=prefs.sectors.includes(x.value));
  $$('input[name="role"]').forEach(x=>x.checked=prefs.roles.includes(x.value));
  $$("[data-topic]").forEach(x=>x.value=prefs.topics[x.dataset.topic]||"ignore");
  $("#excludeKeywords").value=(prefs.exclude_keywords||[]).join(", ");
  $("#defaultMinScore").value=String(prefs.min_score??55);$("#newDays").value=String(prefs.new_days||CONFIG.app.new_days||7);
  $("#scoreFilter").value=String(prefs.min_score??55)
}
function readSettings(){
  return {...prefs,
    sectors:$$('input[name="sector"]:checked').map(x=>x.value),
    roles:$$('input[name="role"]:checked').map(x=>x.value),
    topics:Object.fromEntries($$("[data-topic]").map(x=>[x.dataset.topic,x.value])),
    exclude_keywords:$("#excludeKeywords").value.split(",").map(x=>x.trim()).filter(Boolean),
    min_score:Number($("#defaultMinScore").value),
    new_days:Number($("#newDays").value)
  }
}
function allSources(){
  return [...new Set(JOBS.map(j=>j.source).filter(Boolean))].sort((a,b)=>a.localeCompare(b))
}
function buildSourceFilters(){
  const sources=allSources(),sel=$("#sourceFilter");sel.innerHTML='<option value="all">全部來源</option>';
  sources.forEach(s=>{const o=document.createElement("option");o.value=s;o.textContent=s;sel.appendChild(o)});
  renderSourceChips()
}
function renderSourceChips(){
  const box=$("#sourceChips");box.innerHTML="";
  const counts={};JOBS.forEach(j=>counts[j.source]=(counts[j.source]||0)+1);
  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([s,n])=>{
    const b=document.createElement("button");b.className="source-chip"+($("#sourceFilter").value===s?" active":"");b.innerHTML=`${esc(s)} <b>${n}</b>`;
    b.onclick=()=>{$("#sourceFilter").value=s;renderSourceChips();render()};box.appendChild(b)
  })
}
function renderQuickTopics(){
  const box=$("#quickTopics");box.innerHTML="";
  ["all",...Object.keys(CONFIG.topic_keywords)].forEach(tp=>{
    const b=document.createElement("button");b.className="topic-pill"+(quickTopic===tp?" active":"");b.textContent=tp==="all"?"全部領域":tp;
    b.onclick=()=>{quickTopic=tp;renderQuickTopics();render()};box.appendChild(b)
  })
}
function bindTabs(){
  $$(".pipeline-tab").forEach(b=>b.onclick=()=>{stage=b.dataset.stage;$$(".pipeline-tab").forEach(x=>x.classList.toggle("active",x===b));render()})
}
function renderStatus(){
  $("#lastUpdated").textContent=STATUS.last_updated?new Date(STATUS.last_updated).toLocaleString("zh-TW",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"尚未更新";
  const errs=STATUS.errors||[];
  if(errs.length){$("#sourceAlert").classList.remove("hidden");$("#sourceAlert").innerHTML=`<strong>部分來源未成功：</strong> ${esc(errs.slice(0,5).join("；"))}${errs.length>5?`；另 ${errs.length-5} 個來源錯誤`:""}。其他來源與舊資料仍會保留。`}else $("#sourceAlert").classList.add("hidden");
  const vs=$("#validationSummary");
  if(vs){
    const v=STATUS.validation||{}, current=Number(v.rejected_current_count||0), old=Number(v.rejected_old_count||0);
    vs.innerHTML=`品質檢查：本輪排除 <strong>${current}</strong> 筆非職缺${old?`，並從舊資料庫清除 <strong>${old}</strong> 筆誤判`:""}。`;
  }
  const health=$("#sourceHealth");if(health){health.innerHTML="";(STATUS.sources||[]).forEach(s=>{const d=document.createElement("div");d.className=`health-item ${s.ok?"ok":"bad"}`;d.innerHTML=`<div class="health-top"><strong>${esc(s.name||"Source")}</strong><b>${Number(s.count||0)} 筆</b></div><small>${esc(s.note||(s.ok?"已完成":"本次失敗"))}</small>`;health.appendChild(d)})}
}
function filtered(){
  const q=norm($("#searchInput").value.trim()),sector=$("#sectorFilter").value,source=$("#sourceFilter").value,min=Number($("#scoreFilter").value);
  let a=JOBS.map(j=>({...j,_score:scoreJob(j),_topics:topicMatches(j),_roles:roleMatches(j)})).filter(j=>{
    if(jobStage(j)!==stage)return false;
    if(!prefs.sectors.includes(j.sector))return false;
    if(sector!=="all"&&j.sector!==sector)return false;
    if(source!=="all"&&j.source!==source)return false;
    if(j._score<min)return false;
    if(quickTopic!=="all"&&!j._topics.includes(quickTopic))return false;
    if(q&&!norm(`${j.title} ${j.organization} ${j.location} ${j.snippet} ${(j.tags||[]).join(" ")}`).includes(q))return false;
    return true
  });
  const sort=$("#sortFilter").value;
  a.sort((x,y)=>{
    if(sort==="new")return new Date(y.first_seen||0)-new Date(x.first_seen||0)||y._score-x._score;
    if(sort==="source")return (x.source||"").localeCompare(y.source||"")||y._score-x._score;
    if(sort==="title")return (x.title||"").localeCompare(y.title||"");
    return y._score-x._score||new Date(y.first_seen||0)-new Date(x.first_seen||0)
  });return a
}
function counts(){
  const c={new:0,saved:0,applied:0,hidden:0,industry:0,academia:0,newWeek:0};
  JOBS.forEach(j=>{c[jobStage(j)]++; if(j.sector==="industry")c.industry++;if(j.sector==="academia")c.academia++;if(daysSince(j.first_seen)<=Number(prefs.new_days||7))c.newWeek++});return c
}
function render(){
  const c=counts();$("#industryCount").textContent=c.industry;$("#academiaCount").textContent=c.academia;$("#newCount").textContent=c.newWeek;
  ["new","saved","applied","hidden"].forEach(k=>$("#"+k+"TabCount").textContent=c[k]);
  const titles={new:"新職缺",saved:"收藏",applied:"已申請",hidden:"隱藏"};$("#stageTitle").textContent=titles[stage];
  const arr=filtered();$("#resultSummary").textContent=`顯示 ${arr.length} 筆｜Industry ${arr.filter(x=>x.sector==="industry").length}｜Academia ${arr.filter(x=>x.sector==="academia").length}`;
  $("#emptyState").classList.toggle("hidden",arr.length>0);$("#jobsGrid").innerHTML="";
  arr.forEach(j=>renderCard(j));
}
function renderCard(j){
  const node=$("#jobTemplate").content.cloneNode(true),id=uid(j),st=getState(id,j.legacy_ids||[]),badges=node.querySelector(".badges");
  const badge=(t,cls="")=>{const x=document.createElement("span");x.className=`badge ${cls}`;x.textContent=t;badges.appendChild(x)};
  badge(j.sector==="industry"?"Industry":"Academia",j.sector);badge(j.source,"source");
  if(daysSince(j.first_seen)<=Number(prefs.new_days||7))badge("NEW","new");
  if(daysSince(j.last_seen)>Number(CONFIG.app.stale_after_days||21))badge("可能已過期","stale");
  node.querySelector(".score-value").textContent=j._score;
  node.querySelector(".job-title").textContent=cleanTitle(j.title||"Untitled");
  node.querySelector(".org").textContent=cleanTitle(j.organization||"");
  node.querySelector(".location").textContent=cleanTitle(j.location||"United States");

  const list=node.querySelector(".snippet-list");
  makeSummaryBullets(j.snippet||"",5).forEach(item=>{
    const li=document.createElement("li");
    li.textContent=item;
    list.appendChild(li);
  });

  const mr=node.querySelector(".match-row");
  [...j._topics,...j._roles].slice(0,6).forEach(m=>{
    const x=document.createElement("span");x.className="match";x.textContent=m;mr.appendChild(x)
  });

  const meta=node.querySelector(".job-meta");
  meta.innerHTML="";
  [
    ["來源",j.source_group||j.source||"Web"],
    ["首次發現",j.first_seen||"—"],
    ["最近看到",j.last_seen||"—"],
    ["網站",j.domain||"—"]
  ].forEach(([label,value])=>{
    const d=document.createElement("div");
    d.className="meta-item";
    const l=document.createElement("span");
    l.className="meta-label";
    l.textContent=label+"：";
    d.appendChild(l);
    d.appendChild(document.createTextNode(cleanTitle(value)));
    meta.appendChild(d);
  });
  node.querySelector(".open-link").href=j.url;
  const save=node.querySelector(".save-btn"),applied=node.querySelector(".applied-btn"),manage=node.querySelector(".manage-btn"),hide=node.querySelector(".hide-btn");
  if(st.saved){save.textContent="♥ 已收藏";save.classList.add("saved")}
  if(st.applied){applied.textContent="✓ 已申請";applied.classList.add("applied");manage.classList.remove("hidden")}
  save.onclick=()=>{setState(id,{saved:!getState(id,j.legacy_ids||[]).saved,hidden:false});render()};
  applied.onclick=()=>{
    const now=getState(id,j.legacy_ids||[]);
    if(now.applied){openApplication(j);return}
    setState(id,{applied:true,saved:false,hidden:false,applicationStatus:"Applied",appliedDate:today()});render()
  };
  manage.onclick=()=>openApplication(j);
  hide.onclick=()=>{setState(id,{hidden:true,saved:false});render()};
  if(stage==="hidden"){hide.textContent="移回新職缺";hide.onclick=()=>{setState(id,{hidden:false});render()}}
  $("#jobsGrid").appendChild(node)
}
function openApplication(j){
  editingJobId=uid(j);const s=getState(editingJobId,j.legacy_ids||[]);$("#applicationDialogTitle").textContent=j.title||"管理申請";$("#applicationDialogOrg").textContent=j.organization||"";
  $("#applicationStatus").value=s.applicationStatus||"Applied";$("#appliedDate").value=s.appliedDate||today();$("#deadline").value=s.deadline||"";$("#interviewDate").value=s.interviewDate||"";$("#applicationNotes").value=s.notes||"";$("#applicationDialog").showModal()
}

/* GitHub sync */
function defaultSync(){return{owner:"disawe-r00633013",repo:"plant-science-job-radar-data",branch:"main",path:"data/application-progress.json",rememberToken:false,lastSyncAt:null}}
function loadSync(){try{return{...defaultSync(),...(JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY))||{})}}catch(e){return defaultSync()}}
function saveSync(c){localStorage.setItem(SYNC_CONFIG_KEY,JSON.stringify(c))}
function token(){return sessionStorage.getItem(SYNC_TOKEN_SESSION_KEY)||localStorage.getItem(SYNC_TOKEN_KEY)||""}
function storeToken(t,remember){sessionStorage.removeItem(SYNC_TOKEN_SESSION_KEY);localStorage.removeItem(SYNC_TOKEN_KEY);if(t)(remember?localStorage:sessionStorage).setItem(remember?SYNC_TOKEN_KEY:SYNC_TOKEN_SESSION_KEY,t)}
function ghHeaders(t){return{"Accept":"application/vnd.github+json","Authorization":`Bearer ${t}`,"X-GitHub-Api-Version":"2022-11-28"}}
function ghUrl(c){return`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path.split("/").map(encodeURIComponent).join("/")}`}
function b64e(s){const b=new TextEncoder().encode(s);let z="";for(let i=0;i<b.length;i+=32768)z+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(z)}
function b64d(s){const z=atob(String(s||"").replace(/\s/g,""));return new TextDecoder().decode(Uint8Array.from(z,c=>c.charCodeAt(0)))}
function mergeMaps(a={},b={}){const o={...a};for(const[id,r]of Object.entries(b)){if(!o[id]){o[id]=r;continue}const lt=Date.parse(o[id].updatedAt||0)||0,rt=Date.parse(r.updatedAt||0)||0;if(rt>lt)o[id]=r}return o}
async function ghGet(c,t){
  const r=await fetch(ghUrl(c)+`?ref=${encodeURIComponent(c.branch)}&ts=${Date.now()}`,{headers:ghHeaders(t),cache:"no-store"});
  if(r.status===404)return{states:{},sha:null};if(!r.ok)throw new Error(`GitHub GET ${r.status}: ${(await r.json().catch(()=>({}))).message||""}`);
  const x=await r.json();return{states:(JSON.parse(b64d(x.content)).states||{}),sha:x.sha}
}
async function ghPut(c,t,states,sha){
  const body={message:"chore: sync job application progress",content:b64e(JSON.stringify({version:1,updated_at:new Date().toISOString(),states},null,2)),branch:c.branch};if(sha)body.sha=sha;
  const r=await fetch(ghUrl(c),{method:"PUT",headers:{...ghHeaders(t),"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok){const e=new Error(`GitHub PUT ${r.status}: ${(await r.json().catch(()=>({}))).message||""}`);e.status=r.status;throw e}
}
function syncStatus(state,text){const e=$("#syncStatus");e.dataset.state=state;e.textContent=text}
function syncMessage(text,type="info"){const e=$("#syncMessage");if(!text){e.className="sync-message hidden";e.textContent="";return}e.className=`sync-message ${type}`;e.textContent=text}
function meaningful(s){return s&&(s.saved||s.applied||s.hidden||s.notes||s.applicationStatus||s.deadline||s.interviewDate)}
function refreshSyncSummary(){const c=loadSync();$("#localProgressCount").textContent=Object.values(loadState()).filter(meaningful).length;$("#lastSyncAt").textContent=c.lastSyncAt?new Date(c.lastSyncAt).toLocaleString("zh-TW"):"—"}
function fillSync(){const c=loadSync();$("#githubOwner").value=c.owner;$("#githubRepo").value=c.repo;$("#githubBranch").value=c.branch;$("#githubPath").value=c.path;$("#rememberToken").checked=!!localStorage.getItem(SYNC_TOKEN_KEY);$("#githubToken").value="";refreshSyncSummary()}
function readSync(){const c=loadSync();return{...c,owner:$("#githubOwner").value.trim(),repo:$("#githubRepo").value.trim(),branch:$("#githubBranch").value.trim()||"main",path:$("#githubPath").value.trim()||"data/application-progress.json",rememberToken:$("#rememberToken").checked}}
async function pullSync(silent=false){
  const c=loadSync(),t=token();if(!t||!c.owner||!c.repo){if(!silent)syncMessage("請先設定 repository 與 token。","error");return false}
  try{syncStatus("busy","拉取中…");const r=await ghGet(c,t),m=mergeMaps(loadState(),r.states);localStorage.setItem(STATE_KEY,JSON.stringify(m));c.lastSyncAt=new Date().toISOString();saveSync(c);refreshSyncSummary();render();syncStatus("ok","GitHub 已連線");if(!silent)syncMessage("已合併 GitHub 與本機進度。","ok");return true}catch(e){syncStatus("error","同步錯誤");if(!silent)syncMessage(e.message,"error");return false}
}
async function pushSync(silent=false,retry=true){
  if(syncInFlight)return false;const c=loadSync(),t=token();if(!t||!c.owner||!c.repo)return false;syncInFlight=true;
  try{syncStatus("busy","同步中…");const r=await ghGet(c,t),m=mergeMaps(loadState(),r.states);localStorage.setItem(STATE_KEY,JSON.stringify(m));await ghPut(c,t,m,r.sha);c.lastSyncAt=new Date().toISOString();saveSync(c);refreshSyncSummary();render();syncStatus("ok","GitHub 已同步");if(!silent)syncMessage("同步完成。","ok");return true}
  catch(e){if(retry&&e.status===409){syncInFlight=false;return pushSync(silent,false)}syncStatus("error","同步錯誤");if(!silent)syncMessage(e.message,"error");return false}
  finally{syncInFlight=false}
}
function scheduleGithubSync(){clearTimeout(syncTimer);if(!token())return;syncStatus("busy","等待同步…");syncTimer=setTimeout(()=>pushSync(true),1200)}
function initGithubSyncUI(){const c=loadSync();syncStatus(token()&&c.owner&&c.repo?"ok":"off",token()&&c.owner&&c.repo?"GitHub 已連線":"尚未設定");refreshSyncSummary();if(token()&&c.owner&&c.repo)pullSync(true)}

$("#settingsBtn").onclick=()=>{syncSettingsForm();$("#settingsDialog").showModal()};
$("#saveSettings").onclick=()=>{const n=readSettings();if(!n.sectors.length){alert("Industry / Academia 至少選一個");return}prefs=n;savePrefs();$("#scoreFilter").value=String(prefs.min_score);$("#settingsDialog").close();render()};
$("#restoreDefaults").onclick=()=>{prefs=clone(CONFIG.default_preferences);prefs.new_days=CONFIG.app.new_days||7;syncSettingsForm()};
$("#showAllBtn").onclick=()=>{quickTopic="all";renderQuickTopics();render()};
$("#clearSourceBtn").onclick=()=>{$("#sourceFilter").value="all";renderSourceChips();render()};
["searchInput","sectorFilter","scoreFilter","sortFilter"].forEach(id=>$("#"+id).addEventListener(id==="searchInput"?"input":"change",render));
$("#sourceFilter").addEventListener("change",()=>{renderSourceChips();render()});

$("#saveApplication").onclick=()=>{if(!editingJobId)return;setState(editingJobId,{applied:true,saved:false,hidden:false,applicationStatus:$("#applicationStatus").value,appliedDate:$("#appliedDate").value,deadline:$("#deadline").value,interviewDate:$("#interviewDate").value,notes:$("#applicationNotes").value.trim()});$("#applicationDialog").close();render()};
$("#moveBackSaved").onclick=()=>{if(!editingJobId)return;setState(editingJobId,{applied:false,saved:true,applicationStatus:""});$("#applicationDialog").close();render()};

$("#syncBtn").onclick=()=>{fillSync();syncMessage("");$("#syncDialog").showModal()};
$("#saveAndSync").onclick=async()=>{const c=readSync(),typed=$("#githubToken").value.trim(),t=typed||token();if(!c.owner||!c.repo){syncMessage("請填 owner 與 repository。","error");return}if(!t){syncMessage("請輸入 token。","error");return}saveSync(c);storeToken(t,c.rememberToken);$("#githubToken").value="";await pushSync(false)};
$("#pullFromGitHub").onclick=async()=>{const c=readSync(),typed=$("#githubToken").value.trim(),t=typed||token();if(!t){syncMessage("請輸入 token。","error");return}saveSync(c);storeToken(t,c.rememberToken);$("#githubToken").value="";await pullSync(false)};
$("#forgetToken").onclick=()=>{sessionStorage.removeItem(SYNC_TOKEN_SESSION_KEY);localStorage.removeItem(SYNC_TOKEN_KEY);$("#githubToken").value="";$("#rememberToken").checked=false;syncStatus("off","尚未設定");syncMessage("已清除這台裝置的 token。","ok")};

loadData().catch(e=>{console.error(e);$("#resultSummary").textContent="載入失敗，請確認 v6 檔案已完整上傳。"});
