const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "yclid",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term"
]);

function isMeduzaHost(hostname: string): boolean {
  return hostname === "meduza.io" || hostname === "www.meduza.io";
}

export function normalizeMeduzaUrl(rawUrl: string, baseUrl?: string): string {
  const url = new URL(rawUrl, baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Unsupported Meduza URL protocol: ${url.protocol}`);
  }
  if (!isMeduzaHost(url.hostname.toLowerCase())) {
    throw new TypeError(`Expected a meduza.io URL, received ${url.hostname}.`);
  }

  url.protocol = "https:";
  url.hostname = "meduza.io";
  url.port = "";
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function tryNormalizeMeduzaUrl(rawUrl: string, baseUrl?: string): string | undefined {
  try {
    return normalizeMeduzaUrl(rawUrl, baseUrl);
  } catch {
    return undefined;
  }
}
