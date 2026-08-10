from __future__ import annotations
import json, re, hashlib, time, urllib.parse, xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse
import requests
from bs4 import BeautifulSoup

ROOT=Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/"config.json").read_text(encoding="utf-8"))
DATA=ROOT/"data"; JOBS=DATA/"jobs.json"; STATUS=DATA/"status.json"
HEADERS={"User-Agent":"Mozilla/5.0 (compatible; PlantScienceCareerRadar/6.0; GitHub Actions)"}
US_STATES={"AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"}
SOURCE_PRIORITY={"Greenhouse":0,"Lever":0,"Company / University site":1,"HigherEdJobs":2,"AcademicJobsOnline":2,"LinkedIn":3,"Indeed":4,"Web Search":5}
ACADEMIC_HINTS=["university","college","faculty","professor","postdoctoral","postdoc","extension","academic"]
INDUSTRY_HINTS=["scientist","company","inc.","llc","corporation","crop protection","product development","r&d","research and development"]
PLANT_TERMS=["plant","crop","hortic","agric","patholog","fung","microb","biological","biostimul","postharvest","greenhouse","agronom","produce","rhizosphere"]
ROLE_TERMS=["scientist","professor","research","extension","postdoc","faculty","development","pathologist"]
FOREIGN=["canada","ontario","quebec","british columbia","alberta","australia","united kingdom","england","scotland","germany","france","netherlands","switzerland","singapore","india","china","taiwan","japan","korea","mexico","brazil"]

def clean(x):
    return BeautifulSoup(x or "","html.parser").get_text(" ",strip=True)
def dom(url):
    try:return urlparse(url).netloc.lower().replace("www.","")
    except:return""
def stable(s):return re.sub(r"[^a-z0-9]+"," ",(s or "").lower()).strip()
def source_for(url, hint=""):
    d=dom(url)
    if "linkedin.com" in d:return "LinkedIn","LinkedIn"
    if "indeed.com" in d:return "Indeed","Indeed"
    if "higheredjobs.com" in d:return "HigherEdJobs","Academic Board"
    if "academicjobsonline.org" in d:return "AcademicJobsOnline","Academic Board"
    if "greenhouse.io" in d:return "Greenhouse","Official / ATS"
    if "lever.co" in d:return "Lever","Official / ATS"
    if hint in {"LinkedIn","Indeed","HigherEdJobs","AcademicJobsOnline"}:return hint,"Academic Board" if "Jobs" in hint and hint!="LinkedIn" else hint
    return "Company / University site","Official / ATS"
def relevant(text):
    t=text.lower();return any(x in t for x in PLANT_TERMS) and any(x in t for x in ROLE_TERMS)
def sector_for(text, requested):
    t=text.lower();a=sum(x in t for x in ACADEMIC_HINTS);i=sum(x in t for x in INDUSTRY_HINTS)
    if a>=2 and a>i:return"academia"
    if i>=2 and i>a:return"industry"
    return requested
def us_location(text):
    t=" "+text+" "
    if re.search(r"\bUnited States\b|\bUSA\b|\bU\.S\.\b|Remote\s*[-,]?\s*(US|USA|United States)",text,re.I):return True
    if re.search(r",\s*("+ "|".join(sorted(US_STATES)) +r")\b",text):return True
    return False
def foreign(text):
    t=text.lower()
    return any(x in t for x in FOREIGN) and not re.search(r"united states|\busa\b|\bu\.s\.",t)
def infer_location(text):
    m=re.search(r"\b([A-Z][A-Za-z .'\-]+,\s*("+"|".join(sorted(US_STATES))+r"))\b",text)
    if m:return m.group(1)
    m=re.search(r"\b(Remote(?:\s*[-,]\s*)?(?:United States|US|USA|U\.S\.))\b",text,re.I)
    return m.group(1) if m else "United States"
def infer_org(title, url):
    parts=[p.strip() for p in re.split(r"\s+[|\-–—]\s+",title) if p.strip()]
    for p in parts[1:]:
        if any(x in p.lower() for x in ["university","college","institute","company","inc","llc","ag","science","bioscience","syngenta","corteva","bayer","basf","fmc","valent","upl"]):
            return p[:140]
    d=dom(url)
    if d:
        host=d.split(".")[0].replace("-"," ")
        if host not in {"jobs","careers","boards","www","linkedin","indeed"}:return host.title()
    return ""
def rss_search(spec):
    url="https://www.bing.com/search?format=rss&count=50&q="+urllib.parse.quote(spec["query"])
    r=requests.get(url,headers=HEADERS,timeout=30);r.raise_for_status()
    root=ET.fromstring(r.text);out=[]
    for it in root.findall(".//item"):
        title=clean(it.findtext("title","")); link=(it.findtext("link","") or "").strip(); desc=clean(it.findtext("description","")); pub=it.findtext("pubDate","")
        text=f"{title} {desc}"
        if not link or not relevant(text) or foreign(text):continue
        src,grp=source_for(link,spec.get("source_hint",""))
        # For explicit US queries we tolerate unknown location, but reject clearly foreign.
        out.append({"title":title[:240],"url":link,"snippet":desc[:800],"organization":infer_org(title,link),
                    "location":infer_location(text),"sector":sector_for(text,spec["sector"]),"source":src,"source_group":grp,
                    "domain":dom(link),"posted_date":pub,"us_only":True,"query_name":spec["name"]})
    return out
def greenhouse_token(url):
    m=re.search(r"(?:boards|job-boards)\.greenhouse\.io/([^/?#]+)/?",url)
    return m.group(1) if m else None
def lever_site(url):
    m=re.search(r"jobs\.lever\.co/([^/?#]+)/?",url)
    return m.group(1) if m else None
def fetch_greenhouse(token):
    r=requests.get(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true",headers=HEADERS,timeout=30)
    r.raise_for_status();x=r.json();out=[]
    org=token.replace("-"," ").title()
    for j in x.get("jobs",[]):
        title=clean(j.get("title",""));loc=clean((j.get("location") or {}).get("name",""));content=clean(j.get("content",""))
        text=f"{title} {loc} {content}"
        if not relevant(text):continue
        if not us_location(loc) and foreign(loc):continue
        if not us_location(loc) and loc and not any(s in loc for s in US_STATES):continue
        out.append({"title":title,"url":j.get("absolute_url"),"snippet":content[:900],"organization":org,"location":loc or "United States",
                    "sector":"industry","source":"Greenhouse","source_group":"Official / ATS","domain":dom(j.get("absolute_url","")),
                    "posted_date":j.get("updated_at",""),"us_only":True,"query_name":f"Greenhouse:{token}"})
    return out
def fetch_lever(site):
    r=requests.get(f"https://api.lever.co/v0/postings/{site}?mode=json",headers=HEADERS,timeout=30)
    r.raise_for_status();out=[];org=site.replace("-"," ").title()
    for j in r.json():
        title=clean(j.get("text",""));cats=j.get("categories") or {};loc=clean(cats.get("location",""));desc=clean(j.get("descriptionPlain") or j.get("description") or "")
        text=f"{title} {loc} {desc}"
        if not relevant(text):continue
        if not us_location(loc) and foreign(loc):continue
        if not us_location(loc) and loc and not any(s in loc for s in US_STATES):continue
        out.append({"title":title,"url":j.get("hostedUrl") or j.get("applyUrl"),"snippet":desc[:900],"organization":org,"location":loc or "United States",
                    "sector":"industry","source":"Lever","source_group":"Official / ATS","domain":dom(j.get("hostedUrl","")),
                    "posted_date":str(j.get("createdAt","")),"us_only":True,"query_name":f"Lever:{site}"})
    return out
def make_id(j):
    raw=(j.get("url","").split("?")[0] or f'{j.get("title","")}|{j.get("organization","")}|{j.get("location","")}').lower()
    return hashlib.sha1(raw.encode()).hexdigest()[:18]
def dedup_key(j):
    org=stable(j.get("organization",""));title=stable(j.get("title",""));loc=stable(j.get("location",""))
    if len(org)>2:return f"{title}|{org}|{loc}"
    return j.get("url","").split("?")[0].lower()
def load_old():
    try:return json.loads(JOBS.read_text(encoding="utf-8")).get("jobs",[])
    except:return[]
def parse_iso_date(s):
    try:return datetime.fromisoformat(s.replace("Z","+00:00")).date()
    except:return None
def merge_duplicates(rows):
    grouped={}
    for j in rows:
        k=dedup_key(j);prev=grouped.get(k)
        if not prev: grouped[k]=j;continue
        if SOURCE_PRIORITY.get(j["source"],99)<SOURCE_PRIORITY.get(prev["source"],99):
            j["alternate_urls"]=[prev["url"]]+prev.get("alternate_urls",[]);grouped[k]=j
        else: prev.setdefault("alternate_urls",[]).append(j["url"])
    return list(grouped.values())
def main():
    old=load_old();old_by_id={j.get("id"):j for j in old if j.get("id")}
    today=datetime.now(timezone.utc).date();today_s=today.isoformat();all_rows=[];reports=[];errors=[]
    for spec in CONFIG["search_queries"]:
        try:
            rows=rss_search(spec);all_rows+=rows;reports.append({"source":spec["name"],"count":len(rows),"ok":True})
        except Exception as e:
            errors.append(f'{spec["name"]}: {type(e).__name__}');reports.append({"source":spec["name"],"count":0,"ok":False})
        time.sleep(.8)

    gh=set(CONFIG.get("manual_greenhouse_boards",[]));lv=set(CONFIG.get("manual_lever_sites",[]))
    for j in all_rows:
        t=greenhouse_token(j.get("url",""));s=lever_site(j.get("url",""))
        if t:gh.add(t)
        if s:lv.add(s)

    for token in sorted(gh):
        try:
            rows=fetch_greenhouse(token);all_rows+=rows;reports.append({"source":f"Greenhouse:{token}","count":len(rows),"ok":True})
        except Exception as e: errors.append(f"Greenhouse {token}: {type(e).__name__}")
    for site in sorted(lv):
        try:
            rows=fetch_lever(site);all_rows+=rows;reports.append({"source":f"Lever:{site}","count":len(rows),"ok":True})
        except Exception as e: errors.append(f"Lever {site}: {type(e).__name__}")

    rows=merge_duplicates(all_rows);merged={}
    for j in rows:
        j["id"]=make_id(j);oldj=old_by_id.get(j["id"],{})
        j["first_seen"]=oldj.get("first_seen",today_s);j["last_seen"]=today_s;merged[j["id"]]=j

    keep_days=30
    for j in old:
        if j.get("id") in merged:continue
        d=parse_iso_date(j.get("last_seen","") or j.get("first_seen",""))
        if d and (today-d).days<=keep_days:merged[j["id"]]=j

    jobs=list(merged.values());jobs.sort(key=lambda j:(j.get("first_seen",""),j.get("source","")),reverse=True)
    counts={}
    for j in jobs:
        counts[j.get("source","Unknown")]=counts.get(j.get("source","Unknown"),0)+1
    JOBS.write_text(json.dumps({"jobs":jobs},ensure_ascii=False,indent=2),encoding="utf-8")
    STATUS.write_text(json.dumps({"last_updated":datetime.now(timezone.utc).isoformat(),"job_count":len(jobs),"counts":counts,"sources":reports,"errors":errors},ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Saved {len(jobs)} jobs from {len(counts)} source types. Errors: {len(errors)}")

if __name__=="__main__":main()
