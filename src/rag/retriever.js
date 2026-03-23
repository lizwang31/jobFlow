// src/rag/retriever.js
// Local-first retriever with optional Pinecone support

const RESUME_STORAGE_KEY = "resumeIndex";
const JOBS_STORAGE_KEY = "jobsIndex";

// ---------- storage helpers ----------

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local?.get) {
      reject(new Error("Extension storage.local is unavailable."));
      return;
    }
    chrome.storage.local.get(keys, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local?.set) {
      reject(new Error("Extension storage.local is unavailable."));
      return;
    }
    chrome.storage.local.set(obj, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

// ---------- vector math ----------

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (!normA || !normB) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------- local index management ----------

export async function saveResumeIndex({
  fileName,
  rawText,
  chunks,
  embeddings,
}) {
  if (!chunks?.length || !embeddings?.length || chunks.length !== embeddings.length) {
    throw new Error("Invalid resume index data.");
  }

  const items = chunks.map((text, i) => ({
    id: `resume-${i}`,
    text,
    embedding: embeddings[i],
    metadata: {
      source: "resume",
      chunkIndex: i,
      fileName: fileName || "resume",
    },
  }));

  const payload = {
    fileName: fileName || "resume",
    rawText: rawText || "",
    uploadedAt: new Date().toISOString(),
    items,
  };

  await storageSet({ [RESUME_STORAGE_KEY]: payload });
  return payload;
}

export async function getResumeIndex() {
  const data = await storageGet([RESUME_STORAGE_KEY]);
  return data[RESUME_STORAGE_KEY] || null;
}

export async function hasResumeIndex() {
  const resume = await getResumeIndex();
  return !!(resume?.items?.length);
}

export async function saveJobVector(jobRecord) {
  const data = await storageGet([JOBS_STORAGE_KEY]);
  const list = Array.isArray(data[JOBS_STORAGE_KEY]) ? data[JOBS_STORAGE_KEY] : [];

  const normalized = {
    id: jobRecord.id || `job-${Date.now()}`,
    title: jobRecord.title || "",
    company: jobRecord.company || "",
    status: jobRecord.status || "",
    notionPageId: jobRecord.notionPageId || "",
    jdText: jobRecord.jdText || "",
    embedding: jobRecord.embedding || [],
    createdAt: jobRecord.createdAt || new Date().toISOString(),
  };

  const deduped = list.filter((item) => item.id !== normalized.id);
  deduped.unshift(normalized);

  // Keep only recent 100 to avoid bloating storage
  await storageSet({ [JOBS_STORAGE_KEY]: deduped.slice(0, 100) });
}

export async function getJobIndex() {
  const data = await storageGet([JOBS_STORAGE_KEY]);
  return Array.isArray(data[JOBS_STORAGE_KEY]) ? data[JOBS_STORAGE_KEY] : [];
}

// ---------- local retrieval ----------

export async function queryLocalResume(vector, topK = 6) {
  const resume = await getResumeIndex();
  const items = resume?.items || [];

  const matches = items
    .map((item) => ({
      id: item.id,
      score: cosineSimilarity(vector, item.embedding),
      metadata: {
        ...item.metadata,
        text: item.text,
      },
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { matches };
}

export async function queryLocalJobs(
  vector,
  topK = 3,
  { excludeNotionPageId = "", excludeJobId = "" } = {}
) {
  const items = await getJobIndex();

  const matches = items
    .filter((item) => Array.isArray(item.embedding) && item.embedding.length)
    .filter((item) => !excludeNotionPageId || item.notionPageId !== excludeNotionPageId)
    .filter((item) => !excludeJobId || item.id !== excludeJobId)
    .map((item) => ({
      id: item.id,
      score: cosineSimilarity(vector, item.embedding),
      metadata: {
        title: item.title,
        company: item.company,
        status: item.status,
        notionPageId: item.notionPageId,
        jdText: item.jdText,
      },
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { matches };
}

// ---------- optional Pinecone ----------

export function shouldUsePinecone(settings = {}) {
  return !!(settings?.pineconeKey && settings?.pineconeHost);
}

export async function upsertVectors(vectors, namespace, pineconeKey, pineconeHost) {
  const res = await fetch(`${pineconeHost}/vectors/upsert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": pineconeKey,
    },
    body: JSON.stringify({ vectors, namespace }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pinecone upsert failed ${res.status}: ${err}`);
  }

  return res.json();
}

export async function deleteNamespace(namespace, pineconeKey, pineconeHost) {
  const res = await fetch(`${pineconeHost}/vectors/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": pineconeKey,
    },
    body: JSON.stringify({
      deleteAll: true,
      namespace,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pinecone delete failed ${res.status}: ${err}`);
  }

  return res.json().catch(() => ({}));
}

export async function queryVectors(vector, topK, namespace, pineconeKey, pineconeHost) {
  const res = await fetch(`${pineconeHost}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": pineconeKey,
    },
    body: JSON.stringify({
      vector,
      topK,
      namespace,
      includeMetadata: true,
    }),
  });

  if (!res.ok) return { matches: [] };
  return res.json();
}

export async function checkNamespaceHasVectors(namespace, pineconeKey, pineconeHost) {
  try {
    const dummy = new Array(1536).fill(0);
    const result = await queryVectors(dummy, 1, namespace, pineconeKey, pineconeHost);
    return (result.matches?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function syncResumeIndexToPinecone(
  { fileName, chunks, embeddings },
  settings = {}
) {
  if (!shouldUsePinecone(settings)) {
    return { success: false, skipped: true };
  }

  if (!chunks?.length || !embeddings?.length || chunks.length !== embeddings.length) {
    throw new Error("Invalid resume vectors for Pinecone sync.");
  }

  await deleteNamespace("resume", settings.pineconeKey, settings.pineconeHost);

  const vectors = chunks.map((text, i) => ({
    id: `resume-${i}`,
    values: embeddings[i],
    metadata: {
      text,
      source: "resume",
      chunkIndex: i,
      fileName: fileName || "resume",
    },
  }));

  await upsertVectors(vectors, "resume", settings.pineconeKey, settings.pineconeHost);
  return { success: true, count: vectors.length };
}

export async function syncJobToPinecone(jobRecord, settings = {}) {
  if (!shouldUsePinecone(settings)) {
    return { success: false, skipped: true };
  }

  if (!jobRecord?.id || !Array.isArray(jobRecord.embedding) || !jobRecord.embedding.length) {
    throw new Error("Invalid job vector for Pinecone sync.");
  }

  await upsertVectors(
    [{
      id: `job-${jobRecord.id}`,
      values: jobRecord.embedding,
      metadata: {
        title: jobRecord.title || "",
        company: jobRecord.company || "",
        status: jobRecord.status || "",
        notionPageId: jobRecord.notionPageId || "",
        jdText: jobRecord.jdText || "",
        source: "job",
      },
    }],
    "jobs",
    settings.pineconeKey,
    settings.pineconeHost
  );

  return { success: true };
}

// ---------- unified retrieval API ----------

export async function retrieveResumeChunks(queryEmbedding, topK = 6, settings = {}) {
  if (shouldUsePinecone(settings)) {
    const remote = await queryVectors(
      queryEmbedding,
      topK,
      "resume",
      settings.pineconeKey,
      settings.pineconeHost
    );

    if ((remote.matches?.length ?? 0) > 0) {
      return remote;
    }
  }

  return queryLocalResume(queryEmbedding, topK);
}

export async function retrievePastJobs(
  queryEmbedding,
  topK = 3,
  settings = {},
  { excludeNotionPageId = "", excludeJobId = "" } = {}
) {
  if (shouldUsePinecone(settings)) {
    const result = await queryVectors(
      queryEmbedding,
      topK,
      "jobs",
      settings.pineconeKey,
      settings.pineconeHost
    );

    const matches = (result.matches || []).filter(
      (m) =>
        (!excludeNotionPageId || m.metadata?.notionPageId !== excludeNotionPageId) &&
        (!excludeJobId || m.id !== `job-${excludeJobId}`)
    );

    if (matches.length > 0) {
      return { matches };
    }
  }

  return queryLocalJobs(queryEmbedding, topK, {
    excludeNotionPageId,
    excludeJobId,
  });
}
