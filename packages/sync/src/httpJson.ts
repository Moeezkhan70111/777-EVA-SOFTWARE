// One JSON request, over http or https, with no dependency.
//
// Supabase is reached over https. The loopback service the tests use is http. Both go through
// here so the transport above it has one code path, and the protocol is chosen from the URL
// rather than configured.
//
// NOTHING SENSITIVE IS EVER PUT IN AN ERROR OR A LOG. Request headers carry the project's
// publishable key and the device's access token, and neither is ever echoed back: the failure
// text is built from the status and the service's own message, and `redactSecrets` scrubs
// anything that still looks like a token before it leaves this file.

import http from "node:http";
import https from "node:https";

export interface JsonRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface JsonResponse {
  readonly status: number;
  readonly text: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The service's own error code when it sent one, e.g. a PostgreSQL SQLSTATE. */
    readonly code?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Removes anything that looks like a credential from text that may be shown or logged.
 *
 * Belt and braces: the caller should not be putting a token in a message in the first place, but
 * a service's own error text is outside our control and has been known to echo a header back.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/(apikey|authorization|password|access_token|refresh_token)"?\s*[:=]\s*"?[^",\s}]+/gi, "$1=[redacted]");
}

export async function requestJson(request: JsonRequest): Promise<JsonResponse> {
  const target = new URL(request.url);
  const agent = target.protocol === "https:" ? https : http;

  return new Promise<JsonResponse>((resolve, reject) => {
    const headers: Record<string, string> = { accept: "application/json", ...request.headers };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(request.body));
    }

    const call = agent.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === "" ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers,
        timeout: request.timeoutMs ?? 20_000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      }
    );

    call.on("timeout", () => {
      call.destroy(new HttpError(0, "the service did not answer in time"));
    });
    call.on("error", (error: Error) => {
      reject(error instanceof HttpError ? error : new HttpError(0, redactSecrets(error.message)));
    });
    call.end(request.body);
  });
}

/** The service's own error code and message, when the body is a JSON error. Never the headers. */
export function readServiceError(status: number, text: string): HttpError {
  let code: string | undefined;
  let message = "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.code === "string") code = record.code;
      // PostgREST uses `message`, GoTrue uses `error_description` or `msg`.
      for (const key of ["message", "error_description", "msg", "error"]) {
        const value = record[key];
        if (typeof value === "string" && value !== "") {
          message = value;
          break;
        }
      }
    }
  } catch {
    message = text.slice(0, 200);
  }
  return new HttpError(status, redactSecrets(message || `the service answered ${String(status)}`), code);
}
