import api from './api.js';

/**
 * GET /api/documents
 * @returns {Promise<Array<{ id: string, filename: string, folder: string, expiryDate: string|null, syncStatus: string, createdAt: string }>>}
 */
export async function listDocuments() {
  const { data } = await api.get('/documents');
  return data;
}

/**
 * POST /api/documents (multipart/form-data)
 * @param {{ file: File, folder?: string, expiryDate?: string }} params
 * @param {(percent: number) => void} [onProgress]
 */
export async function uploadDocument({ file, folder, expiryDate }, onProgress) {
  const formData = new FormData();
  formData.append('file', file);
  if (folder) formData.append('folder', folder);
  if (expiryDate) formData.append('expiryDate', expiryDate);

  const { data } = await api.post('/documents', formData, {
    onUploadProgress: (event) => {
      if (onProgress && event.total) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    },
  });
  return data;
}

/**
 * GET /api/documents/:id/view - decrypts server-side and streams the file
 * back. Returns the raw blob plus the filename/content-type the server
 * reported, so the caller can open or save it.
 */
export async function fetchDocumentBlob(id) {
  const response = await api.get(`/documents/${id}/view`, { responseType: 'blob' });

  const disposition = response.headers['content-disposition'] || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? decodeURIComponent(match[1]) : 'document';

  return {
    blob: response.data,
    filename,
    contentType: response.headers['content-type'],
  };
}

/**
 * Opens a decrypted blob in a new tab (browsers render viewable types like
 * PDFs/images inline; other types fall back to a download prompt). The
 * object URL is revoked after a delay rather than immediately, so the new
 * tab has time to actually load it.
 */
export function openBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank');

  // Popup blocked or similar: fall back to a direct download instead of
  // silently doing nothing.
  if (!opened) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * DELETE /api/documents/:id
 */
export async function deleteDocument(id) {
  await api.delete(`/documents/${id}`);
}
