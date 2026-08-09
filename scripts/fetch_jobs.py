from __future__ import annotations
import json, re, hashlib, time, urllib.parse, xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT/"config.json").read_text(encoding="utf-8"))
DATA = ROOT/"data"
JOBS_PATH = DATA/"jobs.json"
STATUS_PATH = DATA/"status.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; PlantScienceCareerRadar/3.0; +https://github.com/)"
}
FOREIGN_MARKERS = [
    "canada","ontario","quebec","british columbia","alberta","australia","united kingdom","uk ",
    "england","scotland","germany","france","netherlands","switzerland","singapore","india","china",
    "taiwan","japan","korea","mexico","brazil"
]
US_MARKERS = [
    "united states","usa","u.s.","remote - us","remote us",
    " al "," ak "," az "," ar "," ca "," co "," ct "," de "," fl "," ga "," hi "," id "," il "," in "," ia ",
    " ks "," ky "," la "," me "," md "," ma "," mi "," mn "," ms "," mo "," mt "," ne "," nv "," nh "," nj ",
    " nm "," ny "," nc "," nd "," oh "," ok "," or "," pa "," ri "," sc "," sd "," tn "," tx "," ut "," vt ",
    " va "," wa "," wv "," wi "," wy "," dc "
]
ACADEMIC_HINTS = ["university","college","faculty","professor","postdoctoral","postdoc","extension"]
INDUSTRY_HINTS = ["scientist","company","inc.","llc","corporation","crop protection","product development","r&d","research and development"]

def load_old():
    try:
        return json.loads(JOBS_PATH.read_text(encoding="utf-8")).get("jobs",[])
    except Exception:
        return []

def clean_html(text):
    return BeautifulSoup(text or "", "html.parser").get_text(" ", strip=True)

def unwrap_bing_url(url):
    # RSS often already contains the destination URL. Keep it unless obvious Bing tracking.
    if "bing.com/ck/a" not in url:
        return url
    try:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        for key in ("u","url","r"):
            if key in q:
                return q[key][0]
    except Exception:
        pass
    return url

def domain_name(url):
    try:
        d=urlparse(url).netloc.lower().replace("www.","")
        return d
    except Exception:
        return ""

def infer_org(title, snippet, domain):
    # Job board titles frequently use separators: "Title - Organization - Location"
    parts=[p.strip() for p in re.split(r"\s+[|\-–—]\s+", title) if p.strip()]
    if len(parts)>=2:
        candidates=parts[1:]
        for p in candidates:
            if any(x in p.lower() for x in ["university","college","institute","company","inc","llc","ag","bioscience","science"]):
                return p[:120]
    # domain fallback
    return domain.split(".")[0].replace("-"," ").title() if domain else ""

def infer_location(text):
    patterns = [
        r"\b([A-Z][A-Za-z .'-]+,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC))\b",
        r"\b(Remote(?:\s*[-,]\s*)?(?:United States|US|U\.S\.))\b"
    ]
    for pat in patterns:
        m=re.search(pat,text,re.I)
        if m: return m.group(1)
    return "United States"

def looks_foreign(text):
    low=" "+text.lower()+" "
    return any(m in low for m in FOREIGN_MARKERS) and not any(m in low for m in ["united states","usa","u.s."])

def relevant(text):
    low=text.lower()
    plant_terms=["plant","crop","hortic","agric","patholog","fung","microb","biological","biostimul","postharvest","greenhouse","agronom","produce"]
    role_terms=["scientist","professor","research","extension","postdoc","faculty","development"]
    return any(x in low for x in plant_terms) and any(x in low for x in role_terms)

def classify_sector(text, requested):
    low=text.lower()
    a=sum(x in low for x in ACADEMIC_HINTS)
    i=sum(x in low for x in INDUSTRY_HINTS)
    if a>i: return "academia"
    if i>a: return "industry"
    return requested

def rss_search(query, sector):
    url="https://www.bing.com/search?format=rss&q="+urllib.parse.quote(query)
    r=requests.get(url,headers=HEADERS,timeout=25)
    r.raise_for_status()
    root=ET.fromstring(r.text)
    out=[]
    for item in root.findall(".//item"):
        title=clean_html(item.findtext("title",""))
        link=unwrap_bing_url((item.findtext("link","") or "").strip())
        desc=clean_html(item.findtext("description",""))
        pub=item.findtext("pubDate","")
        text=f"{title} {desc}"
        if not link or not relevant(text) or looks_foreign(text):
            continue
        dom=domain_name(link)
        out.append({
            "title": title[:220],
            "url": link,
            "snippet": desc[:650],
            "organization": infer_org(title,desc,dom),
            "location": infer_location(text),
            "sector": classify_sector(text,sector),
            "source": "Bing Search",
            "domain": dom,
            "posted_date": pub,
            "us_only": True,
        })
    return out

def stable_id(j):
    raw=(j.get("url","").split("?")[0] or (j.get("title","")+j.get("organization",""))).lower()
    return hashlib.sha1(raw.encode()).hexdigest()[:16]

def main():
    DATA.mkdir(exist_ok=True)
    old=load_old()
    old_by_id={j.get("id"):j for j in old if j.get("id")}
    today=datetime.now(timezone.utc).date().isoformat()
    errors=[]; gathered=[]; source_report=[]
    for spec in CONFIG["search_queries"]:
        try:
            rows=rss_search(spec["query"],spec["sector"])
            gathered.extend(rows)
            source_report.append({"query":spec["query"],"sector":spec["sector"],"count":len(rows),"ok":True})
        except Exception as e:
            errors.append(f'{spec["sector"]} 搜尋失敗：{type(e).__name__}')
            source_report.append({"query":spec["query"],"sector":spec["sector"],"count":0,"ok":False})
        time.sleep(1.2)

    merged={}
    for j in gathered:
        j["id"]=stable_id(j)
        prev=old_by_id.get(j["id"],{})
        j["first_seen"]=prev.get("first_seen",today)
        j["last_seen"]=today
        merged[j["id"]]=j

    # Keep older records for 30 days so a temporary search outage doesn't erase everything.
    for j in old:
        if j.get("id") not in merged:
            try:
                age=(datetime.now(timezone.utc).date()-datetime.fromisoformat(j.get("last_seen") or j.get("first_seen")).date()).days
            except Exception:
                age=999
            if age<=30:
                merged[j["id"]]=j

    jobs=list(merged.values())
    jobs.sort(key=lambda x:(x.get("first_seen",""),x.get("title","")),reverse=True)
    JOBS_PATH.write_text(json.dumps({"jobs":jobs},ensure_ascii=False,indent=2),encoding="utf-8")
    STATUS_PATH.write_text(json.dumps({
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "job_count": len(jobs),
        "sources": source_report,
        "errors": errors
    },ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Saved {len(jobs)} jobs; {len(errors)} errors")

if __name__=="__main__":
    main()
