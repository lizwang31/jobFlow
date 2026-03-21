"""
Job Tracker — Daily Status Checker
===================================
运行逻辑：
  1. 从 Notion 拉取所有"进行中"的申请记录
  2. 对每条记录的职位链接发请求，检测岗位是否已下线
  3. （可选）扫描 Gmail，根据关键词推断状态变化
  4. 把变化写回 Notion，生成 report.json
"""

import os, json, time, re, datetime
import requests

DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"

# ── Notion 配置 ─────────────────────────────────────────────────────────────

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_DB_ID = os.environ["NOTION_DB_ID"]

NOTION_HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

# 状态字段名（与插件 background/index.js 创建的 Notion 列名一致）
STATUS_PROP   = "Status"
LINK_PROP     = "URL"
COMPANY_PROP  = "Company"
TITLE_PROP    = "Job Title"
NOTES_PROP    = "Notes"      # 可选，用来写入检测日志（需在 Notion 数据库中手动添加此列）

# 只检查这些"进行中"的状态，已拒绝/归档不需要再检测
ACTIVE_STATUSES = {"Applied", "Viewed", "Interview"}

# ── 岗位下线检测规则 ────────────────────────────────────────────────────────
# 各平台岗位下线时页面的特征文字，按 (域名关键字, 匹配文字列表) 配置

CLOSED_SIGNALS = {
    "linkedin.com": [
        "No longer accepting applications",
        "This job is no longer available",
        "job has expired",
    ],
    "indeed.com": [
        "This job has expired",
        "job is no longer available",
        "Expired job",
    ],
    "glassdoor.com": [
        "This job listing has expired",
        "no longer accepting",
    ],
    # 通用兜底：HTTP 404 或重定向到搜索页
    "_generic": [],
}

# ── 邮件关键词 → 状态映射 ───────────────────────────────────────────────────

EMAIL_STATUS_MAP = [
    # (正则或关键词列表,  新状态,           优先级)
    (["online assessment", "coding challenge", "hackerrank", "codility", "OA"],
     "Interview", 10),
    (["phone screen", "phone interview", "phone call", "intro call", "recruiter call"],
     "Interview", 10),
    (["on-site", "onsite", "virtual interview", "interview invitation", "schedule.*interview"],
     "Interview", 20),
    (["offer", "congratulations", "pleased to offer", "extend an offer"],
     "Offer", 30),
    (["unfortunately", "regret to inform", "not moving forward",
      "decided not to", "other candidates", "position has been filled",
      "we will not", "won't be moving"],
     "Rejected", 5),
]


# ══════════════════════════════════════════════════════════════════════════════
#  1. Notion helpers
# ══════════════════════════════════════════════════════════════════════════════

def fetch_active_jobs():
    """从 Notion 数据库拉取所有进行中的申请"""
    url = f"https://api.notion.com/v1/databases/{NOTION_DB_ID}/query"
    results = []
    cursor = None

    while True:
        body = {
            "filter": {
                "or": [
                    {"property": STATUS_PROP, "select": {"equals": s}}
                    for s in ACTIVE_STATUSES
                ]
            },
            "page_size": 100,
        }
        if cursor:
            body["start_cursor"] = cursor

        resp = requests.post(url, headers=NOTION_HEADERS, json=body)
        resp.raise_for_status()
        data = resp.json()
        results.extend(data["results"])

        if not data.get("has_more"):
            break
        cursor = data["next_cursor"]

    print(f"[Notion] 拉取到 {len(results)} 条进行中的申请")
    return results


def parse_job(page):
    """从 Notion page 对象中提取关键字段"""
    props = page["properties"]

    def text(prop_name):
        p = props.get(prop_name, {})
        if p.get("type") == "title":
            return "".join(t["plain_text"] for t in p.get("title", []))
        if p.get("type") == "rich_text":
            return "".join(t["plain_text"] for t in p.get("rich_text", []))
        if p.get("type") == "url":
            return p.get("url") or ""
        if p.get("type") == "select":
            return (p.get("select") or {}).get("name", "")
        return ""

    return {
        "page_id": page["id"],
        "title":   text(TITLE_PROP),
        "company": text(COMPANY_PROP),
        "status":  text(STATUS_PROP),
        "url":     text(LINK_PROP),
    }


def update_notion_status(page_id, new_status, note=None):
    """更新 Notion 页面的状态（和可选备注）"""
    if DRY_RUN:
        print(f"  [DRY RUN] 跳过写入 {page_id} → {new_status}")
        return

    properties = {STATUS_PROP: {"select": {"name": new_status}}}
    if note and NOTES_PROP:
        properties[NOTES_PROP] = {
            "rich_text": [{"text": {"content": note[:2000]}}]
        }

    resp = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=NOTION_HEADERS,
        json={"properties": properties},
    )
    resp.raise_for_status()


# ══════════════════════════════════════════════════════════════════════════════
#  2. 岗位链接检测
# ══════════════════════════════════════════════════════════════════════════════

HEADERS_BROWSER = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def check_job_url(url: str) -> tuple[bool, str]:
    """
    返回 (is_closed, reason)
    is_closed=True  → 岗位已下线
    is_closed=False → 岗位仍开放或无法判断
    """
    if not url or not url.startswith("http"):
        return False, "no_url"

    try:
        resp = requests.get(
            url,
            headers=HEADERS_BROWSER,
            timeout=12,
            allow_redirects=True,
        )
    except requests.exceptions.RequestException as e:
        print(f"  [URL] 请求失败 {url[:60]}: {e}")
        return False, f"request_error: {e}"

    # HTTP 404 → 明确下线
    if resp.status_code == 404:
        return True, "HTTP 404"

    # 检查页面内容关键词
    body = resp.text.lower()
    domain = url.lower()

    for site_key, signals in CLOSED_SIGNALS.items():
        if site_key == "_generic":
            continue
        if site_key in domain:
            for signal in signals:
                if signal.lower() in body:
                    return True, f"keyword: {signal}"

    return False, "ok"


# ══════════════════════════════════════════════════════════════════════════════
#  3. Gmail 扫描（可选）
# ══════════════════════════════════════════════════════════════════════════════

def get_gmail_service():
    """从环境变量加载 Gmail 凭证并返回 service 对象"""
    creds_json = os.environ.get("GMAIL_CREDS", "")
    if not creds_json:
        return None

    try:
        import json, tempfile
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds_dict = json.loads(creds_json)
        creds = Credentials(
            token=creds_dict.get("token"),
            refresh_token=creds_dict.get("refresh_token"),
            token_uri="https://oauth2.googleapis.com/token",
            client_id=creds_dict.get("client_id"),
            client_secret=creds_dict.get("client_secret"),
            scopes=["https://www.googleapis.com/auth/gmail.readonly"],
        )
        return build("gmail", "v1", credentials=creds)
    except Exception as e:
        print(f"[Gmail] 初始化失败（跳过）: {e}")
        return None


def fetch_recent_emails(service, days=1):
    """拉取最近 N 天的邮件，返回 (subject, body_snippet, from) 列表"""
    since = (datetime.datetime.utcnow() - datetime.timedelta(days=days)).strftime("%Y/%m/%d")
    query = f"after:{since}"

    try:
        result = service.users().messages().list(
            userId="me", q=query, maxResults=50
        ).execute()
        messages = result.get("messages", [])
    except Exception as e:
        print(f"[Gmail] 拉取邮件失败: {e}")
        return []

    emails = []
    for m in messages:
        try:
            msg = service.users().messages().get(
                userId="me", id=m["id"], format="metadata",
                metadataHeaders=["Subject", "From"]
            ).execute()
            headers = {h["name"]: h["value"] for h in msg["payload"]["headers"]}
            emails.append({
                "subject": headers.get("Subject", ""),
                "from":    headers.get("From", ""),
                "snippet": msg.get("snippet", ""),
            })
        except Exception:
            continue

    print(f"[Gmail] 读取到 {len(emails)} 封邮件")
    return emails


def infer_status_from_email(email: dict, company: str) -> tuple[str | None, int]:
    """
    对单封邮件判断是否与该公司相关，并推断状态。
    返回 (new_status, priority) 或 (None, 0)
    """
    combined = (
        email["subject"] + " " + email["snippet"] + " " + email["from"]
    ).lower()

    # 粗过滤：邮件内容需要包含公司名（或公司名较短时跳过）
    company_lower = company.lower().strip()
    if len(company_lower) > 3 and company_lower not in combined:
        return None, 0

    best_status, best_priority = None, 0
    for keywords, status, priority in EMAIL_STATUS_MAP:
        for kw in keywords:
            pattern = kw if re.search(r'[.*+?]', kw) else re.escape(kw)
            if re.search(pattern, combined, re.IGNORECASE):
                if priority > best_priority:
                    best_status, best_priority = status, priority
                break

    return best_status, best_priority


# ══════════════════════════════════════════════════════════════════════════════
#  4. Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    report = {
        "run_at": datetime.datetime.utcnow().isoformat() + "Z",
        "dry_run": DRY_RUN,
        "total_checked": 0,
        "url_closed": [],
        "email_updates": [],
        "errors": [],
    }

    # ── Step 1: 拉取进行中的申请 ──
    pages = fetch_active_jobs()
    jobs  = [parse_job(p) for p in pages]
    report["total_checked"] = len(jobs)

    # ── Step 2: 初始化 Gmail（可选）──
    gmail = get_gmail_service()
    recent_emails = fetch_recent_emails(gmail, days=1) if gmail else []

    # ── Step 3: 逐条检查 ──
    for job in jobs:
        print(f"\n检查: {job['company']} — {job['title']} [{job['status']}]")
        today = datetime.datetime.utcnow().strftime("%Y-%m-%d")

        # 3a. 检测职位 URL 是否下线
        if job["url"]:
            closed, reason = check_job_url(job["url"])
            if closed:
                note = f"[{today}] 自动检测：岗位已下线（{reason}）"
                print(f"  → 岗位下线，原因: {reason}")
                try:
                    update_notion_status(job["page_id"], "Archived", note)
                    report["url_closed"].append({
                        "company": job["company"],
                        "title":   job["title"],
                        "reason":  reason,
                    })
                except Exception as e:
                    report["errors"].append(str(e))
                # 已归档，跳过邮件检测
                time.sleep(0.5)
                continue

        # 3b. Gmail 邮件状态推断
        if recent_emails:
            best_status, best_priority = None, 0
            for email in recent_emails:
                status, priority = infer_status_from_email(email, job["company"])
                if status and priority > best_priority:
                    best_status, best_priority = status, priority

            if best_status and best_status != job["status"]:
                # 状态只允许"升级"（优先级更高的状态），不会倒退
                note = f"[{today}] 邮件检测：自动更新为 {best_status}"
                print(f"  → 邮件推断新状态: {best_status}")
                try:
                    update_notion_status(job["page_id"], best_status, note)
                    report["email_updates"].append({
                        "company":    job["company"],
                        "title":      job["title"],
                        "old_status": job["status"],
                        "new_status": best_status,
                    })
                except Exception as e:
                    report["errors"].append(str(e))

        time.sleep(0.5)  # 避免请求过快

    # ── Step 4: 输出报告 ──
    print("\n" + "="*50)
    print(f"检查完成: {len(jobs)} 条申请")
    print(f"  岗位下线: {len(report['url_closed'])} 条 → 已自动归档")
    print(f"  邮件更新: {len(report['email_updates'])} 条")
    print(f"  错误:     {len(report['errors'])} 条")
    if DRY_RUN:
        print("  [DRY RUN 模式：未实际写入 Notion]")

    with open("report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("\n报告已写入 report.json")


if __name__ == "__main__":
    main()
