// JobFlow - Content Script
// Runs on LinkedIn Jobs and Indeed pages
// Detects apply actions and sends job info to background.js

console.log("[JobFlow] content script file loaded:", window.location.href);

const SITE = (() => {
  const host = window.location.hostname;
  if (host.includes("linkedin.com")) return "linkedin";
  if (host.includes("indeed.com")) return "indeed";
  if (host.includes("greenhouse.io")) return "greenhouse";
  if (host.includes("lever.co")) return "lever";
  if (host.includes("myworkdayjobs.com")) return "workday";
  if (host.includes("bamboohr.com")) return "bamboohr";
  if (host.includes("smartrecruiters.com")) return "smartrecruiters";
  if (host.includes("jobvite.com")) return "jobvite";
  if (host.includes("ashbyhq.com")) return "ashby";
  if (host.includes("breezy.hr")) return "breezy";
  if (host.includes("icims.com")) return "icims";
  return "unknown";
})();

const EXTERNAL_SITES = new Set(["greenhouse","lever","workday","bamboohr","smartrecruiters","jobvite","ashby","breezy","icims"]);

const recordedJobIds = new Set();
let lastPolledJobId = "";
let pendingApplication = null;
let previewAnalysisBusy = false;
let analysisToolsPromise = null;
let previewPromptOpen = false;
let cachedPendingApplicationContext = null;
let cachedLastJobSnapshot = null;
let cachedPreviewAnalysisCache = [];
let lastApplyInteractionAt = 0;
const PENDING_QUEUE_KEY = "jobflow_pending_applications";
const PENDING_APPLICATION_KEY = "jobflow_pending_application_context";
const LAST_JOB_SNAPSHOT_KEY = "jobflow_last_job_snapshot";
const PREVIEW_ANALYSIS_CACHE_KEY = "jobflow_preview_analysis_cache";
const WIDGET_POSITION_KEY = "jobflow_widget_position";
const MAX_JD_TEXT_CHARS = 12000;

// ---------- Debug helpers ----------

function debug(...args) {
  console.log("[JobFlow]", ...args);
}

function debugError(...args) {
  console.error("[JobFlow]", ...args);
}

function isIgnorableRuntimeErrorMessage(message = "") {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("receiving end does not exist") ||
    text.includes("extension context invalidated") ||
    text.includes("the message port closed before a response was received")
  );
}

function markInjected() {
  try {
    document.documentElement.setAttribute("data-jobflow-injected", "yes");
  } catch (e) {
    debugError("Failed to mark injected:", e);
  }
}

function showBadge() {
  try {
    const mount = document.body || document.documentElement;
    if (!mount) {
      setTimeout(showBadge, 200);
      return;
    }

    const old = document.getElementById("jobflow-widget");
    if (old) old.remove();

    const widget = document.createElement("div");
    widget.id = "jobflow-widget";
    widget.style.cssText = `
      position: fixed;
      top: 50%;
      right: 12px;
      z-index: 2147483647;
      pointer-events: none;
    `;
    applyWidgetPosition(widget, loadWidgetPosition());

    const actionBtn = document.createElement("button");
    actionBtn.id = "jobflow-analyze-btn";
    actionBtn.type = "button";
    actionBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="7" width="20" height="14" rx="2.5" fill="rgba(108,110,247,0.18)" stroke="#6c6ef7" stroke-width="1.8"/>
        <path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V7" stroke="#6c6ef7" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="2" y1="13" x2="22" y2="13" stroke="#6c6ef7" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="10" y1="13" x2="14" y2="13" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    actionBtn.dataset.defaultHtml = actionBtn.innerHTML;
    actionBtn.style.cssText = `
      pointer-events: auto;
      border: 1px solid rgba(108,110,247,0.35);
      border-radius: 999px;
      background: rgba(15,15,20,0.92);
      color: #f8fafc;
      font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      width: 38px;
      height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 16px rgba(108,110,247,0.18), 0 2px 8px rgba(0,0,0,0.3);
      cursor: pointer;
      letter-spacing: 0.01em;
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, background 0.18s ease;
      white-space: nowrap;
      touch-action: none;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    `;
    actionBtn.addEventListener("mouseenter", () => {
      actionBtn.style.transform = "translateY(-2px) scale(1.06)";
      actionBtn.style.boxShadow = "0 8px 24px rgba(108,110,247,0.32), 0 2px 8px rgba(0,0,0,0.3)";
      actionBtn.style.borderColor = "rgba(108,110,247,0.7)";
      actionBtn.style.background = "rgba(108,110,247,0.15)";
    });
    actionBtn.addEventListener("mouseleave", () => {
      actionBtn.style.transform = "translateY(0) scale(1)";
      actionBtn.style.boxShadow = "0 4px 16px rgba(108,110,247,0.18), 0 2px 8px rgba(0,0,0,0.3)";
      actionBtn.style.borderColor = "rgba(108,110,247,0.35)";
      actionBtn.style.background = "rgba(15,15,20,0.92)";
    });
    widget.appendChild(actionBtn);
    mount.appendChild(widget);
    makeWidgetDraggable(widget, actionBtn);
  } catch (e) {
    debugError("Failed to show badge:", e);
  }
}

function ensurePreviewPanel() {
  let panel = document.getElementById("jobflow-preview-panel");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "jobflow-preview-panel";
  panel.style.cssText = `
    position: fixed;
    top: 80px;
    right: 56px;
    z-index: 2147483647;
    width: min(360px, calc(100vw - 120px));
    max-height: min(76vh, 760px);
    overflow: auto;
    border-radius: 18px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(11,15,24,0.96);
    color: #e5e7eb;
    box-shadow: 0 24px 54px rgba(0,0,0,0.34);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  document.body.appendChild(panel);
  positionFloatingSurface(panel, 360, 520);
  return panel;
}

function closePreviewPanel() {
  document.getElementById("jobflow-preview-panel")?.remove();
}

function closePreviewPrompt() {
  document.getElementById("jobflow-preview-prompt")?.remove();
  previewPromptOpen = false;
}

function showGenericSavePrompt() {
  closePreviewPrompt();
  const job = sanitizeJobPayload(extractGenericJobInfo());
  const hasJd = (job.jdText || "").length > 200;

  const prompt = document.createElement("div");
  prompt.id = "jobflow-preview-prompt";
  prompt.style.cssText = `
    position: fixed;
    top: 80px;
    right: 56px;
    z-index: 2147483647;
    width: min(300px, calc(100vw - 120px));
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(11,15,24,0.97);
    color: #e5e7eb;
    box-shadow: 0 20px 44px rgba(0,0,0,0.32);
    padding: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  const labelStyle = `display:block;font-size:10px;font-weight:600;color:#64748b;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:4px`;
  const inputStyle = `width:100%;background:#1e2130;border:1px solid rgba(108,110,247,0.25);border-radius:8px;color:#f1f5f9;font-size:13px;padding:7px 10px;outline:none;box-sizing:border-box;font-family:inherit`;

  prompt.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:11px;color:#6c6ef7;font-weight:700;letter-spacing:0.06em;text-transform:uppercase">Save Job</div>
      <div style="font-size:10px;color:#475569">${escapeHtml(job.platform || "External")}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
      <div>
        <label style="${labelStyle}">Job Title</label>
        <input id="nt-save-title" value="${escapeHtml(job.title)}" placeholder="e.g. Software Engineer" style="${inputStyle}"/>
      </div>
      <div>
        <label style="${labelStyle}">Company</label>
        <input id="nt-save-company" value="${escapeHtml(job.company)}" placeholder="e.g. Google" style="${inputStyle}"/>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;align-items:center">
      <button id="jobflow-preview-cancel" type="button" style="border:none;background:transparent;color:#64748b;font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;padding:7px 4px">Cancel</button>
      ${hasJd ? `<button id="nt-save-analyze" type="button" style="border:1px solid rgba(108,110,247,0.35);background:rgba(108,110,247,0.1);color:#a5b4fc;border-radius:8px;padding:7px 12px;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer">Analyze</button>` : ""}
      <button id="nt-save-confirm" type="button" style="border:0;background:linear-gradient(135deg,#6c6ef7 0%,#5254cc 100%);color:#fff;border-radius:8px;padding:7px 14px;font:700 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer">Save Applied</button>
    </div>
  `;

  document.body.appendChild(prompt);
  positionFloatingSurface(prompt, 300, hasJd ? 170 : 150);
  previewPromptOpen = true;

  const getEditedJob = () => ({
    ...job,
    title: prompt.querySelector("#nt-save-title")?.value?.trim() || job.title,
    company: prompt.querySelector("#nt-save-company")?.value?.trim() || job.company,
  });

  prompt.querySelector("#jobflow-preview-cancel")?.addEventListener("click", closePreviewPrompt);

  prompt.querySelector("#nt-save-confirm")?.addEventListener("click", () => {
    const editedJob = getEditedJob();
    closePreviewPrompt();
    sendJobAppliedMessage(editedJob);
    showToast(`✓ Saved: ${editedJob.company} — ${editedJob.title}`);
  });

  prompt.querySelector("#nt-save-analyze")?.addEventListener("click", () => {
    const editedJob = getEditedJob();
    closePreviewPrompt();
    // Merge edits back so analysis uses correct title/company
    cachedLastJobSnapshot = { jobId: editedJob.url, job: editedJob, capturedAt: Date.now(), reason: "manual-external" };
    runPreviewAnalysis();
  });

  setTimeout(() => {
    const handleOutsideClick = (event) => {
      if (!previewPromptOpen) { document.removeEventListener("click", handleOutsideClick, true); return; }
      const actionBtn = document.getElementById("jobflow-analyze-btn");
      if (prompt.contains(event.target) || actionBtn?.contains(event.target)) return;
      closePreviewPrompt();
      document.removeEventListener("click", handleOutsideClick, true);
    };
    document.addEventListener("click", handleOutsideClick, true);
  }, 0);
}

function togglePreviewPrompt() {
  if (previewAnalysisBusy) return;

  if (previewPromptOpen) {
    closePreviewPrompt();
    return;
  }

  if (SITE !== "linkedin" && SITE !== "indeed") {
    showGenericSavePrompt();
    return;
  }

  const actionBtn = document.getElementById("jobflow-analyze-btn");
  if (!actionBtn) return;

  closePreviewPrompt();
  const prompt = document.createElement("div");
  prompt.id = "jobflow-preview-prompt";
  prompt.style.cssText = `
    position: fixed;
    top: 80px;
    right: 56px;
    z-index: 2147483647;
    width: min(280px, calc(100vw - 120px));
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(11,15,24,0.97);
    color: #e5e7eb;
    box-shadow: 0 20px 44px rgba(0,0,0,0.32);
    padding: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  prompt.innerHTML = `
    <div style="font-size:13px;color:#6c6ef7;font-weight:700;letter-spacing:0.04em;text-transform:uppercase">Preview Match</div>
    <div style="font-size:14px;color:#e5e7eb;line-height:1.6;margin-top:8px">Run a resume-to-job match analysis for this role now?</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button id="jobflow-preview-cancel" type="button" style="border:1px solid rgba(255,255,255,0.1);background:transparent;color:#cbd5e1;border-radius:999px;padding:8px 12px;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer">Not now</button>
      <button id="jobflow-preview-confirm" type="button" style="border:0;background:linear-gradient(135deg, #6c6ef7 0%, #5254cc 100%);color:#fff;border-radius:999px;padding:8px 12px;font:700 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer">Run Analysis</button>
    </div>
  `;

  document.body.appendChild(prompt);
  positionFloatingSurface(prompt, 280, 180);
  previewPromptOpen = true;

  prompt.querySelector("#jobflow-preview-cancel")?.addEventListener("click", closePreviewPrompt);
  prompt.querySelector("#jobflow-preview-confirm")?.addEventListener("click", () => {
    closePreviewPrompt();
    runPreviewAnalysis();
  });

  setTimeout(() => {
    const handleOutsideClick = (event) => {
      if (!previewPromptOpen) {
        document.removeEventListener("click", handleOutsideClick, true);
        return;
      }

      const target = event.target;
      if (
        prompt.contains(target) ||
        actionBtn.contains(target)
      ) {
        return;
      }

      closePreviewPrompt();
      document.removeEventListener("click", handleOutsideClick, true);
    };

    document.addEventListener("click", handleOutsideClick, true);
  }, 0);
}

function loadWidgetPosition() {
  try {
    const raw = window.localStorage.getItem(WIDGET_POSITION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    debugError("loadWidgetPosition failed:", e);
    return null;
  }
}

function saveWidgetPosition(position) {
  try {
    if (!position) {
      window.localStorage.removeItem(WIDGET_POSITION_KEY);
      return;
    }
    window.localStorage.setItem(WIDGET_POSITION_KEY, JSON.stringify(position));
  } catch (e) {
    debugError("saveWidgetPosition failed:", e);
  }
}

function applyWidgetPosition(widget, position) {
  if (!widget) return;
  if (position && Number.isFinite(position.top) && Number.isFinite(position.left)) {
    widget.style.top = `${position.top}px`;
    widget.style.left = `${position.left}px`;
    widget.style.right = "auto";
  } else {
    widget.style.top = "50%";
    widget.style.right = "12px";
    widget.style.left = "auto";
    widget.style.transform = "translateY(-50%)";
  }
}

function makeWidgetDraggable(widget, handle) {
  if (!widget || !handle) return;

  let dragState = null;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = widget.getBoundingClientRect();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
      pointerId: event.pointerId,
    };
    handle.setPointerCapture?.(event.pointerId);
    widget.style.transform = "none";
  });

  handle.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const dx = Math.abs(event.clientX - dragState.startX);
    const dy = Math.abs(event.clientY - dragState.startY);
    if (dx > 4 || dy > 4) {
      dragState.moved = true;
    }
    if (!dragState.moved) return;

    const left = clampNumber(event.clientX - dragState.offsetX, 8, window.innerWidth - widget.offsetWidth - 8);
    const top = clampNumber(event.clientY - dragState.offsetY, 8, window.innerHeight - widget.offsetHeight - 8);
    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
    widget.style.right = "auto";
    widget.style.transform = "none";
    repositionFloatingSurfaces();
  });

  const finishDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    handle.releasePointerCapture?.(event.pointerId);

    if (dragState.moved) {
      const rect = widget.getBoundingClientRect();
      saveWidgetPosition({ top: rect.top, left: rect.left });
    } else {
      togglePreviewPrompt();
    }

    dragState = null;
  };

  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getWidgetAnchorRect() {
  return document.getElementById("jobflow-widget")?.getBoundingClientRect() || null;
}

function positionFloatingSurface(el, preferredWidth = 320, preferredHeight = 240) {
  if (!el) return;
  const anchor = getWidgetAnchorRect();
  if (!anchor) return;

  const width = Math.min(preferredWidth, window.innerWidth - 24);
  const height = Math.min(preferredHeight, window.innerHeight - 24);
  const spaceLeft = anchor.left - 12;
  const showLeft = spaceLeft >= width;

  el.style.left = showLeft
    ? `${Math.max(8, anchor.left - width - 12)}px`
    : `${Math.min(window.innerWidth - width - 8, anchor.right + 12)}px`;
  el.style.right = "auto";
  el.style.top = `${clampNumber(anchor.top + (anchor.height / 2) - (height / 2), 8, window.innerHeight - height - 8)}px`;
  el.style.transform = "none";
}

function repositionFloatingSurfaces() {
  positionFloatingSurface(document.getElementById("jobflow-preview-prompt"), 280, 180);
  positionFloatingSurface(document.getElementById("jobflow-preview-panel"), 360, 520);
}

function ensureContentStyles() {
  if (document.getElementById("jobflow-content-styles")) return;
  const style = document.createElement("style");
  style.id = "jobflow-content-styles";
  style.textContent = `
    @keyframes jobflow-spin { to { transform: rotate(360deg); } }
    @keyframes jobflow-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .jobflow-skel {
      background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 100%);
      background-size: 200% 100%;
      animation: jobflow-shimmer 1.5s ease infinite;
      border-radius: 8px;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function isKeyword(text) {
  if (!text || typeof text !== "string") return false;
  if (text.length > 40) return false;
  if (text.split(/\s+/).length > 4) return false;
  if (/[.,;:!?]/.test(text)) return false;
  return true;
}

function setPreviewPanelLoading(title) {
  ensureContentStyles();
  const panel = ensurePreviewPanel();
  panel.innerHTML = `
    <div style="position:sticky;top:0;z-index:10;background:rgba(11,15,24,0.98);padding:14px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-radius:18px 18px 0 0">
      <div>
        <div style="font-size:11px;color:#6c6ef7;font-weight:700;letter-spacing:0.06em;text-transform:uppercase">Preview Analysis</div>
        <div style="font-size:17px;font-weight:700;color:#f8fafc;margin-top:4px">${escapeHtml(title || "Current Job")}</div>
      </div>
      <button id="jobflow-preview-close" type="button" style="border:0;background:transparent;color:#64748b;font-size:20px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:4px;flex-shrink:0">×</button>
    </div>
    <div style="padding:14px 16px">
      <div style="display:flex;align-items:center;gap:10px;color:#64748b;font-size:13px;margin-bottom:18px">
        <div style="width:16px;height:16px;border:2px solid rgba(108,110,247,0.25);border-top-color:#6c6ef7;border-radius:50%;animation:jobflow-spin 0.8s linear infinite;flex-shrink:0"></div>
        Analyzing your resume against this job...
      </div>
      <div class="jobflow-skel" style="height:52px;margin-bottom:10px"></div>
      <div class="jobflow-skel" style="height:20px;width:75%;margin-bottom:8px"></div>
      <div class="jobflow-skel" style="height:20px;width:88%;margin-bottom:8px"></div>
      <div class="jobflow-skel" style="height:20px;width:62%;margin-bottom:18px"></div>
      <div class="jobflow-skel" style="height:34px;margin-bottom:7px"></div>
      <div class="jobflow-skel" style="height:34px;margin-bottom:7px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:14px">
        ${[1,2,3,4,5,6].map(() => `<div class="jobflow-skel" style="height:30px"></div>`).join("")}
      </div>
    </div>
  `;
  panel.querySelector("#jobflow-preview-close")?.addEventListener("click", closePreviewPanel);
}

function renderPreviewPanel(job, analysis) {
  ensureContentStyles();
  const panel = ensurePreviewPanel();
  const scoreColor = analysis.matchScore >= 70 ? "#34d399" : analysis.matchScore >= 45 ? "#fbbf24" : "#f87171";
  const strengths = (analysis.strengths || []).slice(0, 3);
  const gaps = (analysis.gaps || []).slice(0, 3);
  const matched = (analysis.keywordsMatched || []).filter(isKeyword).slice(0, 20);
  const missing = (analysis.keywordsMissing || []).filter(isKeyword).slice(0, 20);

  panel.innerHTML = `
    <div style="position:sticky;top:0;z-index:10;background:rgba(11,15,24,0.98);padding:14px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-radius:18px 18px 0 0">
      <div>
        <div style="font-size:11px;color:#6c6ef7;font-weight:700;letter-spacing:0.06em;text-transform:uppercase">Preview Analysis</div>
        <div style="font-size:17px;font-weight:700;color:#f8fafc;margin-top:4px">${escapeHtml(job.title || "Current Job")}</div>
        <div style="font-size:12px;color:#475569;margin-top:2px">${escapeHtml(job.company || "")}</div>
      </div>
      <button id="jobflow-preview-close" type="button" style="border:0;background:transparent;color:#64748b;font-size:20px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:4px;flex-shrink:0">×</button>
    </div>
    <div style="padding:14px 16px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div style="font-size:42px;font-weight:800;color:${scoreColor};line-height:1">${analysis.matchScore ?? "-"}</div>
        <div style="flex:1">
          <div style="height:5px;background:rgba(255,255,255,0.07);border-radius:3px;overflow:hidden;margin-bottom:7px">
            <div style="height:100%;width:${analysis.matchScore ?? 0}%;background:${scoreColor};border-radius:3px"></div>
          </div>
          <div style="font-size:11px;color:#475569">Keyword ${analysis.keywordScore ?? "-"}  ·  Semantic ${analysis.semanticScore ?? "-"}</div>
        </div>
      </div>
      <div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-bottom:14px">${escapeHtml(analysis.matchSummary || "")}</div>
      ${renderPreviewList("Strengths", strengths, "rgba(52,211,153,0.07)", "#34d399", "rgba(52,211,153,0.15)")}
      ${renderPreviewList("Gaps", gaps, "rgba(248,113,113,0.07)", "#f87171", "rgba(248,113,113,0.15)")}
      ${renderKeywordSection(matched, missing)}
    </div>
  `;
  panel.querySelector("#jobflow-preview-close")?.addEventListener("click", closePreviewPanel);
}

function renderPreviewError(title, message) {
  const panel = ensurePreviewPanel();
  panel.innerHTML = `
    <div style="position:sticky;top:0;z-index:10;background:rgba(11,15,24,0.98);padding:14px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-radius:18px 18px 0 0">
      <div>
        <div style="font-size:11px;color:#6c6ef7;font-weight:700;letter-spacing:0.06em;text-transform:uppercase">Preview Analysis</div>
        <div style="font-size:17px;font-weight:700;color:#f8fafc;margin-top:4px">${escapeHtml(title || "Current Job")}</div>
      </div>
      <button id="jobflow-preview-close" type="button" style="border:0;background:transparent;color:#64748b;font-size:20px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:4px;flex-shrink:0">×</button>
    </div>
    <div style="padding:14px 16px;font-size:13px;color:#f87171;line-height:1.6">${escapeHtml(message)}</div>
  `;
  panel.querySelector("#jobflow-preview-close")?.addEventListener("click", closePreviewPanel);
}

function renderPreviewList(title, items, bg, color, borderColor) {
  if (!items.length) return "";
  return `
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:8px">${title}</div>
      ${items.map((item) => `
        <div style="font-size:12px;line-height:1.55;background:${bg};color:${color};border:1px solid ${borderColor};border-radius:8px;padding:8px 11px;margin-bottom:6px">${escapeHtml(item)}</div>
      `).join("")}
    </div>
  `;
}

function renderKeywordSection(matched, missing) {
  if (!matched.length && !missing.length) return "";
  const total = matched.length + missing.length;
  const pct = total ? Math.round((matched.length / total) * 100) : 0;
  const statusColor = pct >= 70 ? "#34d399" : pct >= 45 ? "#fbbf24" : "#f87171";
  const statusLabel = pct >= 70 ? "Good" : pct >= 45 ? "Needs Work" : "Weak";
  const allKeywords = [
    ...matched.map(k => ({ text: k, matched: true })),
    ...missing.map(k => ({ text: k, matched: false })),
  ];
  return `
    <div style="margin-top:4px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.05em;text-transform:uppercase">Keyword Match</div>
        <div style="font-size:11px;font-weight:700;color:${statusColor}">${matched.length} / ${total} (${pct}%) · ${statusLabel}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">
        ${allKeywords.map(({ text, matched: m }) => `
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;padding:5px 8px;border-radius:7px;background:${m ? "rgba(52,211,153,0.07)" : "rgba(255,255,255,0.03)"};border:1px solid ${m ? "rgba(52,211,153,0.18)" : "rgba(255,255,255,0.06)"}">
            <span style="color:${m ? "#34d399" : "#475569"};flex-shrink:0;font-size:11px">${m ? "✓" : "✗"}</span>
            <span style="color:${m ? "#d1fae5" : "#64748b"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(text)}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Utilities ----------

function safeText(selector) {
  return document.querySelector(selector)?.innerText?.trim() || "";
}

function firstTextFromRoot(root, selectors) {
  if (!root) return "";
  for (const selector of selectors) {
    const val = root.querySelector(selector)?.innerText?.trim() || "";
    if (val) return val;
  }
  return "";
}

function firstText(selectors) {
  for (const selector of selectors) {
    const val = safeText(selector);
    if (val) return val;
  }
  return "";
}

function cleanLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMultilineText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value, maxChars = MAX_JD_TEXT_CHARS) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim();
}

function sanitizeJobPayload(job = {}) {
  const normalizedSalary = normalizeSalaryText(job.salary || "");
  return {
    ...job,
    title: cleanLine(job.title || "").slice(0, 300) || "Unknown Position",
    company: cleanLine(job.company || "").slice(0, 300) || "Unknown Company",
    location: cleanLine(job.location || "").slice(0, 300),
    salary: normalizedSalary.slice(0, 300),
    jdText: truncateText(job.jdText || ""),
    url: String(job.url || window.location.href).slice(0, 2000),
    platform: cleanLine(job.platform || "").slice(0, 80) || "Unknown",
  };
}

function normalizeSalaryText(value) {
  const text = cleanLine(value || "")
    .replace(/^pay:\s*/i, "")
    .replace(/^salary:\s*/i, "")
    .trim();

  if (!text) return "";
  if (/^(pay|salary|compensation)$/i.test(text)) return "";
  return text;
}

function isLikelyApplicationFlowUrl(url) {
  const text = String(url || "").toLowerCase();
  return (
    text.includes("smartapply") ||
    text.includes("/apply") ||
    text.includes("indeedapply") ||
    text.includes("confirm") ||
    text.includes("review") ||
    text.includes("submitted")
  );
}

function textMatchesAny(text, patterns) {
  const normalized = cleanLine(text).toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

function isSubmissionConfirmationText(text) {
  return textMatchesAny(text, [
    "your application has been submitted",
    "application submitted",
    "application sent",
    "your application was sent",
    "submitted successfully",
    "your application has been sent",
    "we've received your application",
    "thanks for applying",
    "thank you for applying",
    "successfully applied",
    "you applied",
  ]);
}

function isReviewApplicationText(text) {
  return textMatchesAny(text, [
    "please review your application",
    "review your application",
    "confirm your application",
    "complete your application",
    "continue your application",
  ]);
}

function isTransientApplicationStepText(text) {
  return isSubmissionConfirmationText(text) || isReviewApplicationText(text);
}

function getLikelyLinkedInDialog() {
  return document.querySelector(
    [
      ".jobs-easy-apply-modal",
      "[data-test-modal-id='easy-apply-modal']",
      ".jobs-easy-apply-content",
      "div[aria-labelledby*='easy-apply']",
      "[role='dialog']"
    ].join(", ")
  );
}

function extractCompanyFromApplyDialog() {
  const dialog = getLikelyLinkedInDialog();
  if (!dialog) return "";

  const heading = firstTextFromRoot(dialog, [
    "h1",
    "h2",
    "h3",
    "[aria-live='polite']",
    "[data-test-modal-title]"
  ]);

  const match = heading.match(/apply to\s+(.+)$/i);
  return match ? cleanLine(match[1]) : "";
}

function extractActiveCardText(selectorList) {
  return firstText([
    ...selectorList.map((selector) => `.jobs-search-results-list__list-item--active ${selector}`),
    ...selectorList.map((selector) => `.jobs-search__job-details--container ${selector}`),
  ]);
}

function escapeCssAttrValue(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function getLinkedInSearchJobId() {
  try {
    const url = new URL(window.location.href);
    return (url.searchParams.get("currentJobId") || "").trim();
  } catch (_e) {
    return "";
  }
}

function getLinkedInCardByJobId(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return null;

  const escaped = escapeCssAttrValue(id);
  const selectors = [
    `li[data-occludable-job-id="${escaped}"]`,
    `div[data-occludable-job-id="${escaped}"]`,
    `[data-job-id="${escaped}"]`,
    `a[href*="currentJobId=${escaped}"]`,
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node) return node;
  }

  return null;
}

function getCurrentJobId() {
  try {
    const url = new URL(window.location.href);
    const fromSearch =
      url.searchParams.get("currentJobId") ||
      url.searchParams.get("jk") ||
      url.searchParams.get("vjk");

    if (fromSearch) return fromSearch;

    const path = url.pathname || "";
    const title = extractJobInfo().title || "";
    const company = extractJobInfo().company || "";

    return [SITE, path, title, company].filter(Boolean).join("|");
  } catch (e) {
    debugError("getCurrentJobId failed:", e);
    return "";
  }
}

function isSubmissionConfirmationPage() {
  const heading = cleanLine(document.querySelector("h1")?.innerText || "");
  const body = cleanLine(document.body?.innerText || "").slice(0, 500);
  return isSubmissionConfirmationText(heading) || isSubmissionConfirmationText(body);
}

function showToast(msg) {
  try {
    const mount = document.body || document.documentElement;
    if (!mount) return;

    const existing = document.getElementById("jt-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "jt-toast";
    toast.textContent = msg;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #18181b;
      color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      padding: 10px 16px;
      border-radius: 8px;
      z-index: 2147483647;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      max-width: 320px;
      line-height: 1.5;
    `;

    mount.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  } catch (e) {
    debugError("showToast failed:", e);
  }
}

function storageLocalGet(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (result) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          if (isIgnorableRuntimeErrorMessage(err.message)) {
            debug("storageLocalGet skipped:", key, err.message);
          } else {
            debugError("storageLocalGet failed:", key, err.message);
          }
          resolve(undefined);
          return;
        }
        resolve(result?.[key]);
      });
    } catch (e) {
      if (isIgnorableRuntimeErrorMessage(e?.message)) {
        debug("storageLocalGet skipped:", key, e.message);
      } else {
        debugError("storageLocalGet failed:", key, e);
      }
      resolve(undefined);
    }
  });
}

function storageLocalSet(key, value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => {
        const err = chrome.runtime?.lastError;
        if (err) {
          if (isIgnorableRuntimeErrorMessage(err.message)) {
            debug("storageLocalSet skipped:", key, err.message);
          } else {
            debugError("storageLocalSet failed:", key, err.message);
          }
        }
        resolve();
      });
    } catch (e) {
      if (isIgnorableRuntimeErrorMessage(e?.message)) {
        debug("storageLocalSet skipped:", key, e.message);
      } else {
        debugError("storageLocalSet failed:", key, e);
      }
      resolve();
    }
  });
}

function storageLocalRemove(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(key, () => {
        const err = chrome.runtime?.lastError;
        if (err) {
          if (isIgnorableRuntimeErrorMessage(err.message)) {
            debug("storageLocalRemove skipped:", key, err.message);
          } else {
            debugError("storageLocalRemove failed:", key, err.message);
          }
        }
        resolve();
      });
    } catch (e) {
      if (isIgnorableRuntimeErrorMessage(e?.message)) {
        debug("storageLocalRemove skipped:", key, e.message);
      } else {
        debugError("storageLocalRemove failed:", key, e);
      }
      resolve();
    }
  });
}

async function hydrateSharedState() {
  try {
    const [pendingCtx, lastSnapshot, previewCache] = await Promise.all([
      storageLocalGet(PENDING_APPLICATION_KEY),
      storageLocalGet(LAST_JOB_SNAPSHOT_KEY),
      storageLocalGet(PREVIEW_ANALYSIS_CACHE_KEY),
    ]);

    cachedPendingApplicationContext = getSiteScopedContext(
      pendingCtx || loadJsonFromPageStorage(PENDING_APPLICATION_KEY, null)
    );
    cachedLastJobSnapshot = getSiteScopedContext(
      lastSnapshot || loadJsonFromPageStorage(LAST_JOB_SNAPSHOT_KEY, null)
    );
    cachedPreviewAnalysisCache = Array.isArray(previewCache)
      ? previewCache
      : loadJsonFromPageStorage(PREVIEW_ANALYSIS_CACHE_KEY, []);
  } catch (e) {
    debugError("hydrateSharedState failed:", e);
  }
}

function loadJsonFromPageStorage(key, fallbackValue) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallbackValue;
    return JSON.parse(raw);
  } catch (e) {
    debugError("loadJsonFromPageStorage failed:", key, e);
    return fallbackValue;
  }
}

function loadQueuedApplications() {
  try {
    const raw = window.localStorage.getItem(PENDING_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    debugError("loadQueuedApplications failed:", e);
    return [];
  }
}

function getSiteHostPattern() {
  if (SITE === "linkedin") return "linkedin.com";
  if (SITE === "indeed") return "indeed.com";
  return "";
}

function contextMatchesCurrentSite(context) {
  if (!context) return false;

  const platform = String(context?.job?.platform || context?.platform || "").toLowerCase();
  if (platform) {
    if (platform.includes(SITE)) return true;
    if (SITE === "linkedin" && platform.includes("linkedin")) return true;
    if (SITE === "indeed" && platform.includes("indeed")) return true;
  }

  const hostPattern = getSiteHostPattern();
  const url = String(context?.job?.url || context?.url || "");
  if (hostPattern && url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.includes(hostPattern)) return true;
    } catch (_e) {
      if (url.toLowerCase().includes(hostPattern)) return true;
    }
  }

  return false;
}

function getSiteScopedContext(context) {
  return contextMatchesCurrentSite(context) ? context : null;
}

function saveQueuedApplications(items) {
  try {
    if (!items.length) {
      window.localStorage.removeItem(PENDING_QUEUE_KEY);
      return;
    }

    window.localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(items));
  } catch (e) {
    debugError("saveQueuedApplications failed:", e);
  }
}

function loadPendingApplicationContext() {
  const ctx = cachedPendingApplicationContext || loadJsonFromPageStorage(PENDING_APPLICATION_KEY, null);
  return getSiteScopedContext(ctx);
}

function savePendingApplicationContext(value) {
  try {
    cachedPendingApplicationContext = value || null;
    if (!value) {
      window.localStorage.removeItem(PENDING_APPLICATION_KEY);
      storageLocalRemove(PENDING_APPLICATION_KEY);
      return;
    }

    window.localStorage.setItem(PENDING_APPLICATION_KEY, JSON.stringify(value));
    storageLocalSet(PENDING_APPLICATION_KEY, value);
  } catch (e) {
    debugError("savePendingApplicationContext failed:", e);
  }
}

function loadLastJobSnapshot() {
  const snapshot = cachedLastJobSnapshot || loadJsonFromPageStorage(LAST_JOB_SNAPSHOT_KEY, null);
  return getSiteScopedContext(snapshot);
}

function saveLastJobSnapshot(value) {
  try {
    cachedLastJobSnapshot = value || null;
    if (!value) {
      window.localStorage.removeItem(LAST_JOB_SNAPSHOT_KEY);
      storageLocalRemove(LAST_JOB_SNAPSHOT_KEY);
      return;
    }

    window.localStorage.setItem(LAST_JOB_SNAPSHOT_KEY, JSON.stringify(value));
    storageLocalSet(LAST_JOB_SNAPSHOT_KEY, value);
  } catch (e) {
    debugError("saveLastJobSnapshot failed:", e);
  }
}

function loadPreviewAnalysisCache() {
  if (Array.isArray(cachedPreviewAnalysisCache) && cachedPreviewAnalysisCache.length) {
    return cachedPreviewAnalysisCache;
  }
  const parsed = loadJsonFromPageStorage(PREVIEW_ANALYSIS_CACHE_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

function savePreviewAnalysisCache(items) {
  try {
    cachedPreviewAnalysisCache = Array.isArray(items) ? items.slice(0, 20) : [];
    if (!items?.length) {
      window.localStorage.removeItem(PREVIEW_ANALYSIS_CACHE_KEY);
      storageLocalRemove(PREVIEW_ANALYSIS_CACHE_KEY);
      return;
    }

    window.localStorage.setItem(PREVIEW_ANALYSIS_CACHE_KEY, JSON.stringify(cachedPreviewAnalysisCache));
    storageLocalSet(PREVIEW_ANALYSIS_CACHE_KEY, cachedPreviewAnalysisCache);
  } catch (e) {
    debugError("savePreviewAnalysisCache failed:", e);
  }
}

function getPreviewCacheKeys(job = {}) {
  const keys = [];
  const url = String(job.url || "").trim();
  const title = cleanLine(job.title || "");
  const company = cleanLine(job.company || "");

  if (url) keys.push(`url:${url}`);
  if (title) keys.push(`site:${SITE}|title:${title}|company:${company}`);
  return keys;
}

function savePreviewAnalysisResult(job, analysis) {
  try {
    if (!analysis) return;

    const keys = getPreviewCacheKeys(job);
    if (!keys.length) return;

    const existing = loadPreviewAnalysisCache().filter((item) =>
      !keys.some((key) => item.cacheKey === key || item.cacheKeys?.includes?.(key))
    );

    existing.unshift({
      cacheKey: keys[0],
      cacheKeys: keys,
      url: String(job.url || "").trim(),
      title: cleanLine(job.title || ""),
      company: cleanLine(job.company || ""),
      platform: job.platform || SITE,
      matchScore: analysis.matchScore,
      analysis,
      savedAt: Date.now(),
    });

    savePreviewAnalysisCache(existing);
  } catch (e) {
    debugError("savePreviewAnalysisResult failed:", e);
  }
}

function findPreviewAnalysisForJob(job = {}) {
  const keys = getPreviewCacheKeys(job);
  if (!keys.length) return null;

  return loadPreviewAnalysisCache().find((item) =>
    keys.some((key) => item.cacheKey === key || item.cacheKeys?.includes?.(key))
  ) || null;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome?.runtime?.id) {
        reject(new Error("Extension runtime unavailable."));
        return;
      }

      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function findExistingJobForSync(jobs, job) {
  if (!Array.isArray(jobs) || !job) return null;

  const targetUrl = String(job.url || "").trim();
  const targetTitle = cleanLine(job.title || "").toLowerCase();
  const targetCompany = cleanLine(job.company || "").toLowerCase();

  const candidates = jobs
    .filter((item) => String(item.platform || "").toLowerCase() === String(job.platform || "").toLowerCase())
    .filter((item) => {
      const itemUrl = String(item.url || "").trim();
      const itemTitle = cleanLine(item.title || "").toLowerCase();
      const itemCompany = cleanLine(item.company || "").toLowerCase();

      if (targetUrl && itemUrl && itemUrl === targetUrl) return true;
      if (targetTitle && itemTitle === targetTitle && (!targetCompany || !itemCompany || itemCompany === targetCompany)) {
        return true;
      }
      return false;
    })
    .sort((a, b) => new Date(b.appliedAt || 0).getTime() - new Date(a.appliedAt || 0).getTime());

  return candidates[0] || null;
}

async function syncPreviewAnalysisToExistingJob(job, analysis) {
  try {
    const jobs = await sendRuntimeMessage({ type: "GET_JOBS" });
    const matchedJob = findExistingJobForSync(jobs, job);
    if (!matchedJob?.id) return false;

    const result = await sendRuntimeMessage({
      type: "SAVE_ANALYSIS",
      jobId: matchedJob.id,
      matchScore: analysis.matchScore,
      analysis,
    });

    if (result?.success === false) {
      throw new Error(result.error || "Analysis sync failed.");
    }

    return true;
  } catch (e) {
    debug("syncPreviewAnalysisToExistingJob skipped:", e?.message || e);
    return false;
  }
}

async function loadAnalysisTools() {
  if (!analysisToolsPromise) {
    analysisToolsPromise = Promise.all([
      import(chrome.runtime.getURL("src/rag/analyzer.js")),
      import(chrome.runtime.getURL("src/rag/retriever.js")),
    ]).then(([analyzerMod, retrieverMod]) => ({
      analyzeJob: analyzerMod.analyzeJob,
      hasResumeIndex: retrieverMod.hasResumeIndex,
    }));
  }

  return analysisToolsPromise;
}

async function loadAnalysisSettings() {
  if (!chrome?.storage?.sync?.get) {
    throw new Error("Extension storage is unavailable. Please refresh the page after reloading the extension.");
  }
  return chrome.storage.sync.get([
    "openaiKey",
    "anthropicKey",
    "pineconeKey",
    "pineconeHost",
    "llmProvider",
    "openaiModel",
    "openaiReasoningEffort",
  ]);
}

function getPreviewAnalysisJob() {
  const liveJob = sanitizeJobPayload(extractJobInfo());
  const lastSnapshot = loadLastJobSnapshot();
  const merged = mergeJobContext(liveJob, lastSnapshot?.job || {});
  return merged;
}

async function runPreviewAnalysis() {
  if (previewAnalysisBusy) return;
  closePreviewPrompt();

  if (!chrome?.runtime?.id || !chrome?.storage?.local || !chrome?.storage?.sync) {
    renderPreviewError("Preview Analysis", "Extension context is unavailable. Please refresh the page and try again.");
    return;
  }

  const job = getPreviewAnalysisJob();
  if (!isKnownTitle(job.title) && !job.jdText) {
    showToast("Open a job details page first.");
    return;
  }

  previewAnalysisBusy = true;
  const actionBtn = document.getElementById("jobflow-analyze-btn");
  if (actionBtn) {
    actionBtn.disabled = true;
    actionBtn.innerHTML = `<span>Analyzing...</span>`;
    actionBtn.style.opacity = "0.72";
    actionBtn.style.cursor = "wait";
  }

  setPreviewPanelLoading(job.title || "Current Job");

  try {
    const settings = await loadAnalysisSettings();
    if (!settings.openaiKey) {
      throw new Error("Add your OpenAI API key in Settings first.");
    }

    const { analyzeJob, hasResumeIndex } = await loadAnalysisTools();
    const indexed = await hasResumeIndex();
    if (!indexed) {
      throw new Error("Upload and index your resume first.");
    }

    const analysis = await analyzeJob(job, settings);
    savePreviewAnalysisResult(job, analysis);
    const synced = await syncPreviewAnalysisToExistingJob(job, analysis);
    renderPreviewPanel(job, analysis);
    if (synced) {
      showToast("Analysis synced to your saved application.");
    }
  } catch (e) {
    renderPreviewError(job.title || "Current Job", e?.message || String(e));
  } finally {
    previewAnalysisBusy = false;
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.innerHTML = actionBtn.dataset.defaultHtml || "Analyze Match";
      actionBtn.style.opacity = "1";
      actionBtn.style.cursor = "pointer";
    }
  }
}

function isKnownTitle(value) {
  const text = cleanLine(value);
  return !!text && text !== "Unknown Position" && !isTransientApplicationStepText(text);
}

function isKnownCompany(value) {
  const text = cleanLine(value);
  return !!text && text !== "Unknown Company" && !isTransientApplicationStepText(text);
}

function mergeJobContext(primary = {}, fallback = {}) {
  const primaryTitle = isKnownTitle(primary.title) ? primary.title : fallback.title;
  const primaryCompany = isKnownCompany(primary.company) ? primary.company : fallback.company;
  const primaryUrl = String(primary.url || "").trim();
  const fallbackUrl = String(fallback.url || "").trim();
  const preferFallbackUrl = isLikelyApplicationFlowUrl(primaryUrl) && fallbackUrl;
  return sanitizeJobPayload({
    ...fallback,
    ...primary,
    title: primaryTitle,
    company: primaryCompany,
    location: cleanLine(primary.location) || fallback.location || "",
    salary: cleanLine(primary.salary) || fallback.salary || "",
    jdText: (primary.jdText && !isLikelyApplicationFlowUrl(primaryUrl)) ? primary.jdText : (fallback.jdText || primary.jdText || ""),
    url: preferFallbackUrl ? fallbackUrl : (primaryUrl || fallbackUrl || window.location.href),
    platform: primary.platform || fallback.platform || SITE,
  });
}

function cacheCurrentJobSnapshot(reason = "unknown") {
  try {
    if (isSubmissionConfirmationPage()) return;

    const jobId = getCurrentJobId();
    if (!jobId) return;

    const liveJob = sanitizeJobPayload(extractJobInfo());
    if (!isKnownTitle(liveJob.title) && !isKnownCompany(liveJob.company)) {
      return;
    }

    const previous = loadLastJobSnapshot();
    const mergedJob = mergeJobContext(liveJob, previous?.job || {});
    saveLastJobSnapshot({
      jobId,
      job: mergedJob,
      capturedAt: Date.now(),
      reason,
    });

    debug("Cached current job snapshot:", {
      reason,
      jobId,
      title: mergedJob.title,
      company: mergedJob.company,
    });
  } catch (e) {
    debugError("cacheCurrentJobSnapshot failed:", e);
  }
}

function queueJobForRetry(job) {
  try {
    const queued = loadQueuedApplications();
    const deduped = queued.filter((item) => item.url !== job.url);
    deduped.unshift({
      ...sanitizeJobPayload(job),
      queuedAt: new Date().toISOString(),
    });
    saveQueuedApplications(deduped.slice(0, 20));
    debug("Queued job for retry:", job.title, job.company);
  } catch (e) {
    debugError("queueJobForRetry failed:", e);
  }
}

function flushQueuedApplications() {
  if (!chrome?.runtime?.id) return;

  const queued = loadQueuedApplications();
  if (!queued.length) return;

  debug("Flushing queued applications:", queued.length);

  queued.forEach((item) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: "JOB_APPLIED",
          payload: {
            ...item,
            appliedAt: item.appliedAt || new Date().toISOString(),
          }
        },
        (response) => {
          const err = chrome.runtime.lastError;
          if (err || response?.success === false) {
            debug("Queued application still pending:", item.title, err?.message || response?.error || "");
            return;
          }

          const rest = loadQueuedApplications().filter((queuedItem) => queuedItem.url !== item.url);
          saveQueuedApplications(rest);
          debug("Queued application flushed:", item.title, item.company);
        }
      );
    } catch (e) {
      debug("Queued application flush threw:", item.title, e?.message || e);
    }
  });
}

function capturePendingApplication(reason = "unknown") {
  try {
    const jobId = getCurrentJobId();
    const liveJob = sanitizeJobPayload(extractJobInfo());
    const previousPending = getSiteScopedContext(pendingApplication || loadPendingApplicationContext());
    const lastSnapshot = getSiteScopedContext(loadLastJobSnapshot());
    const snapshotMatches =
      lastSnapshot &&
      (
        lastSnapshot.jobId === jobId ||
        (lastSnapshot.job?.url && liveJob.url && lastSnapshot.job.url === liveJob.url)
      );
    const fallbackJob = snapshotMatches ? lastSnapshot.job : previousPending?.job || {};
    const shouldIgnoreCurrentPageIdentity =
      isReviewApplicationText(liveJob.title) ||
      isReviewApplicationText(document.title) ||
      isSubmissionConfirmationPage();
    const job = shouldIgnoreCurrentPageIdentity
      ? mergeJobContext({}, fallbackJob)
      : mergeJobContext(liveJob, fallbackJob);

    if (!jobId || (!isKnownTitle(job.title) && !isKnownCompany(job.company))) {
      debug("Skipping pending application capture. reason =", reason);
      return;
    }

    pendingApplication = {
      jobId,
      job: {
        ...job,
        title: job.title || "Unknown Position",
        company: job.company || "Unknown Company",
      },
      capturedAt: Date.now(),
      reason,
    };

    savePendingApplicationContext(pendingApplication);
    saveLastJobSnapshot({
      jobId,
      job: pendingApplication.job,
      capturedAt: Date.now(),
      reason: `pending:${reason}`,
    });

    debug("Captured pending application:", {
      reason,
      jobId,
      title: pendingApplication.job.title,
      company: pendingApplication.job.company,
    });
  } catch (e) {
    debugError("capturePendingApplication failed:", e);
  }
}

// ---------- Extractors ----------

function extractLinkedIn() {
  const linkedInJobId = getLinkedInSearchJobId();
  const jobCard = getLinkedInCardByJobId(linkedInJobId);
  const detailRoot = document.querySelector(".jobs-search__job-details--container") || document;

  const title =
    firstTextFromRoot(jobCard, [
      ".job-card-list__title",
      ".job-card-container__link",
      "a[href*='/jobs/view/'] span[aria-hidden='true']",
    ]) ||
    firstTextFromRoot(detailRoot, [
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__job-title a",
      ".jobs-unified-top-card__job-title h1",
      ".jobs-unified-top-card__job-title a",
      ".jobs-unified-top-card__job-title",
      ".jobs-details-top-card__job-title",
      ".jobs-details-top-card__content-container h1",
      "h1.t-24",
      "h1",
    ]) ||
    extractActiveCardText([
    ".job-details-jobs-unified-top-card__job-title h1",
    ".job-details-jobs-unified-top-card__job-title a",
    ".jobs-unified-top-card__job-title h1",
    ".jobs-unified-top-card__job-title a",
    ".jobs-unified-top-card__job-title",
    ".jobs-details-top-card__job-title",
    ".jobs-details-top-card__content-container h1",
    "h1.t-24",
    "h1"
  ]);

  const company =
    firstTextFromRoot(jobCard, [
      ".job-card-container__company-name",
      ".artdeco-entity-lockup__subtitle",
    ]) ||
    firstTextFromRoot(detailRoot, [
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".job-details-jobs-unified-top-card__primary-description a",
      ".job-details-jobs-unified-top-card__primary-description-container a",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__primary-description a",
      ".jobs-unified-top-card__subtitle-primary-grouping a",
      ".jobs-details-top-card__company-url",
      ".topcard__org-name-link",
    ]) ||
    extractActiveCardText([
    ".job-details-jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name",
    ".job-details-jobs-unified-top-card__primary-description a",
    ".job-details-jobs-unified-top-card__primary-description-container a",
    ".jobs-unified-top-card__company-name a",
    ".jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__primary-description a",
    ".jobs-unified-top-card__subtitle-primary-grouping a",
    ".jobs-details-top-card__company-url",
    ".topcard__org-name-link"
  ]) || extractCompanyFromApplyDialog();

  const jobLocation = firstText([
    ".job-details-jobs-unified-top-card__bullet",
    ".jobs-unified-top-card__bullet",
    ".tvm__text.tvm__text--low-emphasis"
  ]);

  const salary = firstText([
    ".job-details-jobs-unified-top-card__job-insight span",
    "[class*='salary']"
  ]);

  const jdText = truncateText(cleanMultilineText(firstText([
    ".jobs-description-content__text--stretch",
    ".jobs-description-content__text",
    ".jobs-description__container .jobs-box__html-content",
    ".jobs-description__content .jobs-description-content__text",
    ".jobs-box__html-content",
    ".jobs-description",
    "[data-job-id] .jobs-description__container",
    ".jobs-search__job-details--container .jobs-box__html-content",
    ".jobs-search__job-details--container .jobs-description-content__text",
    "article.jobs-description__container",
    "[class*='jobs-description__content']",
  ])));

  return {
    title: title || "Unknown Position",
    company: company || "Unknown Company",
    location: jobLocation || "",
    salary: salary || "",
    jdText,
    url: window.location.href,
    platform: "LinkedIn"
  };
}

function extractIndeed() {
  const structured = extractIndeedStructuredData();
  const title = firstText([
    ".jobsearch-JobInfoHeader-title",
    "[data-testid='jobsearch-JobInfoHeader-title']",
    "h1.jobsearch-JobInfoHeader-title",
    "[data-testid='simpler-jobTitle']",
    "[data-testid='jobTitle']",
    "main h1",
    "h1"
  ]) || structured.title || extractIndeedTitleFallback();

  const company = firstText([
    "[data-testid='inlineHeader-companyName'] a",
    "[data-testid='inlineHeader-companyName']",
    ".jobsearch-InlineCompanyRating-companyHeader a",
    ".jobsearch-CompanyInfoWithoutHeaderImage div[data-company-name='true']",
    "[data-testid='company-name']",
    "[data-testid='jobsearch-JobInfoHeader-companyName']",
    "[data-company-name]"
  ]) || structured.company || extractIndeedCompanyFallback();

  const jobLocation = firstText([
    "[data-testid='job-location']",
    ".jobsearch-JobInfoHeader-subtitle [data-testid]"
  ]) || structured.location || "";

  const salary = extractIndeedSalary() || structured.salary || "";

  const jdText = truncateText(cleanMultilineText(firstText([
    "#jobDescriptionText",
    "[data-testid='jobsearch-JobComponent-description']",
    ".jobsearch-JobComponent-description",
    "[data-testid='jobsearch-jobDescriptionText']",
    "main [class*='jobsearch-JobComponent-description']",
  ]) || structured.description || extractIndeedDescriptionFallback()));

  return {
    title: title || "Unknown Position",
    company: company || "Unknown Company",
    location: jobLocation || "",
    salary: salary || "",
    jdText,
    url: structured.url || window.location.href,
    platform: "Indeed"
  };
}

function extractIndeedSalary() {
  const direct = firstText([
    "#salaryInfoAndJobType .attribute_snippet + .attribute_snippet",
    "#salaryInfoAndJobType [data-testid='attribute_snippet'] + [data-testid='attribute_snippet']",
    "[data-testid='salaryInfo']",
    "[data-testid='jobsearch-JobMetadataHeader-item']",
    "[id*='salary'] [class*='attribute_snippet']",
  ]);
  const normalizedDirect = normalizeSalaryText(direct);
  if (normalizedDirect) return normalizedDirect;

  const section = document.querySelector("#salaryInfoAndJobType");
  if (section) {
    const text = cleanMultilineText(section.innerText || "");
    const matched = text.match(/(?:pay|salary)\s*:?\s*([^\n]+)/i);
    const normalized = normalizeSalaryText(matched?.[1] || "");
    if (normalized) return normalized;
  }

  const bodyText = cleanMultilineText(document.querySelector("main")?.innerText || "");
  const bodyMatch = bodyText.match(/(?:pay|salary)\s*:?\s*([$£€cadusd0-9.,\-\s]+(?:per\s+\w+|an?\s+\w+)?)/i);
  return normalizeSalaryText(bodyMatch?.[1] || "");
}

function extractIndeedStructuredData() {
  try {
    const scripts = [...document.querySelectorAll("script[type='application/ld+json']")];
    for (const script of scripts) {
      const raw = script.textContent?.trim();
      if (!raw) continue;
      const items = normalizeJsonLdItems(raw);
      for (const item of items) {
        const type = String(item?.["@type"] || "").toLowerCase();
        if (!type.includes("jobposting")) continue;
        const hiringOrg = item.hiringOrganization || {};
        const baseSalary = item.baseSalary?.value || item.baseSalary || {};
        const jobLocation = Array.isArray(item.jobLocation) ? item.jobLocation[0] : item.jobLocation;
        const address = jobLocation?.address || {};
        return {
          title: cleanLine(item.title || ""),
          company: cleanLine(hiringOrg.name || ""),
          location: cleanLine([
            address.addressLocality,
            address.addressRegion,
            address.addressCountry,
          ].filter(Boolean).join(", ")),
          salary: cleanLine([
            baseSalary.minValue && baseSalary.maxValue
              ? `${baseSalary.minValue}-${baseSalary.maxValue}`
              : "",
            baseSalary.currency || "",
            baseSalary.unitText || "",
          ].filter(Boolean).join(" ")),
          description: cleanMultilineText(stripHtmlTags(item.description || "")),
          url: cleanLine(item.url || ""),
        };
      }
    }
  } catch (e) {
    debugError("extractIndeedStructuredData failed:", e);
  }

  return {
    title: "",
    company: "",
    location: "",
    salary: "",
    description: "",
    url: "",
  };
}

function normalizeJsonLdItems(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.["@graph"])) return parsed["@graph"];
    return [parsed];
  } catch {
    return [];
  }
}

function stripHtmlTags(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function extractIndeedDescriptionFallback() {
  const mainText = cleanMultilineText(document.querySelector("main")?.innerText || "");
  if (!mainText) return "";

  const markers = [
    "full job description",
    "job description",
    "job overview",
    "responsibilities",
    "requirements",
  ];

  const lower = mainText.toLowerCase();
  for (const marker of markers) {
    const index = lower.indexOf(marker);
    if (index >= 0) {
      return mainText.slice(index).trim();
    }
  }

  return "";
}

function extractIndeedTitleFallback() {
  const structured = extractIndeedStructuredData();
  if (structured.title && !isTransientApplicationStepText(structured.title)) {
    return structured.title;
  }
  const ogTitle = cleanLine(document.querySelector("meta[property='og:title']")?.getAttribute("content") || "");
  if (ogTitle && !isTransientApplicationStepText(ogTitle)) {
    return ogTitle.replace(/\s+-\s+job post.*$/i, "").trim();
  }

  const pageTitle = cleanLine(document.title || "");
  if (!pageTitle || isTransientApplicationStepText(pageTitle)) return "";
  if (/indeed/i.test(pageTitle) === false) return pageTitle;

  const candidates = pageTitle
    .split(/\s+-\s+/)
    .map((part) => cleanLine(part))
    .filter(Boolean)
    .filter((part) => !/indeed/i.test(part) && !/job post/i.test(part));

  return candidates[0] || "";
}

function extractIndeedCompanyFallback() {
  const structured = extractIndeedStructuredData();
  if (structured.company) return structured.company;

  const pageTitle = cleanLine(document.title || "");
  const titleParts = pageTitle
    .split(/\s+-\s+/)
    .map((part) => cleanLine(part))
    .filter(Boolean)
    .filter((part) => !/indeed/i.test(part) && !/job post/i.test(part));
  if (titleParts.length >= 2) {
    return titleParts[1];
  }

  const bodyText = cleanMultilineText(document.body?.innerText || "");
  const headingText = cleanMultilineText(document.querySelector("main")?.innerText || "");
  const source = headingText || bodyText;
  if (!source) return "";

  const lines = source
    .split("\n")
    .map((line) => cleanLine(line))
    .filter(Boolean)
    .slice(0, 30);

  for (let i = 0; i < lines.length - 1; i++) {
    const current = lines[i];
    const next = lines[i + 1];

    if (/^[A-Z][\w &.,'-]{1,120}$/.test(current) && /^(remote|hybrid|on-site|full-time|part-time|contract|temporary|internship|casual|\$|cad|usd)/i.test(next)) {
      return current;
    }
  }

  return "";
}

function extractJobInfo() {
  if (SITE === "linkedin") return extractLinkedIn();
  if (SITE === "indeed") return extractIndeed();
  return extractGenericJobInfo();
}

function extractGenericJobInfo() {
  // Job title — try multiple sources, pick the most specific one
  const GENERIC_HEADINGS = ["careers", "jobs", "home", "search", "apply", "opportunities", "job search", "find a job", "search jobs"];
  const h1 = document.querySelector("h1")?.innerText?.trim() || "";
  const h1IsGeneric = !h1 || (h1.length < 50 && GENERIC_HEADINGS.some(g => h1.toLowerCase() === g || h1.toLowerCase().startsWith(g)));
  const h2 = document.querySelector("h2")?.innerText?.trim() || "";
  const h2IsGeneric = !h2 || GENERIC_HEADINGS.some(g => h2.toLowerCase() === g);
  // Page title often has "Job Title | Company" or "Job Title - Company Careers"
  // Take the first non-generic segment (page title usually leads with the job title)
  const titleFromPage = document.title
    .split(/[|\-–·]/)
    .map(s => s.trim())
    .filter(s => s.length > 3 && !GENERIC_HEADINGS.some(g => s.toLowerCase() === g))[0] || "";
  const title = (!h1IsGeneric && h1) || (!h2IsGeneric && h2) || titleFromPage || "Unknown Position";

  // Company — og:site_name > ATS selectors > subdomain > domain fallback
  const ogSite = document.querySelector('meta[property="og:site_name"]')?.content?.trim() || "";
  const atsCompany = firstText([
    "[data-testid='company-name']",
    "[class*='company-name']",
    "[class*='companyName']",
    ".company",
    "[itemprop='hiringOrganization'] [itemprop='name']",
  ]);
  // For subdomains like bmo.wd3.myworkdayjobs.com → use "bmo"
  const GENERIC_SUBDOMAINS = new Set(["jobs", "careers", "www", "apply", "job", "career", "boards", "hire"]);
  const domainCompany = (() => {
    const host = window.location.hostname.replace(/^www\./, "");
    const parts = host.split(".");
    // Try first subdomain if it looks like a company name
    if (parts.length > 2 && !GENERIC_SUBDOMAINS.has(parts[0].toLowerCase())) {
      return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    }
    // Fallback: second-to-last part (e.g. "celestica" from careers.celestica.com)
    const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return GENERIC_SUBDOMAINS.has(name.toLowerCase()) ? "" : name.charAt(0).toUpperCase() + name.slice(1);
  })();
  const company = ogSite || atsCompany || domainCompany || "Unknown Company";

  // Location
  const location = firstText([
    "[data-testid*='location']",
    "[class*='location']",
    "[class*='Location']",
    "[itemprop='jobLocation']",
  ]);

  // JD text — prefer dedicated containers, fallback to <main>/<article>
  const jdEl = document.querySelector([
    "[class*='job-description']",
    "[class*='jobDescription']",
    "[id*='job-description']",
    "[id*='jobDescription']",
    "[class*='description']",
    "main",
    "article",
    "[role='main']",
  ].join(", "));
  const jdText = truncateText(cleanMultilineText(jdEl?.innerText || document.body?.innerText || ""));

  // Platform label
  const platformMap = {
    greenhouse: "Greenhouse",
    lever: "Lever",
    workday: "Workday",
    bamboohr: "BambooHR",
    smartrecruiters: "SmartRecruiters",
    jobvite: "Jobvite",
    ashby: "Ashby",
    breezy: "Breezy",
    icims: "iCIMS",
  };
  const platform = platformMap[SITE] || "External";

  return { title, company, location, salary: "", jdText, url: window.location.href, platform };
}

function isExternalJobPage() {
  // LinkedIn/Indeed handled separately
  if (SITE === "linkedin" || SITE === "indeed") return false;

  const url = window.location.href.toLowerCase();

  // Never show on form/confirmation pages
  const isFormPage =
    url.includes("/apply") ||
    url.includes("/application") ||
    url.includes("submitted") ||
    url.includes("confirm") ||
    url.includes("thank-you") ||
    url.includes("thankyou");
  if (isFormPage) return false;

  // Known ATS platforms — always show on their JD pages
  if (EXTERNAL_SITES.has(SITE)) return true;

  // Unknown company career sites — detect by URL path patterns
  const jobUrlPatterns = [
    "/job/", "/jobs/", "/career/", "/careers/",
    "/position/", "/positions/", "/opening/", "/openings/",
    "/vacancy/", "/requisition/", "/jobdetail", "/job-detail",
    "viewjob", "job_detail", "/opportunities/",
  ];
  const urlLooksLikeJob = jobUrlPatterns.some(p => url.includes(p));
  if (!urlLooksLikeJob) return false;

  // Must have an h1 that looks like a job title (not a homepage)
  const h1 = document.querySelector("h1")?.innerText?.trim() || "";
  return h1.length > 3 && h1.length < 300;
}

// ---------- Recording ----------

function sendJobAppliedMessage(job) {
  const payload = sanitizeJobPayload(job);

  try {
    if (!chrome?.runtime?.id) {
      debug("Runtime unavailable, skipping message send.");
      queueJobForRetry(payload);
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "JOB_APPLIED",
        payload: {
          ...payload,
          appliedAt: new Date().toISOString()
        }
      },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (isIgnorableRuntimeErrorMessage(err.message)) {
            debug("sendMessage skipped:", err.message);
            queueJobForRetry(payload);
          } else {
            debugError("sendMessage failed:", err.message);
          }
          return;
        }

        if (!response) {
          debug("sendMessage completed without a response.");
          return;
        }

        if (response.success === false) {
          debugError("Background rejected JOB_APPLIED:", response.error || response);
          return;
        }

        debug("Background response:", response);
      }
    );
  } catch (e) {
    if (isIgnorableRuntimeErrorMessage(e?.message)) {
      debug("chrome.runtime.sendMessage skipped:", e.message);
      queueJobForRetry(payload);
    } else {
      debugError("chrome.runtime.sendMessage exception:", e);
    }
  }
}

function tryRecordCurrentJob(reason = "unknown") {
  try {
    if (!pendingApplication || !contextMatchesCurrentSite(pendingApplication)) {
      pendingApplication = loadPendingApplicationContext();
    }

    if ((!isKnownTitle(pendingApplication?.job?.title) || !isKnownCompany(pendingApplication?.job?.company))) {
      const snapshot = loadLastJobSnapshot();
      if (snapshot?.job) {
        pendingApplication = pendingApplication
          ? { ...pendingApplication, job: mergeJobContext(pendingApplication.job, snapshot.job) }
          : { jobId: snapshot.jobId, job: snapshot.job, capturedAt: snapshot.capturedAt, reason: "snapshot-fallback" };
      }
    }

    const fallbackJobId = getCurrentJobId();
    const jobId = pendingApplication?.jobId || fallbackJobId;
    if (!jobId) {
      debug("No job id found, skip recording. reason =", reason);
      return;
    }

    if (recordedJobIds.has(jobId)) {
      debug("Already recorded, skip. jobId =", jobId, "reason =", reason);
      return;
    }

    const liveJob = sanitizeJobPayload(extractJobInfo());
    const onConfirmationPage = isSubmissionConfirmationPage();
    const shouldPreferPendingIdentity =
      (/^submitted:/.test(reason) || reason === "success-done") &&
      isKnownTitle(pendingApplication?.job?.title) &&
      isKnownCompany(pendingApplication?.job?.company);
    const job = {
      ...(pendingApplication?.job || {}),
      ...(onConfirmationPage ? {} : liveJob),
      title:
        !shouldPreferPendingIdentity && !onConfirmationPage && liveJob.title && liveJob.title !== "Unknown Position"
          ? liveJob.title
          : pendingApplication?.job?.title || "Unknown Position",
      company:
        !shouldPreferPendingIdentity && !onConfirmationPage && liveJob.company && liveJob.company !== "Unknown Company"
          ? liveJob.company
          : pendingApplication?.job?.company || "Unknown Company",
      location:
        (!onConfirmationPage && liveJob.location) || pendingApplication?.job?.location || "",
      salary:
        (!onConfirmationPage && liveJob.salary) || pendingApplication?.job?.salary || "",
      url:
        pendingApplication?.job?.url || liveJob.url || window.location.href,
      platform:
        pendingApplication?.job?.platform || liveJob.platform || "Unknown",
    };

    const previewAnalysis = findPreviewAnalysisForJob(job);
    if (previewAnalysis?.analysis) {
      job.analysis = previewAnalysis.analysis;
      if (previewAnalysis.matchScore != null) {
        job.matchScore = previewAnalysis.matchScore;
      }
    }

    if (!job.title) job.title = "Unknown Position";
    if (!job.company) job.company = "Unknown Company";

    recordedJobIds.add(jobId);

    debug("Recording job:", {
      reason,
      jobId,
      title: job.title,
      company: job.company,
      url: job.url
    });

    sendJobAppliedMessage(job);
    showToast(`✓ Saved: ${job.company} - ${job.title}`);
    pendingApplication = null;
    savePendingApplicationContext(null);
  } catch (e) {
    debugError("tryRecordCurrentJob failed:", e);
  }
}

// ---------- Apply detection ----------

function isApplyLikeText(text) {
  const normalized = cleanLine(text).toLowerCase();
  if (!normalized) return false;

  return [
    "apply",
    "apply now",
    "easy apply",
    "continue applying",
    "submit application",
    "apply"
  ].some((p) => normalized.includes(p));
}

function isSubmitLikeText(text) {
  return textMatchesAny(text, [
    "submit application",
    "send application",
    "submit your application",
    "submit"
  ]);
}

function getActionContext(element) {
  const clickable = element?.closest?.("button, [role='button'], a, input[type='submit']") || element;
  const text = cleanLine(
    clickable?.innerText ||
    clickable?.textContent ||
    element?.innerText ||
    element?.textContent ||
    ""
  ).toLowerCase();
  const ariaLabel = cleanLine(
    clickable?.getAttribute?.("aria-label") ||
    element?.getAttribute?.("aria-label") ||
    ""
  ).toLowerCase();

  return { clickable, text, ariaLabel };
}

function isApplicationSubmittedText(text) {
  return isSubmissionConfirmationText(text);
}

function markApplyInteraction(reason = "unknown") {
  lastApplyInteractionAt = Date.now();
  debug("Apply interaction marked:", reason, new Date(lastApplyInteractionAt).toISOString());
}

function hasRecentApplyInteraction(maxAgeMs = 15 * 60 * 1000) {
  return Date.now() - lastApplyInteractionAt <= maxAgeMs;
}

function getApplicationSentDialog() {
  const selectors = [
    ".jobs-easy-apply-modal",
    "[data-test-modal-id='easy-apply-modal']",
    ".jobs-easy-apply-content",
    "div[aria-labelledby*='easy-apply']",
    "[role='dialog']",
  ];

  const dialogs = Array.from(document.querySelectorAll(selectors.join(", ")));
  for (const dialog of dialogs) {
    const text = cleanLine(dialog.innerText || dialog.textContent || "");
    if (!text) continue;

    if (
      textMatchesAny(text, [
        "application sent",
        "your application was sent",
        "application submitted",
        "submitted successfully",
      ])
    ) {
      return dialog;
    }
  }

  return null;
}

function scheduleSubmissionCheck(reason) {
  debug("Scheduling submission verification:", reason);
  window.setTimeout(() => checkForApplicationSubmitted(reason), 800);
  window.setTimeout(() => checkForApplicationSubmitted(reason), 1800);
  window.setTimeout(() => checkForApplicationSubmitted(reason), 3200);
  window.setTimeout(() => checkForApplicationSubmitted(reason), 5500);
  window.setTimeout(() => checkForApplicationSubmitted(reason), 9000);
}

function checkForEasyApplyModal() {
  try {
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      const src = iframe.src || "";
      const name = iframe.name || "";

      if (
        src.includes("easy-apply") ||
        iframe.classList.contains("jobs-easy-apply-iframe") ||
        name === "jobs-easy-apply"
      ) {
        if (!iframe.dataset.jtSeen) {
          iframe.dataset.jtSeen = "1";
          debug("Easy Apply iframe detected");
        }
      }
    }

    const modal = getLikelyLinkedInDialog();

    if (modal && !modal.dataset.jtSeen) {
      const modalText = (modal.innerText || "").toLowerCase();
      if (
        modalText.includes("easy apply") ||
        modalText.includes("apply") ||
        modalText.includes("application")
      ) {
        modal.dataset.jtSeen = "1";
        debug("Apply modal detected");
      }
    }
  } catch (e) {
    debugError("checkForEasyApplyModal failed:", e);
  }
}

function checkForApplicationSubmitted(reason = "unknown") {
  try {
    if (!pendingApplication) {
      pendingApplication = loadPendingApplicationContext();
    }

    const recentApply = hasRecentApplyInteraction();

    const successDialog = getApplicationSentDialog();
    const candidates = [
      successDialog,
      document.querySelector("[role='alert']"),
      document.querySelector("[aria-live='assertive']"),
      document.querySelector("[aria-live='polite']"),
      SITE === "indeed" || recentApply ? document.body : null,
    ].filter(Boolean);

    let submitted = candidates.some((node) =>
      isApplicationSubmittedText(node.innerText || node.textContent || "")
    );

    if (!submitted && recentApply && isSubmissionConfirmationPage()) {
      submitted = true;
    }

    if (submitted) {
      debug("Application submission detected:", reason);
      tryRecordCurrentJob(`submitted:${reason}`);
    }
  } catch (e) {
    debugError("checkForApplicationSubmitted failed:", e);
  }
}

function startObserver() {
  const target = document.body || document.documentElement;
  if (!target) {
    debug("No DOM target yet, retrying observer...");
    setTimeout(startObserver, 300);
    return;
  }

  try {
    const observer = new MutationObserver(() => {
      checkForEasyApplyModal();
      checkForApplicationSubmitted("mutation");
    });

    observer.observe(target, { childList: true, subtree: true });
    debug("MutationObserver started");
  } catch (e) {
    debugError("Observer start failed:", e);
  }
}

function installMessageListener() {
  window.addEventListener("message", (e) => {
    try {
      const data = e.data;
      if (!data) return;

      const str = typeof data === "string" ? data : JSON.stringify(data);
      const lower = str.toLowerCase();

      if (
        lower.includes("application submitted") ||
        lower.includes("application sent") ||
        lower.includes("submit application")
      ) {
        debug("postMessage detected:", str.slice(0, 120));
        scheduleSubmissionCheck("postMessage");
      }
    } catch (e2) {
      debugError("message listener failed:", e2);
    }
  });
}

function installPolling() {
  setInterval(() => {
    try {
      const jobId = getCurrentJobId();
      if (jobId && jobId !== lastPolledJobId) {
        lastPolledJobId = jobId;
        debug("Job changed:", jobId);
        cacheCurrentJobSnapshot("poll");
      }
    } catch (e) {
      debugError("polling failed:", e);
    }
  }, 800);
}

function installClickListener() {
  document.addEventListener(
    "click",
    (e) => {
      try {
        const target = e.target;
        if (!target) return;

        const el = target instanceof Element ? target : null;
        if (!el) return;

        const { clickable, text, ariaLabel } = getActionContext(el);

        const isApplyBtn =
          isApplyLikeText(text) ||
          isApplyLikeText(ariaLabel) ||
          !!clickable?.closest?.("[data-control-name='jobdetails_topcard_inapply']") ||
          !!clickable?.closest?.(".jobs-apply-button") ||
          !!clickable?.closest?.("#indeedApplyButton") ||
          !!clickable?.closest?.("[data-testid*='apply']");

        if (isApplyBtn) {
          debug("Apply-like click captured");
          markApplyInteraction("apply-click");
          capturePendingApplication("apply-click");
          setTimeout(() => cacheCurrentJobSnapshot("apply-click-delayed"), 250);
          setTimeout(() => capturePendingApplication("apply-click-delayed"), 400);
          setTimeout(checkForEasyApplyModal, 700);
        }

        const isSubmitBtn =
          isSubmitLikeText(text) ||
          isSubmitLikeText(ariaLabel) ||
          !!clickable?.closest?.("[aria-label*='Submit application']") ||
          !!clickable?.closest?.("[data-easy-apply-submit-button]") ||
          !!clickable?.closest?.("button[form*='easyApply']") ||
          !!clickable?.closest?.("button[type='submit']");

        if (isSubmitBtn) {
          debug("Submit-like click captured");
          markApplyInteraction("submit-click");
          capturePendingApplication("submit-click");
          setTimeout(() => capturePendingApplication("submit-click-delayed"), 250);
          scheduleSubmissionCheck("submit-click");
        }

        const successDialog = getApplicationSentDialog();
        const isDoneBtn =
          SITE === "linkedin" &&
          successDialog &&
          (
            textMatchesAny(text, ["done"]) ||
            textMatchesAny(ariaLabel, ["done"]) ||
            !!clickable?.closest?.("[aria-label='Done']") ||
            !!clickable?.closest?.("button[aria-label*='close']")
          );

        if (isDoneBtn) {
          debug("Done button captured on success dialog");
          markApplyInteraction("done-click");
          tryRecordCurrentJob("success-done");
        }
      } catch (e2) {
        debugError("click listener failed:", e2);
      }
    },
    true
  );
}

// ---------- Init ----------

async function init() {
  try {
    debug("Init start. SITE =", SITE, "URL =", window.location.href);

    await hydrateSharedState();
    flushQueuedApplications();
    setInterval(flushQueuedApplications, 10000);
    window.addEventListener("focus", flushQueuedApplications);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        flushQueuedApplications();
      }
    });
    markInjected();

    const isNativeSite = SITE === "linkedin" || SITE === "indeed";
    const isJobPage = isNativeSite || isExternalJobPage();

    if (isJobPage) {
      showBadge();
      window.addEventListener("resize", repositionFloatingSurfaces);
    }

    // Heavy listeners only needed on LinkedIn/Indeed (auto-submission detection)
    if (isNativeSite) {
      cacheCurrentJobSnapshot("init");
      installMessageListener();
      installPolling();
      installClickListener();
      startObserver();
      setTimeout(checkForEasyApplyModal, 1000);
      setTimeout(checkForEasyApplyModal, 2500);
      setTimeout(() => checkForApplicationSubmitted("init"), 2000);
    }

    debug("Init success");
  } catch (e) {
    debugError("Init failed:", e);
  }
}

init();
