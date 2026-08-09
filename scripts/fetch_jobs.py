#!/usr/bin/env python3
"""Fetch academic jobs from public listing pages, score them, and update data/jobs.json.

No API key is required. Public websites can change HTML or block automated requests;
when a source fails, this script preserves previously seen jobs instead of wiping them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.json"
JOBS_PATH = ROOT / "data" / "jobs.json"
STATUS_PATH = ROOT / "data" / "status.json"

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "Chrome/131.0 Safari/537.36 AcademicJobRadar/1.0"
)
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
})

@dataclass
class Candidate:
    title: str
    url: str
    context: str
    source: str
    source_type: str


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def stable_id(source_type: str, url: str) -> str:
    patterns = {
        "higheredjobs": r"JobCode=(\d+)",
        "ajo": r"/jobs/(\d+)",
        "aps": r"-(\d+)(?:/|$)",
    }
    m = re.search(patterns.get(source_type, r"$^"), url, flags=re.I)
    if m:
        return f"{source_type}-{m.group(1)}"
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    return f"{source_type}-{digest}"


def fetch(url: str, timeout: int = 30) -> str:
    r = SESSION.get(url, timeout=timeout)
    r.raise_for_status()
    return r.text


def nearby_text(anchor, max_chars=1800) -> str:
    node = anchor
    best = clean(anchor.get_text(" ", strip=True))
    for _ in range(5):
        if not getattr(node, "parent", None):
            break
        node = node.parent
        text = clean(node.get_text(" ", strip=True))
        if len(text) <= max_chars:
            best = text
        else:
            break
    return best


def listing_candidates(html: str, source: dict) -> list[Candidate]:
    soup = BeautifulSoup(html, "html.parser")
    base = source["url"]
    stype = source["type"]
    out: list[Candidate] = []
    seen: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = urljoin(base, a.get("href"))
        title = clean(a.get_text(" ", strip=True))
        if len(title) < 4:
            continue

        is_job = False
        if stype == "higheredjobs":
            is_job = "details.cfm" in href and "JobCode=" in href
        elif stype == "ajo":
            is_job = bool(re.search(r"academicjobsonline\.org/ajo/jobs/\d+/?$", href))
        elif stype == "aps":
            is_job = "/job/" in href and "jobs.apsnet.org" in href
        else:
            is_job = False

        if not is_job or href in seen:
            continue
        seen.add(href)
        out.append(Candidate(title, href, nearby_text(a), source["name"], stype))

    return out


def relevant(text: str, config: dict) -> bool:
    low = text.lower()
    return any(term.lower() in low for term in config.get("relevance_terms", []))


def score_text(text: str, config: dict) -> tuple[int, list[str]]:
    rules = config.get("scoring", {})
    score = int(rules.get("base", 0))
    reasons: list[str] = []
    low = text.lower()
    labels_seen = set()

    for rule in rules.get("positive", []):
        if rule["term"].lower() in low:
            score += int(rule["points"])
            label = rule.get("label", rule["term"])
            if label not in labels_seen:
                reasons.append(label)
                labels_seen.add(label)
    for rule in rules.get("negative", []):
        if rule["term"].lower() in low:
            score += int(rule["points"])

    return max(0, min(100, score)), reasons


def parse_isoish(text: str) -> str | None:
    patterns = [
        r"\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\b",
        r"\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b",
    ]
    for i, pat in enumerate(patterns):
        m = re.search(pat, text)
        if not m:
            continue
        try:
            if i == 0:
                y, mo, d = map(int, m.groups())
            else:
                mo, d, y = map(int, m.groups())
            return datetime(y, mo, d).date().isoformat()
        except ValueError:
            pass
    return None


def parse_labeled_date(text: str, labels: Iterable[str]) -> str | None:
    for label in labels:
        m = re.search(rf"{label}[^\n\r:]{{0,25}}[:\s]+([^\n\r]{{0,70}})", text, flags=re.I)
        if m:
            segment = m.group(1)
            iso = parse_isoish(segment)
            if iso:
                return iso
            for fmt in ("%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%d %b %Y"):
                words = re.search(r"([A-Za-z]{3,9}\s+\d{1,2},\s+20\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2})", segment)
                if words:
                    try:
                        return datetime.strptime(words.group(1), fmt).date().isoformat()
                    except ValueError:
                        continue
    return None


def detail_text(url: str) -> str:
    html = fetch(url)
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    # Keep line boundaries because several job boards expose metadata as label/value lines.
    raw = soup.get_text("\n", strip=True)
    return "\n".join(clean(line) for line in raw.splitlines() if clean(line))


def title_from_detail(text: str, fallback: str, source_type: str) -> str:
    if source_type == "ajo":
        m = re.search(r"Position Title:\s*([^\n]{3,180})", text, flags=re.I)
        if m:
            return clean(m.group(1))
    return fallback


def guess_institution_location(text: str, title: str, source_type: str) -> tuple[str, str]:
    # Intentionally conservative: returning blank is better than inventing metadata.
    institution = ""
    location = ""

    if source_type == "ajo":
        # AJO commonly starts detail pages with "University, Department" and has "Position Location:".
        m_loc = re.search(r"Position Location:\s*([^\n]{3,120})", text, flags=re.I)
        if m_loc:
            location = clean(m_loc.group(1))
        before = text.split("Position ID:", 1)[0]
        lines = [clean(x) for x in before.split("\n") if clean(x)]
        for line in reversed(lines[-8:]):
            if len(line) > 3 and title.lower() not in line.lower() and "academic jobs" not in line.lower():
                institution = line
                break

    if source_type == "aps":
        # Job board detail pages often print institution and location near the heading.
        m = re.search(re.escape(title) + r"\s+([^\n]{3,100})\s+([^\n]{3,100})", text, flags=re.I)
        if m:
            institution = clean(m.group(1))
            location = clean(m.group(2))

    if source_type == "higheredjobs":
        # HigherEdJobs commonly includes "Institution:" / "Location:" labels in accessible text.
        mi = re.search(r"Institution:\s*([^\n]{3,120})", text, flags=re.I)
        ml = re.search(r"Location:\s*([^\n]{3,120})", text, flags=re.I)
        if mi:
            institution = clean(mi.group(1))
        if ml:
            location = clean(ml.group(1))

    return institution[:180], location[:180]


def tags_from_text(text: str) -> list[str]:
    pairs = [
        ("plant pathology", "plant pathology"),
        ("plant-microbe", "plant-microbe"),
        ("plant microbe", "plant-microbe"),
        ("horticultur", "horticulture"),
        ("controlled environment", "controlled environment"),
        ("greenhouse", "greenhouse"),
        ("postharvest", "postharvest"),
        ("post-harvest", "postharvest"),
        ("biological", "biological"),
        ("extension", "extension"),
        ("assistant professor", "faculty"),
        ("associate professor", "faculty"),
        ("postdoc", "postdoc"),
        ("research scientist", "research"),
    ]
    low = text.lower()
    tags = []
    for needle, tag in pairs:
        if needle in low and tag not in tags:
            tags.append(tag)
    if "united states" in low or re.search(r"\b[A-Z]{2}\s+\d{5}\b", text):
        tags.append("USA")
    return tags[:10]


def merge_job(candidate: Candidate, detail: str, old: dict | None, now_iso: str, config: dict) -> dict:
    resolved_title = title_from_detail(detail, candidate.title, candidate.source_type)
    combined = clean(f"{resolved_title} {candidate.context} {detail}")
    score, reasons = score_text(combined, config)
    institution, location = guess_institution_location(detail, resolved_title, candidate.source_type)

    # Preserve better historical metadata if the new scrape cannot recover it.
    old = old or {}
    institution = institution or old.get("institution", "")
    location = location or old.get("location", "")

    posted = parse_labeled_date(detail, [r"posted", r"date posted", r"publication date"]) or old.get("postedDate")
    deadline = parse_labeled_date(detail, [r"appl deadline", r"application deadline", r"deadline", r"review begins", r"full consideration"]) or old.get("deadline")

    return {
        "id": stable_id(candidate.source_type, candidate.url),
        "title": resolved_title,
        "institution": institution,
        "location": location,
        "source": candidate.source,
        "url": candidate.url,
        "postedDate": posted,
        "deadline": deadline,
        "firstSeen": old.get("firstSeen", now_iso),
        "lastSeen": now_iso,
        "active": True,
        "score": score,
        "matchReasons": reasons[:7],
        "tags": tags_from_text(combined),
        "seed": False,
    }


def update(offline: bool = False) -> dict:
    config = load_json(CONFIG_PATH, {})
    previous = load_json(JOBS_PATH, [])
    previous_by_id = {j.get("id"): j for j in previous if j.get("id")}
    previous_by_url = {j.get("url"): j for j in previous if j.get("url")}

    now = datetime.now(timezone.utc)
    now_iso = now.date().isoformat()
    stale_days = int(config.get("stale_after_days", 21))
    source_status = []
    discovered: dict[str, dict] = {}
    detail_budget = int(config.get("detail_fetch_limit", 45))

    if offline:
        print("Offline validation mode: network fetch skipped.")
    else:
        for source in config.get("sources", []):
            if not source.get("enabled", True):
                continue
            count = 0
            try:
                html = fetch(source["url"])
                candidates = listing_candidates(html, source)
                candidates = candidates[: int(config.get("max_jobs_per_source", 120))]
                for c in candidates:
                    if not relevant(f"{c.title} {c.context}", config):
                        continue
                    jid = stable_id(c.source_type, c.url)
                    old = previous_by_id.get(jid) or previous_by_url.get(c.url)
                    detail = c.context
                    # Fetch detail selectively while we still have budget; context alone remains a fallback.
                    if detail_budget > 0:
                        try:
                            detail = detail_text(c.url)
                            detail_budget -= 1
                            time.sleep(0.15)
                        except Exception as exc:
                            print(f"detail warning {c.url}: {exc}")
                    job = merge_job(c, detail, old, now_iso, config)
                    if job["score"] >= int(config.get("min_keep_score", 35)):
                        discovered[job["id"]] = job
                        count += 1
                source_status.append({"name": source["name"], "ok": True, "count": count})
            except Exception as exc:
                print(f"SOURCE ERROR {source['name']}: {exc}")
                source_status.append({"name": source["name"], "ok": False, "count": 0, "error": str(exc)[:240]})

    # Preserve previously seen jobs. If a source ran successfully but the job disappeared,
    # keep it for stale_after_days and mark inactive after that threshold.
    successful_sources = {s["name"] for s in source_status if s.get("ok")}
    for old in previous:
        if old.get("id") in discovered:
            continue
        keep = dict(old)
        last_seen = old.get("lastSeen") or old.get("firstSeen")
        try:
            age = (now.date() - datetime.fromisoformat(last_seen).date()).days if last_seen else stale_days + 1
        except ValueError:
            age = stale_days + 1

        # If source failed, preserve active state because absence is uninformative.
        if old.get("source") in successful_sources and age > stale_days:
            keep["active"] = False
        discovered[keep["id"]] = keep

    final_jobs = sorted(
        discovered.values(),
        key=lambda j: (bool(j.get("active")), int(j.get("score", 0)), j.get("firstSeen", "")),
        reverse=True,
    )
    JOBS_PATH.write_text(json.dumps(final_jobs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    status = {
        "updatedAt": now.isoformat(timespec="seconds"),
        "sources": source_status,
        "jobCount": len(final_jobs),
        "activeCount": sum(1 for j in final_jobs if j.get("active")),
    }
    STATUS_PATH.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="Validate config/data without network access")
    args = parser.parse_args()
    status = update(offline=args.offline)
    print(json.dumps(status, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
