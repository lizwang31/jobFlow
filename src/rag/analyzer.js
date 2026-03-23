// src/rag/analyzer.js
// RAG analysis pipeline: embed JD -> retrieve resume chunks -> prompt LLM -> parse result

import { embedText } from "./embedder.js";
import {
  getResumeIndex,
  retrieveResumeChunks,
  retrievePastJobs,
  saveJobVector,
  syncJobToPinecone,
} from "./retriever.js";

// ---------- Main entry ----------

export async function analyzeJob(job, settings) {
  const {
    openaiKey,
    anthropicKey,
    llmProvider = "openai",
    openaiModel = "gpt-5.1",
    openaiReasoningEffort = "medium",
  } = settings;

  if (!openaiKey) {
    throw new Error("OpenAI API key is required.");
  }

  const jdText = buildJobText(job);
  const resumeIndex = await getResumeIndex();
  const resumeRawText = resumeIndex?.rawText || "";
  const jdVector = await embedText(jdText, openaiKey);

  // 1) Retrieve relevant resume chunks
  const resumeResult = await retrieveResumeChunks(jdVector, 6, settings);
  const resumeMatches = Array.isArray(resumeResult.matches) ? resumeResult.matches : [];

  const resumeContext = resumeMatches
    .map((m, idx) => {
      const text = m.metadata?.text || "";
      const score = typeof m.score === "number" ? m.score.toFixed(3) : "n/a";
      return `[Resume Chunk ${idx + 1} | score=${score}]\n${text}`;
    })
    .join("\n\n");

  if (!resumeContext.trim()) {
    throw new Error("Resume not indexed yet. Please upload your resume first.");
  }

  // 2) Retrieve similar past jobs
  const pastResult = await retrievePastJobs(
    jdVector,
    3,
    settings,
    {
      excludeNotionPageId: job.notionPageId || "",
      excludeJobId: job.id || "",
    }
  );

  const pastMatches = Array.isArray(pastResult.matches) ? pastResult.matches : [];
  const pastContext = pastMatches
    .map((m) => {
      const meta = m.metadata || {};
      return `${meta.title || "Unknown Title"} at ${meta.company || "Unknown Company"} — ${meta.status || "Unknown Status"}`;
    })
    .join("\n");

  // 3) Prompt
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    job,
    jdText,
    resumeContext,
    pastContext,
  });

  // 4) Call LLM
  const raw =
    llmProvider === "anthropic"
      ? await callAnthropic(systemPrompt, userPrompt, anthropicKey)
      : await callOpenAI(systemPrompt, userPrompt, openaiKey, {
        model: openaiModel,
        reasoningEffort: openaiReasoningEffort,
      });

  const parsed = parseAnalysis(raw);
  const keywordAnalysis = analyzeKeywordFit(jdText, resumeRawText, job);
  const semanticScore = clampScore(parsed.matchScore);
  const matchScore = combineScores(keywordAnalysis.keywordScore, semanticScore);

  // 5) Save current job embedding for future similarity lookups
  const jobVectorRecord = {
    id: job.id || `${job.platform || "job"}-${Date.now()}`,
    title: job.title || "",
    company: job.company || "",
    status: job.status || "Applied",
    notionPageId: job.notionPageId || "",
    jdText,
    embedding: jdVector,
    createdAt: new Date().toISOString(),
  };

  try {
    await saveJobVector(jobVectorRecord);
    await syncJobToPinecone(jobVectorRecord, settings);
  } catch (e) {
    console.warn("[Analyzer] Failed to persist job vector:", e);
  }

  return {
    ...parsed,
    semanticScore,
    keywordScore: keywordAnalysis.keywordScore,
    keywordsMatched: keywordAnalysis.keywordsMatched,
    keywordsMissing: keywordAnalysis.keywordsMissing,
    keywordSampleSize: keywordAnalysis.totalKeywords,
    matchScore,
    raw,
    retrievedResumeChunks: resumeMatches,
    retrievedPastJobs: pastMatches,
  };
}

// ---------- Job text builder ----------

function buildJobText(job) {
  const parts = [
    job.title || "",
    job.company || "",
    job.location || "",
    job.salary || "",
    job.jdText || "",
    job.description || "",
  ].filter(Boolean);

  return parts.join("\n\n").trim();
}

function normalizeForKeywordMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#./& -]/g, " ")
    .replace(/\bback-end\b/g, "backend")
    .replace(/\bfront-end\b/g, "frontend")
    .replace(/\bapis\b/g, "api")
    .replace(/\bdatabases\b/g, "database")
    .replace(/\bmicro-services\b/g, "microservices")
    .replace(/\bnodejs\b/g, "node.js")
    .replace(/\s+/g, " ")
    .trim();
}

function clampScore(score) {
  const num = Number(score);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function combineScores(keywordScore, semanticScore) {
  if (keywordScore == null) return semanticScore;
  return clampScore(Math.round((keywordScore * 0.5) + (semanticScore * 0.5)));
}

function analyzeKeywordFit(jdText, resumeText, job = {}) {
  const jd = normalizeForKeywordMatch(jdText);
  const resume = normalizeForKeywordMatch(resumeText);

  const matchedKeywords = [];
  const missingKeywords = [];
  let matchedWeight = 0;
  let totalWeight = 0;

  const activeCatalog = KEYWORD_CATALOG
    .filter((entry) => matchesAnyVariant(jd, entry.variants))
    .slice(0, 20);

  for (const entry of activeCatalog) {
    totalWeight += entry.weight;
    if (matchesAnyVariant(resume, entry.variants)) {
      matchedKeywords.push(entry.label);
      matchedWeight += entry.weight;
    } else {
      missingKeywords.push(entry.label);
    }
  }

  const tokenCandidates = extractWeightedTokenCandidates(jd, job);
  for (const candidate of tokenCandidates) {
    if (matchedKeywords.includes(candidate.label) || missingKeywords.includes(candidate.label)) {
      continue;
    }

    totalWeight += candidate.weight;
    if (matchesAnyVariant(resume, candidate.variants)) {
      matchedKeywords.push(candidate.label);
      matchedWeight += candidate.weight;
    } else {
      missingKeywords.push(candidate.label);
    }
  }

  const keywordScore = totalWeight
    ? clampScore(Math.round((matchedWeight / totalWeight) * 100))
    : null;

  const normalizedMatched = normalizeKeywordList(matchedKeywords);
  const normalizedMissing = normalizeKeywordList(missingKeywords, normalizedMatched);

  return {
    keywordScore,
    keywordsMatched: normalizedMatched,
    keywordsMissing: normalizedMissing,
    totalKeywords: normalizedMatched.length + normalizedMissing.length,
  };
}

function normalizeKeywordList(items = [], exclude = []) {
  const excludeSet = new Set(exclude.map(keywordCanonicalKey));
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const label = cleanKeywordLabel(item);
    if (!label) continue;
    if (!isMeaningfulKeywordLabel(label)) continue;

    const key = keywordCanonicalKey(label);
    if (!key || seen.has(key) || excludeSet.has(key)) continue;

    seen.add(key);
    output.push(label);
  }

  return output;
}

function cleanKeywordLabel(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\bpython\b/gi, "Python")
    .replace(/\bjava\b/gi, "Java")
    .replace(/\baws\b/gi, "AWS")
    .replace(/\bgcp\b/gi, "GCP")
    .replace(/\bgraphql\b/gi, "GraphQL")
    .replace(/\bterraform\b/gi, "Terraform")
    .replace(/\bsnowflake\b/gi, "Snowflake")
    .replace(/\bnode\.?js\b/gi, "Node.js")
    .replace(/\bci\/cd\b/gi, "CI/CD")
    .trim();

  return text;
}

function keywordCanonicalKey(value) {
  return normalizeForKeywordMatch(value)
    .replace(/\bpython\b/g, "python")
    .replace(/\bnode js\b/g, "node.js")
    .trim();
}

function isMeaningfulKeywordLabel(text) {
  const normalized = normalizeForKeywordMatch(text);
  if (!normalized) return false;
  if (SOFT_SKILL_KEYWORDS.has(normalized)) return false;
  if (GENERIC_SINGLE_WORDS.has(normalized)) return false;
  if (DISALLOWED_AUTO_KEYWORD_TOKENS.has(normalized)) return false;
  if (normalized.split(" ").length > 4) return false;
  if (normalized.length > 40) return false;
  if (/\b(?:hands on|cross functional|problem solving|well documented|high quality|communication skills|constructive feedback|capital markets|cloud technologies)\b/.test(normalized)) {
    return false;
  }
  return true;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAnyVariant(text, variants = []) {
  return variants.some((variant) => textContainsKeyword(text, variant));
}

function textContainsKeyword(text, keyword) {
  const normalized = normalizeForKeywordMatch(keyword);
  if (!normalized) return false;

  const compact = normalized.replace(/\s+/g, " ");
  const exact = new RegExp(`(^|[^a-z0-9+#])${escapeRegExp(compact)}([^a-z0-9+#]|$)`, "i");
  if (exact.test(text)) return true;

  // Allow very small phrasing differences for multi-word skills like "rest api" / "restful api".
  const parts = compact.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    return parts.every((part) => {
      const partRegex = new RegExp(`(^|[^a-z0-9+#])${escapeRegExp(part)}([^a-z0-9+#]|$)`, "i");
      return partRegex.test(text);
    });
  }

  return false;
}

function extractWeightedTokenCandidates(jd, job = {}) {
  const blockedTerms = buildBlockedKeywordTerms(job);
  const tokenCounts = new Map();
  for (const token of jd.match(/\b[a-z][a-z0-9+#.-]{2,}\b/g) || []) {
    if (token.length < 4) continue;
    if (STOPWORDS.has(token)) continue;
    if (blockedTerms.has(token)) continue;
    tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
  }

  const phraseCounts = new Map();
  const tokens = jd.split(" ").filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    if (a.length < 4 || b.length < 4) continue;
    const phrase = `${a} ${b}`;
    if (!shouldKeepAutoKeywordPhrase(phrase, blockedTerms)) continue;
    phraseCounts.set(phrase, (phraseCounts.get(phrase) || 0) + 1);
  }

  const phrases = [...phraseCounts.entries()]
    .filter(([phrase]) => !GENERIC_PHRASES.has(phrase))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 6)
    .map(([phrase]) => ({
      label: phrase,
      variants: [phrase],
      weight: 1.2,
    }));

  const singles = [...tokenCounts.entries()]
    .filter(([token]) => shouldKeepAutoKeywordToken(token, blockedTerms))
    .filter(([token]) => !phrases.some((phrase) => phrase.label.includes(token)))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 8)
    .map(([token]) => ({
      label: token,
      variants: [token],
      weight: 1,
    }));

  return [...phrases, ...singles];
}

function buildBlockedKeywordTerms(job = {}) {
  const blocked = new Set();
  const raw = [
    job.title || "",
    job.company || "",
  ].join(" ");

  for (const token of normalizeForKeywordMatch(raw).split(" ").filter(Boolean)) {
    if (token.length >= 3) blocked.add(token);
  }

  return blocked;
}

function shouldKeepAutoKeywordToken(token, blockedTerms) {
  if (!token) return false;
  if (blockedTerms.has(token)) return false;
  if (GENERIC_SINGLE_WORDS.has(token)) return false;
  if (DISALLOWED_AUTO_KEYWORD_TOKENS.has(token)) return false;
  if (/^(and|or|with|using|over|from|into|across)$/i.test(token)) return false;
  if (!/[a-z]/.test(token)) return false;
  if (!looksLikeSkillToken(token)) return false;
  return true;
}

function shouldKeepAutoKeywordPhrase(phrase, blockedTerms) {
  if (!phrase || GENERIC_PHRASES.has(phrase)) return false;
  if (GENERIC_PHRASE_PARTIALS.some((part) => phrase.includes(part))) return false;

  const parts = phrase.split(" ").filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.length > 3) return false;
  if (parts.every((part) => blockedTerms.has(part))) return false;
  if (parts.some((part) => GENERIC_SINGLE_WORDS.has(part))) return false;
  if (parts.some((part) => DISALLOWED_AUTO_KEYWORD_TOKENS.has(part))) return false;
  if (parts.some((part) => /^(and|or|with|using|over|from|into|across)$/i.test(part))) return false;
  if (parts.filter((part) => looksLikeSkillToken(part)).length < parts.length) return false;
  return true;
}

function looksLikeSkillToken(token) {
  if (!token || token.length < 3) return false;
  if (/^(api|apis|sdk|saas|paas|iaas|sql|nosql|graphql|docker|kubernetes|terraform|snowflake|oracle|azure|aws|gcp|react|angular|python|java|golang|go|redis|kafka|spark|airflow|mysql|postgresql|mongodb|dynamodb|microservices|serverless|event-driven|schema)$/i.test(token)) {
    return true;
  }
  if (/[+#./-]/.test(token)) return true;
  if (token.length >= 5 && /(?:db|sql|cloud|ware|ops|ml|ci|cd|api|core|data)$/.test(token)) return true;
  return false;
}

const STOPWORDS = new Set([
  "about", "ability", "across", "after", "along", "also", "and", "application", "applications",
  "building", "candidate", "collaborate", "collaboration", "company", "computer", "create",
  "customers", "degree", "design", "develop", "development", "engineer", "engineering", "experience",
  "experienced", "field", "from", "good", "great", "have", "help", "high", "including", "knowledge",
  "looking", "maintain", "management", "modern", "must", "need", "our", "passion", "plus", "preferred",
  "problem", "product", "related", "required", "responsibilities", "role", "science", "services",
  "skills", "software", "solutions", "strong", "support", "systems", "team", "teams", "technical",
  "their", "they", "this", "using", "with", "work", "working", "years", "you", "your"
]);

const GENERIC_PHRASES = new Set([
  "backend developer",
  "software engineer",
  "engineering team",
  "cross functional",
  "cross-functional",
  "problem solving",
  "problem-solving",
  "best practices",
  "computer science",
  "product management",
  "object oriented",
  "oriented programming",
  "object oriented programming",
  "recruitment selection",
  "selection and/or",
  "and/or assessment",
  "applicants requirements",
  "expanding internationally",
  "hands on",
  "hands-on",
  "well documented",
  "well-documented",
  "high quality",
  "high-quality",
  "communication skills",
  "constructive feedback",
  "capital markets",
  "cloud technologies",
]);

const GENERIC_PHRASE_PARTIALS = [
  "and/or",
  "recruitment",
  "selection",
  "requirements",
  "understanding",
  "applicants",
];

const GENERIC_SINGLE_WORDS = new Set([
  "understanding",
  "requirements",
  "requirement",
  "applicants",
  "applicant",
  "assessment",
  "selection",
  "recruitment",
  "position",
  "positions",
  "internationally",
  "annually",
  "existing",
  "vacancy",
  "information",
  "preferredly",
  "preferably",
  "overall",
  "important",
  "without",
  "being",
  "what",
  "that",
  "regards",
  "financial",
  "production",
  "pipelines",
  "schema",
  "warehouses",
  "throughout",
  "infrastructure",
  "containerized",
  "integrations",
  "deployments",
]);

const DISALLOWED_AUTO_KEYWORD_TOKENS = new Set([
  "what",
  "without",
  "being",
  "regards",
  "financial",
  "production",
  "pipelines",
  "throughout",
  "that",
  "which",
  "while",
  "where",
  "into",
  "across",
  "event",
  "driven",
  "containerized",
  "deployments",
  "infrastructure",
  "schema",
  "warehouses",
  "hands-on",
]);

const SOFT_SKILL_KEYWORDS = new Set([
  "hands on",
  "hands-on",
  "cross functional",
  "cross-functional",
  "problem solving",
  "problem-solving",
  "well documented",
  "well-documented",
  "high quality",
  "high-quality",
  "communication skills",
  "constructive feedback",
  "capital markets",
  "cloud technologies",
]);

const KEYWORD_CATALOG = [
  { label: "Java", variants: ["java"], weight: 1.4 },
  { label: "Python", variants: ["python"], weight: 1.4 },
  { label: "JavaScript", variants: ["javascript"], weight: 1.2 },
  { label: "TypeScript", variants: ["typescript"], weight: 1.2 },
  { label: "C++", variants: ["c++"], weight: 1.2 },
  { label: "C#", variants: ["c#"], weight: 1.2 },
  { label: "Go", variants: ["go", "golang"], weight: 1.2 },
  { label: "React", variants: ["react"], weight: 1.3 },
  { label: "Angular", variants: ["angular"], weight: 1.2 },
  { label: "Vue", variants: ["vue"], weight: 1.2 },
  { label: "Node.js", variants: ["node.js", "node", "nodejs"], weight: 1.2 },
  { label: "Spring", variants: ["spring", "spring boot"], weight: 1.3 },
  { label: "Django", variants: ["django"], weight: 1.2 },
  { label: "Flask", variants: ["flask"], weight: 1.1 },
  { label: "REST APIs", variants: ["rest api", "restful api", "rest apis"], weight: 1.4 },
  { label: "GraphQL", variants: ["graphql"], weight: 1.2 },
  { label: "Microservices", variants: ["microservices", "microservice"], weight: 1.4 },
  { label: "Kafka", variants: ["kafka"], weight: 1.4 },
  { label: "RabbitMQ", variants: ["rabbitmq"], weight: 1.2 },
  { label: "Redis", variants: ["redis"], weight: 1.2 },
  { label: "SQL", variants: ["sql"], weight: 1.2 },
  { label: "NoSQL", variants: ["nosql"], weight: 1.2 },
  { label: "PostgreSQL", variants: ["postgresql", "postgres"], weight: 1.3 },
  { label: "MySQL", variants: ["mysql"], weight: 1.2 },
  { label: "MongoDB", variants: ["mongodb", "mongo"], weight: 1.2 },
  { label: "DynamoDB", variants: ["dynamodb"], weight: 1.2 },
  { label: "Oracle", variants: ["oracle"], weight: 1.1 },
  { label: "J2EE", variants: ["j2ee", "java ee"], weight: 1.1 },
  { label: "Jersey", variants: ["jersey"], weight: 1.1 },
  { label: "ClickHouse", variants: ["clickhouse"], weight: 1.2 },
  { label: "Snowflake", variants: ["snowflake"], weight: 1.1 },
  { label: "AWS", variants: ["aws", "amazon web services"], weight: 1.3 },
  { label: "Azure", variants: ["azure"], weight: 1.2 },
  { label: "GCP", variants: ["gcp", "google cloud"], weight: 1.2 },
  { label: "Docker", variants: ["docker"], weight: 1.3 },
  { label: "Kubernetes", variants: ["kubernetes", "k8s"], weight: 1.3 },
  { label: "Terraform", variants: ["terraform"], weight: 1.2 },
  { label: "Jenkins", variants: ["jenkins"], weight: 1.1 },
  { label: "GitHub Actions", variants: ["github actions"], weight: 1.1 },
  { label: "CI/CD", variants: ["ci/cd", "continuous integration", "continuous delivery"], weight: 1.1 },
  { label: "Linux", variants: ["linux"], weight: 1.1 },
  { label: "Git", variants: ["git"], weight: 1.0 },
  { label: "HTML", variants: ["html"], weight: 1.0 },
  { label: "CSS", variants: ["css"], weight: 1.0 },
  { label: "Spark", variants: ["spark", "apache spark"], weight: 1.1 },
  { label: "Hadoop", variants: ["hadoop"], weight: 1.0 },
  { label: "Airflow", variants: ["airflow", "apache airflow"], weight: 1.1 },
  { label: "Pandas", variants: ["pandas"], weight: 1.0 },
  { label: "Backend", variants: ["backend", "back end", "back-end"], weight: 1.0 },
  { label: "Database", variants: ["database", "databases"], weight: 1.0 },
  { label: "E-commerce", variants: ["e-commerce", "ecommerce"], weight: 0.8 },
  { label: "Product Management", variants: ["product management"], weight: 0.8 },
];

// ---------- LLM callers ----------

async function callOpenAI(system, user, apiKey, options = {}) {
  const {
    model = "gpt-5.1",
    reasoningEffort = "medium",
  } = options;
  const body = {
    model,
    temperature: 0.4,
    max_tokens: 2000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  if (typeof model === "string" && model.startsWith("gpt-5")) {
    body.reasoning_effort = reasoningEffort || "medium";
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI error ${res.status}: ${err?.error?.message ?? res.statusText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropic(system, user, apiKey) {
  if (!apiKey) {
    throw new Error("Anthropic API key is missing.");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Anthropic error ${res.status}: ${err?.error?.message ?? res.statusText}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || "";
}

// ---------- Prompt builders ----------

function buildSystemPrompt() {
  return `You are a career coaching assistant. Analyze job descriptions against a candidate's resume and provide structured, actionable guidance. Always respond in the exact XML format requested. Be specific and honest. If the match is weak, say so clearly. Respond in the same language as the job description when possible.`;
}

function buildUserPrompt({ job, jdText, resumeContext, pastContext }) {
  return `
## Target Role
Position: ${job.title ?? "Unknown"}
Company: ${job.company ?? "Unknown"}
Location: ${job.location ?? "Unknown"}

## Job Description
${jdText.slice(0, 3500)}

## Candidate Resume (semantic retrieval results)
${resumeContext}

${pastContext ? `## Similar Past Applications\n${pastContext}\n` : ""}

## Instructions
Respond ONLY with the XML below.

<analysis>
  <match_score>0-100 integer</match_score>
  <match_summary>2-3 honest sentences about fit</match_summary>
  <strengths>
    <item>Specific strength aligned with this JD</item>
    <item>Another strength</item>
    <item>Another strength</item>
  </strengths>
  <gaps>
    <item>Missing skill or experience, with a brief suggestion to address it</item>
    <item>Another gap</item>
  </gaps>
  <cover_letter>
3-4 paragraph professional cover letter. Use concrete evidence from the resume excerpts. Avoid generic filler.
  </cover_letter>
  <interview_questions>
    <question><q>Likely question based on JD and background</q><hint>Brief answer strategy</hint></question>
    <question><q>Technical or role-specific question</q><hint>Hint</hint></question>
    <question><q>Behavioral question targeting a gap or strength</q><hint>Hint</hint></question>
    <question><q>Motivation or company-fit question</q><hint>Hint</hint></question>
  </interview_questions>
</analysis>`;
}

// ---------- XML parser ----------

function parseAnalysis(text) {
  const extract = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return m ? m[1].trim() : "";
  };

  const extractSectionItems = (sectionTag) => {
    const section = extract(sectionTag);
    return [...section.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1].trim());
  };

  const extractQuestions = () => {
    return [...text.matchAll(/<question>([\s\S]*?)<\/question>/gi)].map((m) => {
      const block = m[1];
      const q = block.match(/<q>([\s\S]*?)<\/q>/i)?.[1]?.trim() || "";
      const hint = block.match(/<hint>([\s\S]*?)<\/hint>/i)?.[1]?.trim() || "";
      return { q, hint };
    });
  };

  return {
    matchScore: parseInt(extract("match_score"), 10) || 0,
    matchSummary: extract("match_summary"),
    strengths: extractSectionItems("strengths"),
    gaps: extractSectionItems("gaps"),
    coverLetter: extract("cover_letter"),
    interviewQs: extractQuestions(),
  };
}
