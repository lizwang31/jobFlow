// src/rag/embedder.js
// Handles: PDF/TXT text extraction, chunking, OpenAI embeddings
// Runs in the extension without a backend

let pdfjsLibPromise = null;

export async function extractTextFromFile(file) {
  const name = (file.name || "").toLowerCase();
  const type = file.type || "";

  if (type === "text/plain" || name.endsWith(".txt") || name.endsWith(".md")) {
    const text = await readAsText(file);
    return normalizeText(text);
  }

  if (type === "application/pdf" || name.endsWith(".pdf")) {
    const text = await extractPdfText(file);
    return normalizeText(text);
  }

  throw new Error("Unsupported file type. Please upload a PDF, TXT, or MD file.");
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsText(file);
  });
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  let fullText = "";

  try {
    const pdfjsLib = await getPdfJs();
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      useWorkerFetch: false,
      isEvalSupported: false,
    }).promise;

    const pages = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      // Keep some spatial ordering stability
      const items = (content.items || [])
        .map((item) => ("str" in item ? item.str : ""))
        .filter(Boolean);

      const pageText = items.join(" ").trim();
      if (pageText) pages.push(pageText);
    }

    fullText = normalizeText(pages.join("\n\n"));
  } catch (err) {
    console.warn("[Embedder] pdf.js unavailable, falling back to raw PDF text extraction:", err);
    fullText = normalizeText(extractPdfTextFallback(arrayBuffer));
  }

  if (fullText.length < 200) {
    throw new Error(
      "Could not extract enough text from this PDF. It may be scanned or image-based. Please upload a text-based PDF or TXT file."
    );
  }

  return fullText;
}

async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("../vendor/pdf/pdf.mjs").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
        "src/vendor/pdf/pdf.worker.mjs"
      );
      return mod;
    });
  }

  return pdfjsLibPromise;
}

function extractPdfTextFallback(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);

  // Decode raw PDF bytes as Latin-1
  let raw = "";
  for (let i = 0; i < bytes.length; i++) {
    raw += String.fromCharCode(bytes[i]);
  }

  const textParts = [];
  const tjRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")/g;
  let match;

  while ((match = tjRegex.exec(raw)) !== null) {
    const decoded = decodePdfString(match[1]);
    if (decoded.trim()) textParts.push(decoded);
  }

  const tjArrayRegex = /\[([^\]]+)\]\s*TJ/g;
  while ((match = tjArrayRegex.exec(raw)) !== null) {
    const strRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let strMatch;

    while ((strMatch = strRegex.exec(match[1])) !== null) {
      const decoded = decodePdfString(strMatch[1]);
      if (decoded.trim()) textParts.push(decoded);
    }
  }

  let text = textParts.join(" ").replace(/\s+/g, " ").trim();

  if (text.length < 100) {
    const ascii = (raw.match(/[ -~]{4,}/g) || [])
      .filter((s) => /[a-zA-Z]{2,}/.test(s) && !s.startsWith("%"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (ascii.length > text.length) text = ascii;
  }

  return text;
}

function decodePdfString(value) {
  return value
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Resume-friendly chunking:
 * 1. split by paragraph-ish boundaries
 * 2. merge into medium-sized chunks
 * 3. add overlap
 */
export function chunkText(
  text,
  {
    maxChars = 900,
    overlapChars = 120,
    minChunkChars = 120,
  } = {}
) {
  const clean = normalizeText(text);
  if (!clean) return [];

  let blocks = clean
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Fallback if PDF text comes back as one huge paragraph
  if (blocks.length <= 1) {
    blocks = clean
      .split(/(?<=[.:•])\s+(?=[A-Z0-9•])/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  const chunks = [];
  let current = "";

  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }

    const candidate = `${current}\n\n${block}`;

    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current.length >= minChunkChars) {
        chunks.push(current);
      } else {
        // force keep tiny chunks from being lost
        chunks.push(candidate.slice(0, maxChars).trim());
        current = candidate.slice(Math.max(0, maxChars - overlapChars)).trim();
        continue;
      }
      current = block;
    }
  }

  if (current && current.length >= minChunkChars) {
    chunks.push(current);
  }

  // secondary split for oversized chunks
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      finalChunks.push(chunk);
      continue;
    }

    let start = 0;
    while (start < chunk.length) {
      const piece = chunk.slice(start, start + maxChars).trim();
      if (piece.length >= minChunkChars) {
        finalChunks.push(piece);
      }
      start += Math.max(1, maxChars - overlapChars);
    }
  }

  return finalChunks;
}

export async function embedTexts(texts, openaiKey) {
  const cleaned = (texts || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);

  if (!cleaned.length) return [];

  const results = [];

  for (let i = 0; i < cleaned.length; i += 20) {
    const batch = cleaned.slice(i, i + 20).map((t) => t.slice(0, 8000));

    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: batch,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        `OpenAI Embeddings error ${res.status}: ${
          err?.error?.message ?? res.statusText
        }`
      );
    }

    const data = await res.json();
    results.push(...data.data.map((d) => d.embedding));
  }

  return results;
}

export async function embedText(text, openaiKey) {
  const [vec] = await embedTexts([String(text || "").slice(0, 8000)], openaiKey);
  return vec;
}
