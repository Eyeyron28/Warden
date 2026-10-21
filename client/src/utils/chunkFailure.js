const CHUNK_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .* failed|Unable to preload CSS|MIME type/i;

export const isChunkFailure = (error) => CHUNK_FAILURE.test(String(error?.message || error || ''));
