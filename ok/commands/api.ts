// ok/commands/api.ts — `ok api <path> [--method M] [--data JSON]`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, parseArgs, type ParsedArgs } from "./serve.ts";

export function apiBaseUrl(args: ParsedArgs): string {
  const cfg = loadConfig();
  const host = String(args.flags.host ?? cfg.host);
  const port = Number.parseInt(String(args.flags.port ?? cfg.port), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a valid TCP port");
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error("ok api only permits a loopback --host");
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function parseJsonInput(args: ParsedArgs): unknown | undefined {
  const raw = args.flags.data;
  const file = args.flags["data-file"];
  if (raw !== undefined && file !== undefined) throw new Error("Use either --data or --data-file, not both");
  const value = file !== undefined ? readFileSync(resolve(String(file)), "utf-8") : raw;
  if (value === undefined || value === true) return undefined;
  try { return JSON.parse(String(value)); }
  catch { throw new Error("--data must be valid JSON"); }
}

function printApiResult(status: number, statusText: string, body: string, jsonOnly: boolean): void {
  let rendered = body;
  try { rendered = JSON.stringify(JSON.parse(body), null, 2); } catch { /* keep text response */ }
  if (!jsonOnly) console.error(`ok api: ${status} ${statusText}`);
  console.log(`${rendered}${rendered.endsWith("\n") ? "" : "\n"}`);
}

export async function cmdApi(argv: string[]): Promise<void> {
  const args = parseArgs(["api", ...argv]);
  const path = args.positionals[0];
  if (!path) throw new Error("Usage: ok api <path> [--method GET] [--data JSON|--data-file file] [--json]");
  if (!path.startsWith("/api/")) throw new Error("API path must begin with /api/");
  if (path.includes("..") || /\s/.test(path)) throw new Error("API path must be a clean relative API path");
  const method = String(args.flags.method ?? (args.flags.data !== undefined || args.flags["data-file"] !== undefined ? "POST" : "GET")).toUpperCase();
  if (!/^(GET|POST|PATCH|PUT|DELETE)$/.test(method)) throw new Error("--method must be GET, POST, PATCH, PUT, or DELETE");
  const payload = parseJsonInput(args);
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, headers };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(`${apiBaseUrl(args)}${path}`, init);
  const body = await response.text();
  printApiResult(response.status, response.statusText, body, args.flags.json === true || args.flags.json === "true");
  if (!response.ok) process.exitCode = 1;
}

/**
 * Options for `apiRequest` — the non-printing primitive used by
 * programmatic callers (e.g. `ok task add`, `ok task claim`) that need
 * the response body parsed without polluting stdout.
 */
export interface ApiRequestOptions {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  payload?: unknown;
  /** Per-call overrides; falls back to the active config. */
  host?: string;
  port?: number;
  /** Abort timeout in ms; default 4000. Set to 0 to disable. */
  timeoutMs?: number;
}

export interface ApiRequestResult {
  ok: boolean;
  status: number;
  body: unknown;
  /** True when the request never reached a server (timeout / connection refused). */
  offline: boolean;
  error?: string;
}

/**
 * Issue a single API request and parse the JSON body. Returns
 * `{ ok, status, body, offline }` rather than throwing so callers can
 * treat "server unreachable" as a soft fallback rather than an error.
 *
 * `offline` is true when the underlying fetch fails (ECONNREFUSED,
 * DNS, abort timeout). HTTP error responses (4xx/5xx) set `ok=false`
 * but `offline=false` so callers can distinguish a real failure from
 * a missing server.
 */
export async function apiRequest(opts: ApiRequestOptions): Promise<ApiRequestResult> {
  const args = parseArgs(["api", opts.path]);
  if (opts.host !== undefined) args.flags["host"] = String(opts.host);
  if (opts.port !== undefined) args.flags["port"] = String(opts.port);
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, headers };
  if (opts.payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.payload);
  }
  const timeoutMs = opts.timeoutMs ?? 4000;
  if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
  const url = `${apiBaseUrl(args)}${opts.path}`;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (e: any) {
    return { ok: false, status: 0, body: null, offline: true, error: e?.message ?? String(e) };
  }
  const text = await response.text();
  let body: unknown = text;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { /* keep raw text */ }
  }
  return { ok: response.ok, status: response.status, body, offline: false };
}
