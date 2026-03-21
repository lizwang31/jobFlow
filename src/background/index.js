// src/background/index.js
// Service worker — message router, Notion API calls, local storage
// No Cloudflare Worker needed: all API calls go directly from here

const STORAGE_KEY = "njobs_applications";
const MAX_STORED  = 100;
const MAX_JD_TEXT_CHARS = 12000;

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const map = {
    JOB_APPLIED:   () => handleNewJob(msg.payload),
    GET_JOBS:      () => getJobs(),
    CLEAR_JOBS:    () => clearJobs(),
    UPDATE_STATUS: () => updateStatus(msg.jobId, msg.status),
    DELETE_JOB:    () => deleteJob(msg.jobId),
    SAVE_ANALYSIS: () => saveAnalysis(msg.jobId, msg.matchScore, msg.analysis),
    INDEX_JOB_VEC: () => indexJobVector(msg.job),
  };
  const fn = map[msg.type];
  if (!fn) return false;

  Promise.resolve()
    .then(fn)
    .then((result) => {
      sendResponse(result);
    })
    .catch((err) => {
      console.error("[BG] Message handler failed:", msg?.type, err);
      sendResponse({
        success: false,
        error: err?.message || String(err),
      });
    });

  return true;
});

// ── New job: save locally + write to Notion ───────────────────────────────────

async function handleNewJob(job) {
  // 1. Save to local storage immediately (works even if Notion call fails)
  const saved = await saveJob({ ...job, status: "Applied", notionSynced: false });

  // 2. Get settings
  const cfg = await getSettings();
  if (!cfg.notionToken || !cfg.notionDbId) {
    return { success: true, local: true, message: "Saved locally — Notion not configured yet" };
  }

  // 3. Write to Notion
  try {
    const page = await notionCreatePage(saved, cfg);
    await markSynced(saved.id, page.id);
    return { success: true, notionPageId: page.id };
  } catch (err) {
    console.error("[BG] Notion sync failed:", err);
    return { success: true, local: true, message: `Saved locally. Notion error: ${err.message}` };
  }
}

// ── Index a job into Pinecone (called from popup after analysis) ──────────────

async function indexJobVector(job) {
  const cfg = await getSettings();
  if (!cfg.openaiKey || !cfg.pineconeKey || !cfg.pineconeHost) return { success: false };

  try {
    // Dynamic import — only load when needed
    const { embedText }    = await import(chrome.runtime.getURL("src/rag/embedder.js"));
    const { upsertVectors } = await import(chrome.runtime.getURL("src/rag/retriever.js"));

    const text = `${job.title} at ${job.company}. ${job.location ?? ""}. ${job.salary ?? ""}`;
    const vec  = await embedText(text, cfg.openaiKey);

    await upsertVectors([{
      id:       `job-${job.id}`,
      values:   vec,
      metadata: {
        text,
        title:         job.title,
        company:       job.company,
        status:        job.status,
        appliedAt:     job.appliedAt,
        notionPageId:  job.notionPageId ?? "",
        source:        "job",
      },
    }], "jobs", cfg.pineconeKey, cfg.pineconeHost);

    return { success: true };
  } catch (err) {
    console.warn("[BG] Job vector index failed (non-fatal):", err);
    return { success: false, error: err.message };
  }
}

// ── Status update: local + Notion PATCH ──────────────────────────────────────

async function updateStatus(jobId, status) {
  const jobs = await getJobs();
  const job  = jobs.find(j => j.id === jobId);
  if (!job) return { success: false };

  // Update locally
  await chrome.storage.local.set({
    [STORAGE_KEY]: jobs.map(j => j.id === jobId ? { ...j, status } : j),
  });

  // Sync to Notion if we have a page ID
  if (job.notionPageId) {
    const { notionToken } = await getSettings();
    if (notionToken) {
      notionUpdateStatus(job.notionPageId, status, notionToken).catch(
        e => console.warn("[BG] Status sync failed:", e)
      );
    }
  }

  return { success: true };
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function getJobs() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] ?? [];
}

async function saveJob(job) {
  const jobs   = await getJobs();
  const newJob = { id: `${Date.now()}`, ...normalizeJobRecord(job) };
  await chrome.storage.local.set({
    [STORAGE_KEY]: [newJob, ...jobs].slice(0, MAX_STORED),
  });
  return newJob;
}

async function markSynced(jobId, notionPageId) {
  const jobs = await getJobs();
  await chrome.storage.local.set({
    [STORAGE_KEY]: jobs.map(j =>
      j.id === jobId ? { ...j, notionSynced: true, notionPageId } : j
    ),
  });
}

async function deleteJob(jobId) {
  const jobs = await getJobs();
  await chrome.storage.local.set({
    [STORAGE_KEY]: jobs.filter(j => j.id !== jobId),
  });
  return { success: true };
}

async function clearJobs() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: [],
  });
  return { success: true };
}

async function saveAnalysis(jobId, matchScore, analysis) {
  const jobs = await getJobs();
  const job = jobs.find((j) => j.id === jobId);

  await chrome.storage.local.set({
    [STORAGE_KEY]: jobs.map(j =>
      j.id === jobId ? { ...j, matchScore, analysis } : j
    ),
  });

  let notionUpdated = false;
  let notionError = "";

  if (job?.notionPageId) {
    const { notionToken } = await getSettings();
    if (notionToken) {
      try {
        await notionUpdateAnalysis(job.notionPageId, {
          matchScore,
          keywordScore: analysis?.keywordScore,
          semanticScore: analysis?.semanticScore,
        }, notionToken);
        await notionAppendAnalysisBlocks(job.notionPageId, analysis, notionToken);
        notionUpdated = true;
      } catch (e) {
        notionError = e?.message || String(e);
        console.warn("[BG] Analysis sync failed:", e);
      }
    }
  }

  return {
    success: true,
    notionUpdated,
    notionError,
  };
}

async function getSettings() {
  return chrome.storage.sync.get([
    "notionToken", "notionDbId",
    "openaiKey", "anthropicKey",
    "pineconeKey", "pineconeHost",
    "llmProvider",
  ]);
}

// ── Notion API ────────────────────────────────────────────────────────────────

async function notionCreatePage(job, cfg) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(cfg.notionToken),
    body: JSON.stringify({
      parent:     { database_id: cfg.notionDbId },
      properties: buildNotionProperties(job),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message ?? `Notion ${res.status}`);
  }

  const page = await res.json();
  if (job.analysis) {
    await notionUpdateAnalysis(page.id, {
      matchScore: job.matchScore,
      keywordScore: job.analysis?.keywordScore,
      semanticScore: job.analysis?.semanticScore,
    }, cfg.notionToken);
  }
  if (job.analysis) {
    await notionAppendAnalysisBlocks(page.id, job.analysis, cfg.notionToken);
  }
  return page;
}

async function notionUpdateStatus(pageId, status, token) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: { "Status": { select: { name: status } } },
    }),
  });
  if (!res.ok) throw new Error(`Notion PATCH ${res.status}`);
}

async function notionUpdateAnalysis(pageId, analysis, token) {
  const properties = {};
  if (analysis?.matchScore != null) {
    properties["Match Score"] = { number: analysis.matchScore };
  }
  if (analysis?.keywordScore != null) {
    properties["Keyword Score"] = { number: analysis.keywordScore };
  }
  if (analysis?.semanticScore != null) {
    properties["Semantic Score"] = { number: analysis.semanticScore };
  }

  if (!Object.keys(properties).length) return;

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ properties }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message ?? `Notion analysis PATCH ${res.status}`);
  }
}

async function notionAppendAnalysisBlocks(pageId, analysis, token) {
  const children = buildAnalysisBlocks(analysis);
  if (!children.length) return;

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ children }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message ?? `Notion blocks append ${res.status}`);
  }
}

async function notionAppendJobDescriptionBlocks(pageId, job, token) {
  const children = buildJobDescriptionBlocks(job);
  if (!children.length) return;

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ children }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message ?? `Notion JD append ${res.status}`);
  }
}

function buildAnalysisBlocks(analysis = {}) {
  const timestamp = new Date().toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const blocks = [
    { object: "block", type: "divider", divider: {} },
    heading2Block(`AI Analysis — ${timestamp}`),
    paragraphBlock(
      [
        analysis.matchScore != null ? `Match Score: ${analysis.matchScore}` : "",
        analysis.keywordScore != null ? `Keyword Score: ${analysis.keywordScore}` : "",
        analysis.semanticScore != null ? `Semantic Score: ${analysis.semanticScore}` : "",
      ].filter(Boolean).join(" | ")
    ),
  ];

  if (analysis.matchSummary) {
    blocks.push(heading3Block("Summary"));
    blocks.push(...paragraphBlocksFromText(analysis.matchSummary));
  }

  if (analysis.strengths?.length) {
    blocks.push(heading3Block("Strengths"));
    blocks.push(...analysis.strengths.map((item) => bulletedListItemBlock(item)));
  }

  if (analysis.gaps?.length) {
    blocks.push(heading3Block("Gaps"));
    blocks.push(...analysis.gaps.map((item) => bulletedListItemBlock(item)));
  }

  if (analysis.keywordsMatched?.length) {
    blocks.push(heading3Block("Matched Keywords"));
    blocks.push(...analysis.keywordsMatched.map((item) => bulletedListItemBlock(item)));
  }

  if (analysis.keywordsMissing?.length) {
    blocks.push(heading3Block("Missing Keywords"));
    blocks.push(...analysis.keywordsMissing.map((item) => bulletedListItemBlock(item)));
  }

  if (analysis.coverLetter) {
    blocks.push(heading3Block("Cover Letter"));
    blocks.push(...paragraphBlocksFromText(analysis.coverLetter));
  }

  if (analysis.interviewQs?.length) {
    blocks.push(heading3Block("Interview Questions"));
    for (const item of analysis.interviewQs) {
      if (item?.q) blocks.push(numberedListItemBlock(item.q));
      if (item?.hint) blocks.push(...paragraphBlocksFromText(`Hint: ${item.hint}`));
    }
  }

  return blocks.slice(0, 100);
}

function buildJobDescriptionBlocks(job = {}) {
  const jdText = cleanJobDescriptionText(job.jdText || job.description || "");
  if (!jdText) return [];

  const sections = splitJobDescriptionSections(jdText);
  const blocks = [
    heading2Block("Job Description"),
  ];

  if (job.url) {
    blocks.push(paragraphBlock(`Source: ${job.url}`));
  }

  if (sections.length) {
    for (const section of sections) {
      if (section.heading) {
        blocks.push(heading3Block(section.heading));
      }
      blocks.push(...blocksFromJobSection(section.body));
    }
  } else {
    blocks.push(...paragraphBlocksFromText(jdText));
  }

  return blocks.slice(0, 100);
}

function heading2Block(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: richTextArray(text) },
  };
}

function heading3Block(text) {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: richTextArray(text) },
  };
}

function paragraphBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richTextArray(text || "") },
  };
}

function bulletedListItemBlock(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richTextArray(text || "") },
  };
}

function numberedListItemBlock(text) {
  return {
    object: "block",
    type: "numbered_list_item",
    numbered_list_item: { rich_text: richTextArray(text || "") },
  };
}

function paragraphBlocksFromText(text) {
  const normalized = String(text || "").replace(/\r/g, "").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const blocks = [];
  for (const paragraph of paragraphs) {
    const chunks = chunkTextForNotion(paragraph, 1800);
    for (const chunk of chunks) {
      blocks.push(paragraphBlock(chunk));
    }
  }
  return blocks;
}

function blocksFromJobSection(text) {
  const normalized = String(text || "").replace(/\r/g, "").trim();
  if (!normalized) return [];

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const bulletLikeLines = lines.filter((line) => /^[•*\-\u2022]/.test(line));
  if (bulletLikeLines.length >= 2 && bulletLikeLines.length >= Math.ceil(lines.length / 2)) {
    return bulletLikeLines
      .map((line) => line.replace(/^[•*\-\u2022]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 30)
      .map((line) => bulletedListItemBlock(line));
  }

  return paragraphBlocksFromText(normalized);
}

function cleanJobDescriptionText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitJobDescriptionSections(text) {
  const normalized = cleanJobDescriptionText(text);
  if (!normalized) return [];

  const headingMap = [
    { key: "about", label: "Overview" },
    { key: "summary", label: "Overview" },
    { key: "about the role", label: "Overview" },
    { key: "job summary", label: "Overview" },
    { key: "responsibilities", label: "Responsibilities" },
    { key: "what you'll do", label: "Responsibilities" },
    { key: "what you will do", label: "Responsibilities" },
    { key: "duties", label: "Responsibilities" },
    { key: "requirements", label: "Requirements" },
    { key: "qualifications", label: "Requirements" },
    { key: "what we're looking for", label: "Requirements" },
    { key: "what we are looking for", label: "Requirements" },
    { key: "preferred qualifications", label: "Preferred Qualifications" },
    { key: "nice to have", label: "Preferred Qualifications" },
    { key: "preferred", label: "Preferred Qualifications" },
    { key: "benefits", label: "Benefits" },
    { key: "why join", label: "Benefits" },
  ];

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = [];
  let current = null;

  for (const line of lines) {
    const canonicalHeading = canonicalizeJobHeading(line, headingMap);
    if (canonicalHeading) {
      if (current?.body?.trim()) sections.push(current);
      current = { heading: canonicalHeading, body: "" };
      continue;
    }

    if (!current) {
      current = { heading: "Overview", body: "" };
    }

    current.body += `${current.body ? "\n" : ""}${line}`;
  }

  if (current?.body?.trim()) sections.push(current);

  return mergeAdjacentJobSections(sections).slice(0, 8);
}

function canonicalizeJobHeading(line, headingMap) {
  const normalized = String(line || "")
    .toLowerCase()
    .replace(/[:\-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length > 60) return "";

  for (const entry of headingMap) {
    if (normalized === entry.key) return entry.label;
  }

  return "";
}

function mergeAdjacentJobSections(sections) {
  const merged = [];
  for (const section of sections) {
    const previous = merged[merged.length - 1];
    if (previous && previous.heading === section.heading) {
      previous.body += `\n${section.body}`;
      continue;
    }
    merged.push({ ...section });
  }
  return merged;
}

function richTextArray(text) {
  return chunkTextForNotion(text, 1800).map((chunk) => ({
    type: "text",
    text: { content: chunk },
  }));
}

function chunkTextForNotion(text, maxLength = 1800) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < Math.floor(maxLength * 0.6)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildNotionProperties(job) {
  const p = {
    "Job Title":    { title:     [{ text: { content: job.title    ?? "Unknown" } }] },
    "Company":      { rich_text: [{ text: { content: job.company  ?? "" } }] },
    "Location":     { rich_text: [{ text: { content: job.location ?? "" } }] },
    "Platform":     { select:    { name: job.platform ?? "Other" } },
    "Status":       { select:    { name: job.status   ?? "Applied" } },
    "Date Applied": { date:      { start: (job.appliedAt ?? new Date().toISOString()).split("T")[0] } },
    "URL":          { url: job.url || null },
  };
  if (job.salary)     p["Salary"]      = { rich_text: [{ text: { content: job.salary } }] };
  if (job.matchScore != null) p["Match Score"] = { number: job.matchScore };
  if (job.analysis?.keywordScore != null) p["Keyword Score"] = { number: job.analysis.keywordScore };
  if (job.analysis?.semanticScore != null) p["Semantic Score"] = { number: job.analysis.semanticScore };
  return p;
}

function normalizeJobRecord(job = {}) {
  return {
    ...job,
    title: String(job.title || "").trim().slice(0, 300) || "Unknown Position",
    company: String(job.company || "").trim().slice(0, 300) || "Unknown Company",
    location: String(job.location || "").trim().slice(0, 300),
    salary: String(job.salary || "").trim().slice(0, 300),
    jdText: String(job.jdText || "").trim().slice(0, MAX_JD_TEXT_CHARS),
    url: String(job.url || "").slice(0, 2000),
    platform: String(job.platform || "").trim().slice(0, 80) || "Unknown",
  };
}

function notionHeaders(token) {
  return {
    "Authorization":  `Bearer ${token}`,
    "Content-Type":   "application/json",
    "Notion-Version": "2022-06-28",
  };
}
