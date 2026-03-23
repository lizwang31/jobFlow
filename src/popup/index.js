// ═══════════════════════════════════════════════════════════════════════════
//  JobFlow Popup — with RAG analysis UI (zero-backend edition)
// ═══════════════════════════════════════════════════════════════════════════

// RAG helpers — loaded lazily so popup opens fast
let _ragLoaded = false;
let extractTextFromFile, chunkText, embedTexts, saveResumeIndex, hasResumeIndex, analyzeJob, shouldUsePinecone, syncResumeIndexToPinecone;
let cardEventsBound = false;

async function loadRag() {
  if (_ragLoaded) return;

  const embedderMod = await import(chrome.runtime.getURL("src/rag/embedder.js"));
  const retrieverMod = await import(chrome.runtime.getURL("src/rag/retriever.js"));
  const analyzerMod = await import(chrome.runtime.getURL("src/rag/analyzer.js"));

  extractTextFromFile = embedderMod.extractTextFromFile;
  chunkText = embedderMod.chunkText;
  embedTexts = embedderMod.embedTexts;

  saveResumeIndex = retrieverMod.saveResumeIndex;
  hasResumeIndex = retrieverMod.hasResumeIndex;
  shouldUsePinecone = retrieverMod.shouldUsePinecone;
  syncResumeIndexToPinecone = retrieverMod.syncResumeIndexToPinecone;

  analyzeJob = analyzerMod.analyzeJob;
  _ragLoaded = true;
}

const STATUS_OPTIONS = ["Applied","Viewed","Interview","Offer","Rejected","Archived"];
const STATUS_LABELS  = { Applied:"Applied", Viewed:"Viewed", Interview:"Interviewing", Offer:"Offer", Rejected:"Rejected", Archived:"Archived" };

let allJobs = [];
let settings = {};
let selectedFile = null;
let resumeIndexed = false;
const DEFAULT_OPENAI_MODEL = "gpt-5.1";
const DEFAULT_OPENAI_REASONING = "medium";

// ───────────────────────────────────────────────────────────────────────────
//  Init
// ───────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  settings = await loadSettings();
  allJobs  = await msg("GET_JOBS");
  await checkResumeStatus();
  renderJobs();
  bindTabs();
  bindSettings();
  bindResumeUpload();
  document.getElementById("refresh-btn").addEventListener("click", async () => {
    allJobs = await msg("GET_JOBS");
    renderJobs();
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  Jobs rendering
// ───────────────────────────────────────────────────────────────────────────

function renderJobs() {
  const list = document.getElementById("job-list");
  if (!allJobs.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-title">No applications yet</div><div class="empty-text">After you apply on LinkedIn or Indeed,<br>your records will appear here automatically</div></div>`;
    return;
  }
  list.innerHTML = allJobs.map(cardHTML).join("");
  bindCardEvents();
}

function cardHTML(job) {
  const platform = (job.platform || "").toLowerCase();
  const score = job.matchScore;
  const scorePill = score != null
    ? `<span class="score-pill ${score >= 70 ? "score-high" : score >= 45 ? "score-mid" : "score-low"}">${score}% Match</span>`
    : "";
  return `
<div class="job-card" data-id="${job.id}">
  <div class="job-top">
    <div>
      <div class="job-title">${esc(job.title||"Unknown Position")}</div>
      <div class="job-company">${esc(job.company||"Unknown Company")}${job.location?" · "+esc(job.location):""}</div>
    </div>
    <button class="delete-btn" data-id="${job.id}">×</button>
  </div>
  <div class="job-meta">
    <span class="badge badge-${platform}">${esc(job.platform||"")}</span>
    <span class="date-label">${formatDate(job.appliedAt)}</span>
    ${scorePill}
  </div>
  <div class="job-actions">
    <select class="status-select" data-id="${job.id}" data-status="${job.status}">
      ${STATUS_OPTIONS.map(s=>`<option value="${s}" ${s===job.status?"selected":""}>${STATUS_LABELS[s]||s}</option>`).join("")}
    </select>
    <div style="display:flex;align-items:center;gap:8px">
      <span class="sync-dot ${job.notionSynced?"on":"off"}"></span>
      <span class="sync-label">${job.notionSynced?"Synced":"Not synced"}</span>
      <button class="btn-analyze" data-id="${job.id}" ${!resumeIndexed||!settings.openaiKey?"disabled":""}>
        ${job.matchScore != null ? "Analyze Again" : "AI Analyze"}
      </button>
    </div>
  </div>
  <div class="analysis-box" id="analysis-${job.id}">
    ${job.analysis ? renderAnalysisContent(job.analysis) : ""}
  </div>
</div>`;
}

function bindCardEvents() {
  const list = document.getElementById("job-list");
  if (!list || cardEventsBound) return;

  list.addEventListener("change", async e => {
    const sel = e.target.closest(".status-select");
    if (!sel) return;

    const id = sel.dataset.id;
    sel.dataset.status = sel.value;
    await msg("UPDATE_STATUS", { jobId: id, status: sel.value });
    allJobs = allJobs.map(j => j.id === id ? { ...j, status: sel.value } : j);
  });

  list.addEventListener("click", async e => {
    const delBtn = e.target.closest(".delete-btn");
    if (delBtn) {
      const id = delBtn.dataset.id;
      await msg("DELETE_JOB", { jobId: id });
      allJobs = allJobs.filter(j => j.id !== id);
      renderJobs();
      return;
    }

    const analyzeBtn = e.target.closest(".btn-analyze");
    if (analyzeBtn) {
      runAnalysis(analyzeBtn.dataset.id);
      return;
    }

    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) {
      copyText(copyBtn);
      return;
    }

    const tab = e.target.closest(".a-tab");
    if (!tab) return;

    const box = tab.closest(".analysis-box");
    const key = tab.dataset.atab;
    if (!box || !key) return;

    box.querySelectorAll(".a-tab").forEach(t => t.classList.remove("active"));
    box.querySelectorAll(".a-content").forEach(c => c.classList.remove("active"));
    tab.classList.add("active");
    box.querySelector(`[data-acontent="${key}"]`)?.classList.add("active");
  });

  cardEventsBound = true;
}

// ───────────────────────────────────────────────────────────────────────────
//  RAG Analysis
// ───────────────────────────────────────────────────────────────────────────

async function runAnalysis(jobId) {
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;

  const box = document.getElementById(`analysis-${jobId}`);
  box.classList.add("open");
  box.innerHTML = `<div class="analysis-loading"><div class="spinner"></div>Retrieving resume context and analyzing the JD...</div>`;

  const btn = document.querySelector(`.btn-analyze[data-id="${jobId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Analyzing..."; }

  try {
    // Direct RAG call — no backend needed
    await loadRag();
    const data = await analyzeJob(job, {
      openaiKey:    settings.openaiKey,
      anthropicKey: settings.anthropicKey,
      pineconeKey:  settings.pineconeKey,
      pineconeHost: settings.pineconeHost,
      llmProvider:  settings.llmProvider || "openai",
      openaiModel: settings.openaiModel || DEFAULT_OPENAI_MODEL,
      openaiReasoningEffort: settings.openaiReasoningEffort || DEFAULT_OPENAI_REASONING,
    });
    data.success = true;

    // Persist score + analysis into local job record
    allJobs = allJobs.map(j => j.id === jobId
      ? { ...j, matchScore: data.matchScore, analysis: data }
      : j);
    const saveResult = await msg("SAVE_ANALYSIS", { jobId, matchScore: data.matchScore, analysis: data });

    // Re-render card to update score pill
    const card = document.querySelector(`.job-card[data-id="${jobId}"]`);
    if (card) {
      const newCard = document.createElement("div");
      newCard.innerHTML = cardHTML(allJobs.find(j => j.id === jobId));
      card.replaceWith(newCard.firstElementChild);
      const newBox = document.getElementById(`analysis-${jobId}`);
      newBox.classList.add("open");
      newBox.innerHTML = renderAnalysisContent(data);

      if (saveResult?.notionError) {
        const warn = document.createElement("div");
        warn.style.cssText = "color:var(--amber);font-size:11px;padding-top:8px";
        warn.textContent = `Notion sync failed: ${saveResult.notionError}`;
        newBox.appendChild(warn);
      }
    }

    const liveBtn = document.querySelector(`.btn-analyze[data-id="${jobId}"]`);
    if (liveBtn) {
      liveBtn.disabled = false;
      liveBtn.textContent = "Analyze Again";
    }
  } catch (err) {
    box.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px 0">Analysis failed: ${esc(err.message)}</div>`;
    if (btn) {
      btn.disabled = false;
      btn.textContent = job.matchScore != null ? "Analyze Again" : "AI Analyze";
    }
  }
}

function renderAnalysisContent(data) {
  if (!data) return "";
  const scoreColor = data.matchScore >= 70 ? "var(--green)" : data.matchScore >= 45 ? "var(--amber)" : "var(--red)";
  const scoreBreakdown = [
    data.keywordScore != null ? `Keyword ${data.keywordScore}` : "",
    data.semanticScore != null ? `Semantic ${data.semanticScore}` : "",
  ].filter(Boolean).join("  •  ");
  const strengthTags = (data.strengths || []).map(s => `<span class="tag tag-green">${esc(s)}</span>`).join("");
  const gapTags = (data.gaps || []).map(g => `<span class="tag tag-red">${esc(g)}</span>`).join("");
  const questions = (data.interviewQs || []).map(q => `
    <div class="q-item">
      <div class="q-text">${esc(q.q)}</div>
      ${q.hint ? `<div class="q-hint">💡 ${esc(q.hint)}</div>` : ""}
    </div>`).join("");

  return `
<div class="analysis-tabs">
  <button class="a-tab active" data-atab="match">Match</button>
  <button class="a-tab" data-atab="cl">Cover Letter</button>
  <button class="a-tab" data-atab="interview">Interview Prep</button>
</div>

<div class="a-content active" data-acontent="match">
  <div class="score-row">
    <div class="score-num" style="color:${scoreColor}">${data.matchScore}</div>
    <div class="score-bar-wrap"><div class="score-bar" style="width:${data.matchScore}%;background:${scoreColor}"></div></div>
  </div>
  ${scoreBreakdown ? `<div class="summary-text" style="margin-top:-4px;margin-bottom:8px">Calculated from ${esc(scoreBreakdown)}</div>` : ""}
  <div class="summary-text">${esc(data.matchSummary || "")}</div>
  ${strengthTags ? `<div class="section-label">Strengths</div><div class="tag-list">${strengthTags}</div>` : ""}
  ${gapTags ? `<div class="section-label" style="margin-top:8px">Gaps</div><div class="tag-list">${gapTags}</div>` : ""}
  ${data.keywordsMatched?.length ? `<div class="section-label" style="margin-top:8px">Matched Keywords</div><div class="tag-list">${data.keywordsMatched.map(k => `<span class="tag tag-green">${esc(k)}</span>`).join("")}</div>` : ""}
  ${data.keywordsMissing?.length ? `<div class="section-label" style="margin-top:8px">Missing Keywords</div><div class="tag-list">${data.keywordsMissing.map(k => `<span class="tag tag-red">${esc(k)}</span>`).join("")}</div>` : ""}
</div>

<div class="a-content" data-acontent="cl">
  <div class="cl-text" id="cl-text-${Math.random().toString(36).slice(2)}">${esc(data.coverLetter || "")}</div>
  <button class="copy-btn" type="button">Copy Cover Letter</button>
</div>

<div class="a-content" data-acontent="interview">
  <div class="q-list">${questions || '<div style="color:var(--muted);font-size:12px">No interview questions predicted yet</div>'}</div>
</div>`;
}

// ───────────────────────────────────────────────────────────────────────────
//  Resume upload
// ───────────────────────────────────────────────────────────────────────────

function bindResumeUpload() {
  const area     = document.getElementById("upload-area");
  const fileInput= document.getElementById("resume-file-input");
  const uploadBtn= document.getElementById("upload-btn");
  const reindexBtn = document.getElementById("reindex-btn");

  area.addEventListener("click", () => fileInput.click());
  area.addEventListener("dragover", e => { e.preventDefault(); area.classList.add("drag"); });
  area.addEventListener("dragleave", () => area.classList.remove("drag"));
  area.addEventListener("drop", e => {
    e.preventDefault(); area.classList.remove("drag");
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });
  uploadBtn.addEventListener("click", doUpload);
  reindexBtn.addEventListener("click", () => {
    document.getElementById("resume-indexed-info").classList.remove("show");
    area.style.display = "";
    reindexBtn.style.display = "none";
    uploadBtn.style.display = "";
    fileInput.click();
  });
}

function setFile(file) {
  selectedFile = file;
  const uploadBtn = document.getElementById("upload-btn");
  uploadBtn.disabled = false;
  uploadBtn.textContent = `Upload "${file.name}"`;
  setFeedback("upload-feedback", "", "");
}

async function doUpload() {
  if (!selectedFile) return;
  if (!settings.openaiKey) {
    return setFeedback("upload-feedback", "Please add your OpenAI key in Settings first", "err");
  }

  const btn = document.getElementById("upload-btn");
  btn.disabled = true;
  btn.textContent = "Processing...";
  showProgress(true);

  try {
    await loadRag();

    setProgressLabel("Reading resume...");
    setProgress(15);

    const resumeText = await extractTextFromFile(selectedFile);
    if (!resumeText || resumeText.trim().length < 100) {
      throw new Error("Could not extract enough text from the resume. Make sure the PDF is text-based, or upload a TXT file instead.");
    }

    console.log("[Popup] Resume text length:", resumeText.length);
    console.log("[Popup] Resume preview:", resumeText.slice(0, 500));

    setProgressLabel("Chunking text...");
    setProgress(35);

    const chunks = chunkText(resumeText);
    if (!chunks.length) {
      throw new Error("Failed to chunk the resume. Please check the file contents.");
    }

    console.log("[Popup] Chunk count:", chunks.length);
    console.log(
      "[Popup] Chunk previews:",
      chunks.map((c, i) => ({
        i,
        len: c.length,
        preview: c.slice(0, 120),
      }))
    );

    setProgressLabel(`Embedding ${chunks.length} text chunks...`);
    setProgress(60);

    const embeddings = await embedTexts(chunks, settings.openaiKey);
    if (!embeddings.length || embeddings.length !== chunks.length) {
      throw new Error("Embedding failed: the number of embeddings does not match the number of chunks.");
    }

    console.log("[Popup] Embedding count:", embeddings.length);

    setProgressLabel("Saving local index...");
    setProgress(85);

    await saveResumeIndex({
      fileName: selectedFile.name,
      rawText: resumeText,
      chunks,
      embeddings,
    });

    if (shouldUsePinecone(settings)) {
      setProgressLabel("Syncing Pinecone...");
      setProgress(92);
      await syncResumeIndexToPinecone({
        fileName: selectedFile.name,
        chunks,
        embeddings,
      }, settings).catch(err => {
        console.warn("[Popup] Pinecone resume sync failed, local index retained:", err);
      });
    }

    const chunksIndexed = chunks.length;

    await chrome.storage.local.set({
      resumeIndexed: true,
      resumeFileName: selectedFile.name,
      resumeChunks: chunksIndexed,
    });

    resumeIndexed = true;
    updateResumeBadge(true);
    showResumeIndexedInfo(selectedFile.name, chunksIndexed);

    setProgress(100);
    setProgressLabel("Done!");
    setFeedback("upload-feedback", `✓ Indexed ${chunksIndexed} text chunks successfully`, "ok");
    selectedFile = null;
    document.getElementById("resume-file-input").value = "";
    btn.disabled = false;
    btn.textContent = "Upload Complete";
    // Refresh analysis button availability
    renderJobs();

    setTimeout(() => showProgress(false), 1200);
  } catch (err) {
    console.error("[Popup] Resume upload failed:", err);
    showProgress(false);
    btn.disabled = false;
    btn.textContent = "Retry";
    setFeedback("upload-feedback", err.message || "Upload failed", "err");
  }
}

async function checkResumeStatus() {
  await loadRag();

  const local = await chrome.storage.local.get([
    "resumeIndexed",
    "resumeFileName",
    "resumeChunks"
  ]);

  const actualIndexed = await hasResumeIndex().catch(() => false);

  if (actualIndexed) {
    resumeIndexed = true;
    updateResumeBadge(true);
    showResumeIndexedInfo(local.resumeFileName, local.resumeChunks);
  } else {
  resumeIndexed = false;
  updateResumeBadge(false);
  document.getElementById("resume-indexed-info").classList.remove("show");
  document.getElementById("upload-area").style.display = "";
  document.getElementById("upload-btn").style.display = "";
  document.getElementById("reindex-btn").style.display = "none";
  }
}

function showResumeIndexedInfo(fileName, chunks) {
  const info = document.getElementById("resume-indexed-info");
  info.classList.add("show");
  document.getElementById("resume-indexed-sub").textContent =
    `${fileName || "resume"}  ·  ${chunks ?? "?"} text chunks indexed`;
  document.getElementById("upload-area").style.display = "none";
  document.getElementById("upload-btn").style.display = "none";
  document.getElementById("reindex-btn").style.display = "";
}

function updateResumeBadge(indexed) {
  const badge = document.getElementById("resume-badge");
  if (indexed) {
    badge.textContent = "Resume Ready";
    badge.className = "resume-status ready";
  } else {
    badge.textContent = "Resume Missing";
    badge.className = "resume-status missing";
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  Tabs
// ───────────────────────────────────────────────────────────────────────────

function bindTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`panel-${tab.dataset.tab}`)?.classList.add("active");
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
//  Settings
// ───────────────────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = await chrome.storage.sync.get([
    "notionToken","notionDbId",
    "openaiKey","anthropicKey","pineconeKey","pineconeHost","llmProvider",
    "openaiModel","openaiReasoningEffort"
  ]);
  document.getElementById("s-notion-token").value  = s.notionToken  || "";
  document.getElementById("s-notion-db").value     = s.notionDbId   || "";
  document.getElementById("s-openai").value        = s.openaiKey    || "";
  document.getElementById("s-anthropic").value     = s.anthropicKey || "";
  document.getElementById("s-pinecone-key").value  = s.pineconeKey  || "";
  document.getElementById("s-pinecone-host").value = s.pineconeHost || "";
  document.getElementById("s-openai-model").value = s.openaiModel || DEFAULT_OPENAI_MODEL;
  document.getElementById("s-openai-reasoning").value = s.openaiReasoningEffort || DEFAULT_OPENAI_REASONING;
  document.querySelectorAll(".llm-opt").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.llm === (s.llmProvider || "openai"));
  });
  return s;
}

function bindSettings() {
  document.querySelectorAll(".llm-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".llm-opt").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      settings.llmProvider = btn.dataset.llm;
    });
  });

  document.getElementById("save-settings-btn").addEventListener("click", async () => {
    const updated = {
      notionToken:  document.getElementById("s-notion-token").value.trim(),
      notionDbId:   document.getElementById("s-notion-db").value.trim(),
      openaiKey:    document.getElementById("s-openai").value.trim(),
      anthropicKey: document.getElementById("s-anthropic").value.trim(),
      pineconeKey:  document.getElementById("s-pinecone-key").value.trim(),
      pineconeHost: document.getElementById("s-pinecone-host").value.trim(),
      llmProvider:  document.querySelector(".llm-opt.active")?.dataset.llm || "openai",
      openaiModel: document.getElementById("s-openai-model").value || DEFAULT_OPENAI_MODEL,
      openaiReasoningEffort: document.getElementById("s-openai-reasoning").value || DEFAULT_OPENAI_REASONING,
    };
    await chrome.storage.sync.set(updated);
    await chrome.storage.sync.remove("workerUrl");
    settings = { ...settings, ...updated };
    setFeedback("settings-feedback", "✓ Saved", "ok");
    setTimeout(() => setFeedback("settings-feedback", "", ""), 2000);
  });

  document.getElementById("clear-btn").addEventListener("click", async () => {
    if (confirm("Clear all local application records?")) {
      await msg("CLEAR_JOBS");
      allJobs = [];
      renderJobs();
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
//  PDF / text reading
// ───────────────────────────────────────────────────────────────────────────

// async function readFileText(file) {
//   // TXT — read directly
//   if (file.type === "text/plain" || file.name.endsWith(".txt")) {
//     return new Promise((resolve, reject) => {
//       const r = new FileReader();
//       r.onload = () => resolve(r.result);
//       r.onerror = reject;
//       r.readAsText(file);
//     });
//   }

//   // PDF — extract text in-browser using pdf.js
//   if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
//     return extractPdfText(file);
//   }

//   throw new Error("Unsupported file format. Please upload a PDF or TXT file.");
// }

// async function extractPdfText(file) {
//   const arrayBuffer = await file.arrayBuffer();
//   const bytes = new Uint8Array(arrayBuffer);

//   // Decode raw PDF bytes as Latin-1
//   let raw = "";
//   for (let i = 0; i < bytes.length; i++) {
//     raw += String.fromCharCode(bytes[i]);
//   }

//   const textParts = [];

//   // Extract from (text) Tj  and  (text) '  operators
//   const tjRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")/g;
//   let m;
//   while ((m = tjRegex.exec(raw)) !== null) {
//     const decoded = decodePdfString(m[1]);
//     if (decoded.trim()) textParts.push(decoded);
//   }

//   // Extract from [(text) spacing (text)] TJ arrays
//   const tjArrayRegex = /\[([^\]]+)\]\s*TJ/g;
//   while ((m = tjArrayRegex.exec(raw)) !== null) {
//     const strRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
//     let sm;
//     while ((sm = strRegex.exec(m[1])) !== null) {
//       const decoded = decodePdfString(sm[1]);
//       if (decoded.trim()) textParts.push(decoded);
//     }
//   }

//   let text = textParts.join(" ").replace(/\s+/g, " ").trim();

//   // Fallback: grab printable ASCII if regex got too little
//   if (text.length < 100) {
//     const ascii = (raw.match(/[ -~]{4,}/g) || [])
//       .filter(s => /[a-zA-Z]{2,}/.test(s) && !s.startsWith("%"))
//       .join(" ")
//       .replace(/\s+/g, " ")
//       .trim();
//     if (ascii.length > text.length) text = ascii;
//   }

//   if (text.length < 50) {
//     throw new Error("Could not extract PDF text. Please copy the resume content into resume.txt and upload that instead.");
//   }

//   return text;
// }

// function decodePdfString(s) {
//   return s
//     .replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ")
//     .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\")
//     .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
// }

// ───────────────────────────────────────────────────────────────────────────
//  Helpers
// ───────────────────────────────────────────────────────────────────────────

function msg(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function esc(str) {
  return (str || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date(), diff = (now - d) / 1000;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff/60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)} hr ago`;
  if (diff < 604800) {
    const days = Math.floor(diff / 86400);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return d.toLocaleDateString("en-US", { month:"short", day:"numeric" });
}

function setFeedback(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `feedback ${type}`;
}

function showProgress(show) {
  document.getElementById("progress-wrap").classList.toggle("show", show);
}
function setProgressLabel(text) {
  document.getElementById("progress-label").textContent = text;
}
function setProgress(pct) {
  document.getElementById("progress-bar").style.width = pct + "%";
}

function copyText(btn) {
  const cl = btn.previousElementSibling?.textContent || "";
  navigator.clipboard.writeText(cl).then(() => {
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = "Copy Cover Letter"; }, 2000);
  });
}
