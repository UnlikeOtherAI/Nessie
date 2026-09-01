// The one place the embedding vector width is stated.
//
// Every pgvector column that stores an embedding — `thoughts.embedding`,
// `thought_recalls.query_embedding`, `knowledge_page_chunks.embedding` — is
// declared `vector(EMBEDDING_DIMENSIONS)`, every producer asks its provider for
// exactly this width, and every writer refuses a vector of any other length.
// The database cannot widen or narrow a column silently, so this constant and
// the schema move together: changing it is a one-line edit here plus a Prisma
// migration that re-types the three columns AND re-embeds existing rows, since
// vectors of different widths are not convertible.
//
// 1024 is the native width of `jina-embeddings-v3`, the deployment's embedding
// model. Jina v3's Matryoshka `dimensions` parameter only truncates downward
// from 1024, so a wider column could never be filled by it.
export const EMBEDDING_DIMENSIONS = 1024
