import { log, logError } from "./logger.js";

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMENSIONS = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let initPromise: Promise<any> | null = null;

async function getExtractor() {
  if (extractor) return extractor;

  if (!initPromise) {
    log(`Loading embedding model ${EMBEDDING_MODEL}...`);
    // Imported lazily: @huggingface/transformers pulls in heavy native deps (onnxruntime,
    // sharp) at load. Only the embedding paths need them — the hook, recall, grep_turns and
    // read_turns must not drag the model (or a broken sharp binary) into their import chain.
    initPromise = import("@huggingface/transformers").then(({ pipeline }) =>
      pipeline("feature-extraction", EMBEDDING_MODEL, {
        dtype: "q8", // 8-bit quantization for smaller size
      }),
    );
  }

  extractor = await initPromise;
  log(`Embedding model loaded`);
  return extractor;
}

/**
 * Generate embeddings for a batch of texts
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const ext = await getExtractor();
  const allEmbeddings: number[][] = [];

  // Process in batches
  const batchSize = 32;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} texts)...`);

    try {
      const output = await ext(batch, {
        pooling: "mean",
        normalize: true,
      });

      // Output is a Tensor, convert to nested array
      const data = output.tolist() as number[][];
      allEmbeddings.push(...data);

      if (texts.length > batchSize) {
        log(`Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length} chunks`);
      }
    } catch (error) {
      logError(`Failed to embed batch starting at index ${i}`, error);
      throw error;
    }
  }

  return allEmbeddings;
}

/**
 * Generate embedding for a single query text
 */
export async function embedOne(text: string): Promise<number[]> {
  const ext = await getExtractor();

  const output = await ext(text, {
    pooling: "mean",
    normalize: true,
  });

  // Single input returns [[...embedding...]], we want the inner array
  const data = output.tolist() as number[][];
  return data[0];
}

/** Serialize an embedding to a Float32 BLOB for SQLite storage. */
export function vectorToBlob(vector: number[]): Buffer {
  return Buffer.from(Float32Array.from(vector).buffer);
}

/** Deserialize a Float32 BLOB back into a vector. */
export function blobToVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/**
 * Cosine similarity. Model output is L2-normalized, so this is effectively a dot
 * product, but we normalize defensively in case an upstream vector is not unit length.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export { EMBEDDING_DIMENSIONS };
