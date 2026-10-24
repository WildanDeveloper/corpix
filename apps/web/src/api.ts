export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("UNAUTHORIZED");
    }
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

const TOKEN_KEY = "corpix.adminToken";

export function getToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token.length === 0) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage can be disabled; the token simply won't persist
  }
}

export function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = getToken();
  const suffix = token ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : "";
  return `${protocol}//${window.location.host}${path}${suffix}`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
