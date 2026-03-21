# 🗂️ Notionify Jobs

> A Chrome extension that auto-tracks job applications to Notion, with a built-in RAG pipeline for resume matching, cover letter generation, and interview prep.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)](https://chromewebstore.google.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## ✨ Features

- **Auto-capture** — Detects when you click Apply on LinkedIn or Indeed, extracts job title, company, location, salary, and JD text automatically
- **Notion sync** — Writes every application to your Notion database in real time
- **RAG analysis** — Uploads your resume once; on every job, semantically retrieves the most relevant resume sections and feeds them to GPT-4o or Claude to generate:
  - Match score (0–100) with skill gap breakdown
  - Tailored cover letter (one-click copy)
  - Predicted interview questions with answer hints
- **Status tracking** — Update application status (Applied → Interview → Offer) directly from the popup; syncs back to Notion instantly
- **Zero backend** — All API calls happen directly from the extension. No server to deploy or maintain.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Chrome Extension                   │
│                                                     │
│  content.js          popup/           background.js │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐ │
│  │ Detects  │    │ Job list UI  │    │ Message   │ │
│  │ Apply    │───▶│ AI analysis  │───▶│ router    │ │
│  │ clicks   │    │ Resume upload│    │ Storage   │ │
│  └──────────┘    └──────────────┘    └─────┬─────┘ │
└────────────────────────────────────────────┼────────┘
                                             │ Direct API calls
                    ┌────────────────────────┼──────────────────┐
                    │                        │                  │
               ┌────▼─────┐          ┌──────▼──────┐  ┌───────▼──────┐
               │  Notion  │          │   OpenAI    │  │   Pinecone   │
               │   API    │          │ Embeddings  │  │  Vector DB   │
               │          │          │  + GPT-4o   │  │              │
               └──────────┘          └──────┬──────┘  └───────┬──────┘
                                            │                  │
                                     ┌──────▼──────────────────▼──────┐
                                     │         RAG Pipeline            │
                                     │  JD → embed → retrieve resume  │
                                     │  chunks → LLM → analysis       │
                                     └────────────────────────────────┘
```

### Data flow

1. **Apply click** → `content.js` extracts job info → `background.js` → Notion API (new row) + Pinecone (index job for future retrieval)
2. **Resume upload** → PDF parsed in-browser → chunked (400 words, 80 overlap) → OpenAI Embeddings → Pinecone `resume` namespace
3. **AI Analyze** → JD embedded → Pinecone semantic search (top-6 resume chunks) → GPT-4o / Claude prompt → structured XML → 3-tab UI
4. **Status update** → Popup dropdown → Notion PATCH (status column)

---

## 🚀 Quick Start

### Prerequisites

You'll need API keys for:

| Service | Free tier | Purpose |
|---------|-----------|---------|
| [Notion](https://notion.so/my-integrations) | ✅ Free | Store applications |
| [OpenAI](https://platform.openai.com/api-keys) | $5 credit | Embeddings (required) + GPT-4o (optional) |
| [Pinecone](https://pinecone.io) | ✅ Free | Vector storage for RAG |
| [Anthropic](https://console.anthropic.com) | — | Claude API (optional, if preferred over GPT-4o) |

### 1. Install the extension

```bash
git clone https://github.com/YOUR_USERNAME/notionify-jobs.git
```

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the cloned folder

### 2. Set up Notion

1. Create a new Notion database with these columns:

   | Column | Type |
   |--------|------|
   | Job Title | Title (default) |
   | Company | Text |
   | Location | Text |
   | Salary | Text |
   | Platform | Select |
   | Status | Select (`Applied`, `Viewed`, `Interview`, `Offer`, `Rejected`, `Archived`) |
   | Date Applied | Date |
   | URL | URL |
   | Match Score | Number |
   | Notes | Text |

2. Go to [notion.so/my-integrations](https://notion.so/my-integrations) → New integration → copy the **Token**
3. Open your database → `···` menu → **Connections** → add your integration
4. Copy the **Database ID** from the URL: `notion.so/workspace/[DATABASE_ID]?v=...`

### 3. Set up Pinecone

1. Sign up at [pinecone.io](https://pinecone.io)
2. Create an Index:
   - **Dimensions**: `1536`
   - **Metric**: `cosine`
3. Copy the **API Key** and **Host URL** from the index dashboard

### 4. Configure the extension

Click the extension icon → **Settings** tab → fill in all keys → Save

### 5. Upload your resume

Extension popup → **Resume / RAG** tab → upload your PDF → wait for "Resume ready" ✓

### 6. Start applying

Visit any LinkedIn or Indeed job page, click Apply — the rest is automatic.

---

## 📁 Project Structure

```
notionify-jobs/
├── manifest.json
├── src/
│   ├── background/
│   │   └── index.js        # Service worker, message router, API calls
│   ├── content/
│   │   └── index.js        # Injected into job pages, detects Apply clicks
│   ├── popup/
│   │   ├── index.html      # Extension popup UI
│   │   └── index.js        # Popup logic
│   └── rag/
│       ├── embedder.js     # Chunking + OpenAI embedding
│       ├── retriever.js    # Pinecone upsert + query
│       └── analyzer.js     # Prompt builder + LLM call + XML parser
├── icons/
├── docs/
│   └── architecture.png
├── .github/
│   ├── workflows/
│   │   └── daily-check.yml # Optional: daily status checker
│   └── ISSUE_TEMPLATE/
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

---

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Good first issues:**
- Add support for more job platforms (Glassdoor, Greenhouse, Lever, Workday)
- Improve JD text extraction selectors
- Add dark/light theme toggle
- Localization (the UI currently supports English and Chinese)

---

## 🔒 Privacy

- All your data stays between you and the services you configure (Notion, OpenAI, Pinecone)
- The extension has no analytics, no telemetry, and no external servers
- Your API keys are stored locally in Chrome's sync storage and never leave your browser except to call the respective APIs directly

See [PRIVACY.md](PRIVACY.md) for the full policy (required for Chrome Web Store).

---

## 📄 License

MIT © 2025 [Your Name](https://github.com/YOUR_USERNAME)
