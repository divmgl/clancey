import { pipeline } from "@huggingface/transformers";
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
    initPromise = pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "q8", // 8-bit quantization for smaller size
    });
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

export { EMBEDDING_DIMENSIONS };
