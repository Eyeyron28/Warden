// What a failed lazy import looks like in the browsers we support. After a new deployment an old tab asks for a page's
// code under its OLD file name; the server answers with the app's index page instead, and the import fails.
const CHUNK_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .* failed|Unable to preload CSS|MIME type/i;

export const isChunkFailure = (error) => CHUNK_FAILURE.test(String(error?.message || error || ''));
