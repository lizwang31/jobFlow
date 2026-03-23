# JobFlow

A Chrome extension that automatically tracks your job applications into Notion — with AI-powered resume matching, cover letter generation, and interview prep.

> Currently in **beta**. If you're trying this out, please share any bugs or feedback!

---

## What it does

- **Auto-saves applications** — When you apply on LinkedIn or Indeed, it captures the job info automatically. On other career sites (Greenhouse, Lever, Workday, company career pages), a floating button appears so you can save with one click.
- **Syncs to Notion** — Every application is written to your Notion database in real time, including status updates.
- **AI analysis** — Upload your resume once. Then on any job page, click the floating button to get a match score, skill gap breakdown, tailored cover letter, and predicted interview questions.
- **Daily status check** — A GitHub Actions workflow runs every day to detect closed job listings and automatically archive them in Notion.

---

## Setup

### What you need

| | Required | Notes |
|---|---|---|
| [Notion](https://notion.so) account | Yes | Free |
| [OpenAI API key](https://platform.openai.com/api-keys) | Yes | For resume embedding and AI analysis. ~$0.01–0.05 per analysis. |
| [Pinecone](https://pinecone.io) account | No | Free tier. Enables cloud resume index — skip this if you want to keep everything local. |
| [Anthropic API key](https://console.anthropic.com) | No | Only if you prefer Claude over GPT-4o for analysis. |

---

### Step 1 — Install the extension

1. Download or clone this repo:
   ```
   git clone https://github.com/lizwang31/jobFlow.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `notionify-jobs` folder

The extension icon will appear in your toolbar.

---

### Step 2 — Set up your Notion database

1. Create a new **full-page database** in Notion
2. Add the following columns (exact names matter):

   | Column name | Type |
   |---|---|
   | Job Title | Title (already exists by default) |
   | Company | Text |
   | Location | Text |
   | Salary | Text |
   | Platform | Select |
   | Status | Select |
   | Date Applied | Date |
   | URL | URL |
   | Match Score | Number |
   | Keyword Score | Number |
   | Semantic Score | Number |
   | Notes | Text |

   For the **Status** column, add these options: `Applied`, `Viewed`, `Interview`, `Offer`, `Rejected`, `Archived`

3. Create a Notion integration:
   - Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**
   - Give it a name (e.g. "JobFlow"), click Save
   - Copy the **Internal Integration Token** (starts with `secret_`)

4. Connect the integration to your database:
   - Open your database page in Notion
   - Click `···` in the top-right → **Connections** → find and add your integration

5. Get your **Database ID**:
   - Copy the URL of your database page
   - It looks like: `https://notion.so/yourworkspace/`**`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`**`?v=...`
   - The 32-character string is your Database ID

---

### Step 3 — Configure the extension

1. Click the extension icon in your toolbar
2. Go to the **Settings** tab
3. Fill in:
   - Notion Token (`secret_xxx...`)
   - Notion Database ID
   - OpenAI API Key (`sk-...`)
   - Pinecone Key + Host URL (optional)
4. Click **Save Settings**

---

### Step 4 — Upload your resume

1. Go to the **Resume / RAG** tab in the popup
2. Upload your resume as a **PDF**
3. Wait for "Resume Ready" — this usually takes 10–20 seconds

---

### Step 5 — Start applying

**On LinkedIn / Indeed:**
- Apply normally. The extension captures it automatically and saves to Notion.
- On any job page, click the floating button (bottom-right) to run an AI match analysis before applying.

**On company career sites** (e.g. Greenhouse, Lever, Workday, or any `/jobs/` page):
- A floating briefcase button appears on job description pages.
- Click it → a "Save Job" prompt appears with the job title and company pre-filled.
- Edit if needed, then click **Save Applied** to record it, or **Analyze** to run AI analysis first.

---

### Optional — Daily job status checker

If you want automated daily checks for closed listings, you can set up the GitHub Actions workflow included in this repo.

1. Fork or push this repo to your GitHub account
2. Go to your repo → **Settings → Secrets and variables → Actions**
3. Add two secrets:
   - `NOTION_TOKEN` — your Notion integration token
   - `NOTION_DB_ID` — your database ID
4. The workflow runs automatically every day at 5 PM Beijing time (UTC 09:00). You can also trigger it manually from the **Actions** tab.

---

## How to give feedback

This is a beta — things may break or behave unexpectedly. If you run into anything:

- Open an issue at [github.com/lizwang31/jobFlow/issues](https://github.com/lizwang31/jobFlow/issues)
- Or just message me directly

Things especially helpful to know:
- Which site did it break on (LinkedIn, Indeed, Greenhouse, or a company career page)?
- Did the job title / company name get captured correctly?
- Did Notion sync work?
- Did the AI analysis return anything useful?

---

## Privacy

- Your data goes directly between your browser and the services you configure (Notion, OpenAI, Pinecone). There is no backend server.
- API keys are stored in Chrome's local sync storage and are never sent anywhere except to their respective APIs.
- The extension has no analytics or telemetry.

See [PRIVACY.md](PRIVACY.md) for the full policy.

---

## License

MIT © 2026 [lizwang31](https://github.com/lizwang31)
