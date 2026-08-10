from __future__ import annotations
import json, re, hashlib, time, urllib.parse, xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from bs4 import BeautifulSoup

ROOT=Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/'config.json').read_text(encoding='utf-8'))
DATA=ROOT/'data'; JOBS_PATH=DATA/'jobs.json'; STATUS_PATH=DATA/'status.json'; SEED_PATH=DATA/'seed_jobs.json'
HEADERS={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'}
US_STATES={'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'}
FOREIGN=['canada','ontario','quebec','british columbia','alberta','australia','united kingdom','england','scotland','germany','france','netherlands','switzerland','singapore','india','china','taiwan','japan','korea','mexico','brazil']
PLANT_TERMS=['plant','crop','hortic','agric','patholog','fung','microb','biological','biostimul','postharvest','greenhouse','agronom','produce','rhizosphere','soil','seed','field trial']
ROLE_TERMS=['scientist','professor','research','extension','postdoc','faculty','development','pathologist','agronomist','specialist']
SOURCE_PRIORITY={'University Official':0,'Company Official':0,'Greenhouse':0,'Lever':0,'SmartRecruiters':0,'HigherEdJobs':1,'APS Job Board':1,'AcademicJobsOnline':1,'LinkedIn':2,'Indeed':3,'Web Search':4}

def clean(x): return BeautifulSoup(x or '','html.parser').get_text(' ',strip=True)
def domain(url):
    try:return urlparse(url).netloc.lower().replace('www.','')
    except:return ''
def stable_text(s): return re.sub(r'[^a-z0-9]+',' ',(s or '').lower()).strip()
def is_relevant(text):
    t=(text or '').lower(); return any(x in t for x in PLANT_TERMS) and any(x in t for x in ROLE_TERMS)
def clearly_foreign(text):
    t=(text or '').lower(); return any(x in t for x in FOREIGN) and not re.search(r'united states|\busa\b|\bu\.s\.',t)
def infer_location(text):
    m=re.search(r"\b([A-Z][A-Za-z .'\-]+,\s*("+'|'.join(sorted(US_STATES))+r'))\b',text or '')
    if m:return m.group(1)
    m=re.search(r'\b(Remote(?:\s*[-,]\s*)?(?:United States|US|USA|U\.S\.))\b',text or '',re.I)
    return m.group(1) if m else 'United States'
def normalize_location(loc): return clean(loc) or 'United States'
def job_id(j):
    raw='|'.join([stable_text(j.get('title','')),stable_text(j.get('organization','')),stable_text(j.get('location',''))])
    if len(raw.replace('|',''))<8: raw=(j.get('url','') or raw).split('?')[0].lower()
    return hashlib.sha1(raw.encode()).hexdigest()[:18]
def legacy_url_id(url): return hashlib.sha1((url or '').split('?')[0].lower().encode()).hexdigest()[:18]
def source_report(name,count=0,ok=True,note=''): return {'name':name,'count':count,'ok':ok,'note':note}

def parse_jsonld_jobs(soup,base_url,sector,source,group):
    found=[]
    for tag in soup.find_all('script',attrs={'type':'application/ld+json'}):
        try:obj=json.loads(tag.string or tag.get_text() or '{}')
        except:continue
        stack=obj if isinstance(obj,list) else [obj]
        while stack:
            x=stack.pop()
            if isinstance(x,list): stack.extend(x); continue
            if not isinstance(x,dict): continue
            typ=x.get('@type')
            if typ=='JobPosting' or (isinstance(typ,list) and 'JobPosting' in typ):
                org=x.get('hiringOrganization') or {}; org=org if isinstance(org,dict) else {}
                locs=x.get('jobLocation') or []; locs=locs if isinstance(locs,list) else [locs]
                location=''
                for L in locs:
                    if isinstance(L,dict):
                        addr=L.get('address') or {}
                        if isinstance(addr,dict):
                            location=', '.join(str(v) for v in [addr.get('addressLocality'),addr.get('addressRegion'),addr.get('addressCountry')] if v)
                            if location:break
                title=clean(x.get('title','')); desc=clean(x.get('description','')); url=urljoin(base_url,x.get('url') or x.get('sameAs') or base_url)
                if title and is_relevant(title+' '+desc+' '+location) and not clearly_foreign(location):
                    found.append({'title':title[:240],'organization':clean(org.get('name','')),'location':normalize_location(location),'sector':sector,'source':source,'source_group':group,'url':url,'snippet':desc[:1000],'posted_date':str(x.get('datePosted','') or ''),'deadline':str(x.get('validThrough','') or ''),'domain':domain(url),'us_only':True})
            for v in x.values():
                if isinstance(v,(dict,list)):stack.append(v)
    return found

def fetch_page_jsonld(url,sector,source,group):
    r=requests.get(url,headers=HEADERS,timeout=20); r.raise_for_status()
    return parse_jsonld_jobs(BeautifulSoup(r.text,'html.parser'),url,sector,source,group)

def load_existing():
    try:return json.loads(JOBS_PATH.read_text(encoding='utf-8')).get('jobs',[])
    except:return []
def load_seeds():
    try:return json.loads(SEED_PATH.read_text(encoding='utf-8')).get('jobs',[])
    except:return []

def higheredjobs_direct():
    urls=['https://www.higheredjobs.com/faculty/search.cfm?JobCat=49','https://www.higheredjobs.com/faculty/search.cfm?JobCat=231']
    details=[]
    for url in urls:
        r=requests.get(url,headers=HEADERS,timeout=25); r.raise_for_status(); soup=BeautifulSoup(r.text,'html.parser')
        for a in soup.find_all('a',href=True):
            h=urljoin(url,a['href'])
            if 'higheredjobs.com' in domain(h) and 'details.cfm?JobCode=' in h: details.append(h)
    details=list(dict.fromkeys(details))[:90]; rows=[]
    def one(u):
        try:
            got=fetch_page_jsonld(u,'academia','HigherEdJobs','Academic Board')
            if got:return got
            r=requests.get(u,headers=HEADERS,timeout=20);r.raise_for_status();s=BeautifulSoup(r.text,'html.parser')
            h=s.find('h1') or s.find('title'); title=clean(h.get_text()) if h else ''; text=clean(s.get_text(' ',strip=True))
            if title and is_relevant(title+' '+text[:3000]):
                return [{'title':title[:240],'organization':'','location':infer_location(text[:3000]),'sector':'academia','source':'HigherEdJobs','source_group':'Academic Board','url':u,'snippet':text[:900],'posted_date':'','deadline':'','domain':domain(u),'us_only':True}]
        except:pass
        return []
    with ThreadPoolExecutor(max_workers=8) as ex:
        fs=[ex.submit(one,u) for u in details]
        for f in as_completed(fs):rows.extend(f.result())
    return rows

def aps_direct():
    rows=[]
    for url in ['https://jobs.apsnet.org/','https://jobs.apsnet.org/jobs/']:
        try:
            r=requests.get(url,headers=HEADERS,timeout=25);r.raise_for_status();s=BeautifulSoup(r.text,'html.parser')
            rows.extend(parse_jsonld_jobs(s,url,'academia','APS Job Board','Academic Board'))
            links=[]
            for a in s.find_all('a',href=True):
                h=urljoin(url,a['href'])
                if domain(h).endswith('apsnet.org') and '/jobs/' in h and h.rstrip('/') not in [url.rstrip('/')]:links.append(h)
            for h in list(dict.fromkeys(links))[:30]:
                try:rows.extend(fetch_page_jsonld(h,'academia','APS Job Board','Academic Board'))
                except:pass
        except:continue
    return rows

def linkedin_public(keyword):
    url='https://www.linkedin.com/jobs/search/?'+urllib.parse.urlencode({'keywords':keyword,'location':'United States','f_TPR':'r2592000','position':'1','pageNum':'0'})
    r=requests.get(url,headers=HEADERS,timeout=25);r.raise_for_status();s=BeautifulSoup(r.text,'html.parser');rows=[]
    for card in s.select('li'):
        a=card.select_one('a.base-card__full-link') or card.select_one("a[href*='/jobs/view/']")
        if not a:continue
        te=card.select_one('.base-search-card__title') or card.select_one('h3'); oe=card.select_one('.base-search-card__subtitle') or card.select_one('h4'); le=card.select_one('.job-search-card__location'); ti=card.select_one('time')
        title=clean(te.get_text() if te else a.get_text()); org=clean(oe.get_text() if oe else ''); loc=clean(le.get_text() if le else 'United States')
        if not title or not is_relevant(title+' '+org+' '+keyword) or clearly_foreign(loc):continue
        rows.append({'title':title,'organization':org,'location':normalize_location(loc),'sector':'industry','source':'LinkedIn','source_group':'Public Search','url':urljoin(url,a.get('href','')),'snippet':'','posted_date':ti.get('datetime','') if ti else '','deadline':'','domain':'linkedin.com','us_only':True})
    return rows

def indeed_public(keyword):
    url='https://www.indeed.com/jobs?'+urllib.parse.urlencode({'q':keyword,'l':'United States','fromage':'14'})
    r=requests.get(url,headers=HEADERS,timeout=25);r.raise_for_status();s=BeautifulSoup(r.text,'html.parser');rows=[]
    for a in s.select("a.jcs-JobTitle, a[data-jk], a[href*='/viewjob']"):
        title=clean(a.get_text());
        if not title or not is_relevant(title+' '+keyword):continue
        card=a.find_parent(['div','li']); text=clean(card.get_text(' ',strip=True)) if card else title
        rows.append({'title':title,'organization':'','location':infer_location(text),'sector':'industry','source':'Indeed','source_group':'Public Search','url':urljoin('https://www.indeed.com',a.get('href','')),'snippet':text[:700],'posted_date':'','deadline':'','domain':'indeed.com','us_only':True})
    return rows

def bing_rss(query,sector,source_hint=None):
    url='https://www.bing.com/search?format=rss&count=50&q='+urllib.parse.quote(query)
    r=requests.get(url,headers=HEADERS,timeout=25);r.raise_for_status();root=ET.fromstring(r.text);rows=[]
    for it in root.findall('.//item'):
        title=clean(it.findtext('title',''));link=(it.findtext('link','') or '').strip();desc=clean(it.findtext('description',''));pub=it.findtext('pubDate','');text=f'{title} {desc}'
        if not link or not is_relevant(text) or clearly_foreign(text):continue
        d=domain(link)
        if 'linkedin.com' in d:src,grp='LinkedIn','Indexed Search'
        elif 'indeed.com' in d:src,grp='Indeed','Indexed Search'
        elif 'apsnet.org' in d:src,grp='APS Job Board','Academic Board'
        elif 'academicjobsonline.org' in d:src,grp='AcademicJobsOnline','Academic Board'
        elif 'higheredjobs.com' in d:src,grp='HigherEdJobs','Academic Board'
        else:src,grp=(source_hint or 'Web Search'),('Official / Search' if source_hint else 'Web Search')
        rows.append({'title':title[:240],'organization':'','location':infer_location(text),'sector':sector,'source':src,'source_group':grp,'url':link,'snippet':desc[:800],'posted_date':pub,'deadline':'','domain':d,'us_only':True})
    return rows

def company_search(company,career_domain):
    rows=[]
    for q in [f'site:{career_domain} scientist agriculture plant United States',f'"{company}" "research scientist" crop agriculture United States jobs',f'"{company}" field development agriculture United States jobs']:
        try:
            got=bing_rss(q,'industry',company)
            for j in got:
                j['organization']=j.get('organization') or company
                if career_domain in j.get('domain',''):j['source']='Company Official';j['source_group']='Official Career Site'
                else:j['source']=company;j['source_group']='Company Search'
            rows.extend(got)
        except:pass
        time.sleep(.2)
    return rows

def greenhouse_token(url):
    m=re.search(r'(?:boards|job-boards)\.greenhouse\.io/([^/?#]+)/?',url or '');return m.group(1) if m else None
def lever_site(url):
    m=re.search(r'jobs\.lever\.co/([^/?#]+)/?',url or '');return m.group(1) if m else None

def fetch_greenhouse(token):
    r=requests.get(f'https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true',headers=HEADERS,timeout=25);r.raise_for_status();rows=[]
    for j in r.json().get('jobs',[]):
        title=clean(j.get('title',''));loc=clean((j.get('location') or {}).get('name',''));desc=clean(j.get('content',''))
        if not is_relevant(title+' '+loc+' '+desc) or clearly_foreign(loc):continue
        rows.append({'title':title,'organization':token.replace('-',' ').title(),'location':normalize_location(loc),'sector':'industry','source':'Greenhouse','source_group':'Official ATS','url':j.get('absolute_url',''),'snippet':desc[:1000],'posted_date':j.get('updated_at',''),'deadline':'','domain':domain(j.get('absolute_url','')),'us_only':True})
    return rows

def fetch_lever(site):
    r=requests.get(f'https://api.lever.co/v0/postings/{site}?mode=json',headers=HEADERS,timeout=25);r.raise_for_status();rows=[]
    for j in r.json():
        title=clean(j.get('text',''));cats=j.get('categories') or {};loc=clean(cats.get('location',''));desc=clean(j.get('descriptionPlain') or j.get('description') or '')
        if not is_relevant(title+' '+loc+' '+desc) or clearly_foreign(loc):continue
        rows.append({'title':title,'organization':site.replace('-',' ').title(),'location':normalize_location(loc),'sector':'industry','source':'Lever','source_group':'Official ATS','url':j.get('hostedUrl') or j.get('applyUrl') or '','snippet':desc[:1000],'posted_date':str(j.get('createdAt','') or ''),'deadline':'','domain':domain(j.get('hostedUrl','')),'us_only':True})
    return rows

def fetch_smartrecruiters(company_id):
    rows=[];offset=0;base=f'https://api.smartrecruiters.com/v1/companies/{company_id}/postings'
    for _ in range(4):
        r=requests.get(base,params={'country':'us','limit':100,'offset':offset},headers=HEADERS,timeout=25);r.raise_for_status();x=r.json();content=x.get('content',[])
        for p in content:
            title=clean(p.get('name','') or p.get('title',''));loc=p.get('location') or {}
            if isinstance(loc,dict):loc=', '.join(str(v) for v in [loc.get('city'),loc.get('region'),loc.get('country')] if v)
            else:loc=clean(loc)
            if not is_relevant(title+' '+loc+' agriculture crop plant scientist'):continue
            pid=p.get('id') or p.get('uuid');job_url=f'https://jobs.smartrecruiters.com/{company_id}/{pid}' if pid else ''
            rows.append({'title':title,'organization':company_id,'location':normalize_location(loc),'sector':'industry','source':'SmartRecruiters','source_group':'Official ATS','url':job_url,'snippet':'','posted_date':str(p.get('releasedDate','') or ''),'deadline':'','domain':'jobs.smartrecruiters.com','us_only':True})
        total=int(x.get('totalFound',0) or 0);offset+=len(content)
        if not content or offset>=total:break
    return rows

def canonical_key(j):return '|'.join([stable_text(j.get('title','')),stable_text(j.get('organization','')),stable_text(j.get('location',''))])
def merge_duplicates(rows):
    out={}
    for j in rows:
        if not j.get('title') or not j.get('url'):continue
        k=canonical_key(j); k=k if len(k.replace('|',''))>=8 else (j.get('url') or '').split('?')[0].lower();prev=out.get(k)
        if not prev:out[k]=j;continue
        p1=SOURCE_PRIORITY.get(j.get('source'),9);p0=SOURCE_PRIORITY.get(prev.get('source'),9);winner,loser=(j,prev) if p1<p0 else (prev,j)
        alts=list(dict.fromkeys((winner.get('alternate_urls') or [])+[loser.get('url','')]+(loser.get('alternate_urls') or [])));winner['alternate_urls']=[u for u in alts if u and u!=winner.get('url')]
        if not winner.get('organization') and loser.get('organization'):winner['organization']=loser['organization']
        if len(winner.get('snippet',''))<len(loser.get('snippet','')):winner['snippet']=loser['snippet']
        out[k]=winner
    return list(out.values())
def parse_date(s):
    if not s:return None
    try:return datetime.fromisoformat(str(s)[:10]).date()
    except:return None

def main():
    DATA.mkdir(exist_ok=True);today=datetime.now(timezone.utc).date();today_s=today.isoformat();old=load_existing();seeds=load_seeds();old_map={j.get('id'):j for j in old if j.get('id')};rows=[];reports=[];errors=[]
    rows.extend(seeds);reports.append(source_report('Recovery seed',len(seeds),True,'Known current jobs used only as a safety net'))
    for name,func in [('HigherEdJobs direct',higheredjobs_direct),('APS Job Board direct',aps_direct)]:
        try:got=func();rows.extend(got);reports.append(source_report(name,len(got),True))
        except Exception as e:errors.append(f'{name}: {type(e).__name__}');reports.append(source_report(name,0,False,str(e)[:120]))
    total=ok=0
    for kw in CONFIG.get('linkedin_public_searches',[]):
        try:got=linkedin_public(kw);rows.extend(got);total+=len(got);ok+=1
        except Exception as e:errors.append(f"LinkedIn '{kw}': {type(e).__name__}")
        time.sleep(.25)
    reports.append(source_report('LinkedIn public search',total,ok>0,f'{ok}/{len(CONFIG.get("linkedin_public_searches",[]))} searches responded'))
    total=ok=0
    for kw in CONFIG.get('indeed_public_searches',[]):
        try:got=indeed_public(kw);rows.extend(got);total+=len(got);ok+=1
        except Exception as e:errors.append(f"Indeed '{kw}': {type(e).__name__}")
        time.sleep(.25)
    reports.append(source_report('Indeed public search',total,ok>0,f'{ok}/{len(CONFIG.get("indeed_public_searches",[]))} searches responded'))
    total=ok=0
    for spec in CONFIG.get('company_searches',[]):
        try:got=company_search(spec['company'],spec['domain']);rows.extend(got);total+=len(got);ok+=1
        except Exception as e:errors.append(f"{spec['company']}: {type(e).__name__}")
    reports.append(source_report('Company career searches',total,ok>0,f'{ok}/{len(CONFIG.get("company_searches",[]))} companies queried'))
    total=ok=0
    for spec in CONFIG.get('backup_queries',[]):
        try:got=bing_rss(spec['query'],spec['sector'],spec.get('source_hint'));rows.extend(got);total+=len(got);ok+=1
        except Exception as e:errors.append(f"{spec['name']}: {type(e).__name__}")
        time.sleep(.25)
    reports.append(source_report('Indexed fallback searches',total,ok>0,f'{ok}/{len(CONFIG.get("backup_queries",[]))} searches responded'))
    gh=set(CONFIG.get('manual_greenhouse_boards',[]));lv=set(CONFIG.get('manual_lever_sites',[]))
    for j in rows:
        if greenhouse_token(j.get('url','')):gh.add(greenhouse_token(j['url']))
        if lever_site(j.get('url','')):lv.add(lever_site(j['url']))
    gt=lt=0
    for x in sorted(gh):
        try:got=fetch_greenhouse(x);rows.extend(got);gt+=len(got)
        except Exception as e:errors.append(f'Greenhouse {x}: {type(e).__name__}')
    for x in sorted(lv):
        try:got=fetch_lever(x);rows.extend(got);lt+=len(got)
        except Exception as e:errors.append(f'Lever {x}: {type(e).__name__}')
    reports.append(source_report('Greenhouse ATS',gt,True,f'{len(gh)} boards discovered'));reports.append(source_report('Lever ATS',lt,True,f'{len(lv)} sites discovered'))
    total=ok=0
    for company in CONFIG.get('smartrecruiters_companies',[]):
        try:got=fetch_smartrecruiters(company);rows.extend(got);total+=len(got);ok+=1
        except Exception as e:errors.append(f'SmartRecruiters {company}: {type(e).__name__}')
    reports.append(source_report('SmartRecruiters ATS',total,ok>0 if CONFIG.get('smartrecruiters_companies') else True))
    live=merge_duplicates(rows);merged={}
    for j in live:
        j['id']=job_id(j);j['legacy_ids']=list(dict.fromkeys([legacy_url_id(j.get('url',''))]+(j.get('legacy_ids') or [])));prev=old_map.get(j['id'],{});j['first_seen']=prev.get('first_seen',j.get('first_seen',today_s));j['last_seen']=today_s
        if prev.get('deadline') and not j.get('deadline'):j['deadline']=prev['deadline']
        merged[j['id']]=j
    retain=int(CONFIG.get('app',{}).get('retain_old_days',90))
    for j in old:
        jid=j.get('id') or job_id(j);j['id']=jid
        if jid in merged:continue
        dl=parse_date(j.get('deadline',''));last=parse_date(j.get('last_seen','') or j.get('first_seen',''))
        if dl and (today-dl).days>14:continue
        if last is None or (today-last).days<=retain:merged[jid]=j
    jobs=list(merged.values());jobs.sort(key=lambda j:(j.get('first_seen',''),j.get('source','')),reverse=True)
    if JOBS_PATH.exists():
        try:(DATA/'jobs.previous.json').write_text(JOBS_PATH.read_text(encoding='utf-8'),encoding='utf-8')
        except:pass
    sc={};sec={'industry':0,'academia':0}
    for j in jobs:sc[j.get('source','Unknown')]=sc.get(j.get('source','Unknown'),0)+1;sec[j.get('sector','industry')]=sec.get(j.get('sector','industry'),0)+1
    JOBS_PATH.write_text(json.dumps({'jobs':jobs},ensure_ascii=False,indent=2),encoding='utf-8');STATUS_PATH.write_text(json.dumps({'version':7,'last_updated':datetime.now(timezone.utc).isoformat(),'job_count':len(jobs),'sector_counts':sec,'source_counts':sc,'sources':reports,'errors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
    print(f'v7 saved {len(jobs)} jobs: {sec}. Sources: {sc}. Non-fatal errors: {len(errors)}')
if __name__=='__main__':main()
