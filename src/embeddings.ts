import { pipeline } from "@huggingface/transformers";

const EMBEDDING_MODEL = "Xenova/nomic-embed-text-v1";
const EMBEDDING_DIMENSIONS = 768;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let initPromise: Promise<any> | null = null;

async function getExtractor() {
  if (extractor) return extractor;

  if (!initPromise) {
    console.error(`[clancey] Loading embedding model ${EMBEDDING_MODEL}...`);
    initPromise = pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "q8", // 8-bit quantization for smaller size
    });
  }

  extractor = await initPromise;
  console.error(`[clancey] Embedding model loaded`);
  return extractor;
}

/**
 * Generate embeddings for a batch of texts
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const ext = await getExtractor();
  const allEmbeddings: number[][] = [];

  // Process in batches to avoid memory issues
  const batchSize = 32;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    // nomic requires "search_document: " prefix for documents being indexed
    const prefixedBatch = batch.map((t) => `search_document: ${t}`);

    const output = await ext(prefixedBatch, {
      pooling: "mean",
      normalize: true,
    });

    // Output is a Tensor, convert to nested array
    const data = output.tolist() as number[][];
    allEmbeddings.push(...data);

    if (texts.length > batchSize) {
      console.error(`[clancey] Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length} chunks`);
    }
  }

  return allEmbeddings;
}

/**
 * Generate embedding for a single query text
 */
export async function embedOne(text: string): Promise<number[]> {
  const ext = await getExtractor();

  // nomic requires "search_query: " prefix for search queries
  const prefixedText = `search_query: ${text}`;

  const output = await ext(prefixedText, {
    pooling: "mean",
    normalize: true,
  });

  // Single input returns [[...embedding...]], we want the inner array
  const data = output.tolist() as number[][];
  return data[0];
}

export { EMBEDDING_DIMENSIONS };
