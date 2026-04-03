import { handleJwtFromResponse, getConversationToken, getConversationIdFromUrl } from './auth';
import { getAtprotoIdentity } from './atproto-session';

// Simplified service base resolution (both env vars are required)
const SERVICE_BASE: string = (
  typeof window !== 'undefined'
    ? import.meta.env.PUBLIC_SERVICE_URL
    : import.meta.env.INTERNAL_SERVICE_URL
  )?.replace(/\/$/, '') || '';

// Default request timeout (ms)
const REQUEST_TIMEOUT_MS: number = Number(import.meta.env.PUBLIC_REQUEST_TIMEOUT_MS) || 10000;

interface PolisApiError extends Error {
  responseText?: string;
  status?: number;
}

async function polisFetch<T = any>(
  api: string,
  data?: Record<string, any>,
  type?: string
): Promise<T> {
  if (typeof api !== 'string') {
    throw new Error('api param should be a string');
  }

  // Build URL: allow absolute URLs; otherwise construct from origin/basePath and api path
  let url: string;
  const isAbsolute = /^(https?:)?\/\//i.test(api);
  if (isAbsolute) {
    url = api;
  } else {
    const apiPath = api.startsWith('/') ? api : `/${api}`;
    url = `${SERVICE_BASE}${apiPath}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'max-age=0'
  };

  // Inject atproto identity as xid params if authenticated
  if (typeof window !== 'undefined' && data) {
    const identity = getAtprotoIdentity();
    if (identity && !data.xid) {
      data.xid = identity.did;
      data.x_name = identity.displayName;
      data.x_profile_image_url = identity.avatarUrl;
    }
  }

  let body: string | null = null;
  let method = type ? type.toUpperCase() : 'GET';

  if (method === 'GET' && data && Object.keys(data).length > 0) {
    const queryParams = new URLSearchParams(data);
    url += `?${queryParams.toString()}`
  } else if ((method === 'POST' || method === 'PUT') && data && Object.keys(data).length > 0) {
    body = JSON.stringify(data);
  }

  // Attach conversation-specific JWT if available
  try {
    let conversationId: string | null = null;
    if (data && (data as any).conversation_id) {
      conversationId = (data as any).conversation_id;
    } else if (typeof window !== 'undefined') {
      conversationId = getConversationIdFromUrl();
    }

    if (conversationId) {
      const conversationToken = getConversationToken(conversationId);
      if (conversationToken && conversationToken.token) {
        headers.Authorization = `Bearer ${conversationToken.token}`;
      }
    }
  } catch {
    // Continue without auth token — server decides if auth is required
  }

  // Add timeout to avoid indefinite hangs (especially during SSR)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err && err.name === 'AbortError') {
      const error: PolisApiError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${url}`);
      (error as any).status = 408;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok && response.status !== 304) {
    const errorBody = await response.text();

    const error: PolisApiError = new Error(
      `Polis API Error: ${method} ${url} failed with status ${response.status} (${response.statusText})`
    );
    error.responseText = errorBody;
    error.status = response.status;
    throw error;
  }

  const jsonResponse = await response.json();

  // Automatically handle JWT tokens in response
  handleJwtFromResponse(jsonResponse);

  return jsonResponse;
}

async function polisPost<T = any>(api: string, data?: Record<string, any>): Promise<T> {
  return await polisFetch<T>(api, data, 'POST');
}

async function polisPut<T = any>(api: string, data?: Record<string, any>): Promise<T> {
  return await polisFetch<T>(api, data, 'PUT');
}

async function polisGet<T = any>(api: string, data?: Record<string, any>): Promise<T> {
  try {
    return await polisFetch<T>(api, data, 'GET');
  } catch (error: any) {
    // If we have a 403, retry once after a short delay (initial race condition)
    if (error.status === 403) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return await polisFetch<T>(api, data, 'GET');
    }
    throw error;
  }
}

const PolisNet = {
  polisFetch,
  polisPost,
  polisPut,
  polisGet,
};
export default PolisNet;
