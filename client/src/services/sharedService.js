import axios from 'axios';

const publicApi = axios.create({ baseURL: '/api' });

const base = (shareId) => `/shared/${encodeURIComponent(shareId)}`;
const withAccess = (accessToken, extra = {}) => ({
  ...extra,
  headers: accessToken ? { 'X-Share-Access': accessToken } : undefined,
});

export async function openAccess(shareId) {
  const { data } = await publicApi.post(`${base(shareId)}/access`);
  return data;
}

export async function requestEmailCode(shareId, accessToken) {
  const { data } = await publicApi.post(`${base(shareId)}/email-code`, {}, withAccess(accessToken));
  return data;
}

export async function verifyEmailCode(shareId, accessToken, code) {
  const { data } = await publicApi.post(`${base(shareId)}/email-verify`, { code }, withAccess(accessToken));
  return data;
}

export async function unlockShare(shareId, accessToken, verifier) {
  const { data } = await publicApi.post(`${base(shareId)}/unlock`, { verifier }, withAccess(accessToken));
  return data;
}

export async function fetchSharedManifest(shareId, accessToken) {
  const { data } = await publicApi.get(base(shareId), withAccess(accessToken));
  return data;
}

export async function fetchSharedFile(shareId, fileId, accessToken) {
  const { data } = await publicApi.get(
    `${base(shareId)}/files/${encodeURIComponent(fileId)}`,
    withAccess(accessToken, { responseType: 'arraybuffer' })
  );
  return data;
}
