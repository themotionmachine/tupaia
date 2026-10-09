// Turning bridge envelopes and tool values into MCP CallToolResults.
//
// Conventions (all tools):
// - Success: content = [...image blocks, one text block with compact JSON]; structuredContent
//   is the same object. Per-call extras are merged into that object: `alerts` (app dialogs
//   seen and dismissed), `consoleErrors` (page errors that arrived during this call) and
//   `notes` (server notices such as "browser relaunched").
// - Failure: isError:true, text "CODE: message" then a JSON line {error:{code,message,
//   candidates?,details?}, consoleErrors?, notes?}. Codes: NOT_FOUND, AMBIGUOUS, REMOVED,
//   OUT_OF_BOUNDS, BAD_ARGS, BAD_PLACE, BAD_REF, BAD_TYPE, BAD_LAYER, REFUSED, MODE, TIMEOUT,
//   EVAL_ERROR, EVAL_SYNTAX, APP_ALERT, PAGE_ERROR, BROWSER, RESULT_TOO_LARGE, NO_POSITION.
import type { CallToolResult } from "@modelcontextprotocol/server";

export interface Alert {
  title: string;
  text: string;
  error: boolean;
}

export interface BridgeError {
  code: string;
  message: string;
  candidates?: unknown[];
  details?: unknown;
  stack?: string;
}

export interface Envelope<T = unknown> {
  ok: boolean;
  value?: T;
  error?: BridgeError;
  alerts?: Alert[];
  ms: number;
  op: string | null;
}

export class ToolError extends Error {
  code: string;
  candidates?: unknown[];
  details?: unknown;
  constructor(code: string, message: string, extra?: { candidates?: unknown[]; details?: unknown }) {
    super(message);
    this.code = code;
    if (extra?.candidates) this.candidates = extra.candidates;
    if (extra?.details !== undefined) this.details = extra.details;
  }
  static from(e: BridgeError): ToolError {
    const details = e.stack
      ? { ...(typeof e.details === "object" && e.details ? e.details : {}), stack: e.stack }
      : e.details;
    return new ToolError(e.code, e.message, { candidates: e.candidates, details });
  }
}

export interface ImageBlock {
  data: string;
  mimeType: string;
}

/** Normalised tool output. `text` (compact formats) replaces the JSON text and structuredContent. */
export interface ToolOutput {
  value: Record<string, unknown>;
  images?: ImageBlock[];
  text?: string;
}

/** Return this from a tool implementation to attach image blocks; otherwise return a plain object. */
export class WithImages {
  value: Record<string, unknown>;
  images: ImageBlock[];
  constructor(value: Record<string, unknown>, images: ImageBlock[]) {
    this.value = value;
    this.images = images;
  }
}

/**
 * Return this from a tool implementation to send plain text instead of JSON (format:'compact').
 * There is no structuredContent then; alerts, consoleErrors and notes follow as one JSON line.
 */
export class WithText {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export interface Extras {
  consoleErrors?: string[];
  notes?: string[];
  alerts?: Alert[];
}

/** For text-heavy tools: let Claude Code keep up to 200k chars inline. */
export const META_TEXT_HEAVY = { "anthropic/maxResultSizeChars": 200000 } as const;

export const MAX_TEXT_CHARS = 480_000;

function withExtras(value: Record<string, unknown>, extras: Extras): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  if (extras.alerts?.length) out.alerts = [...((out.alerts as Alert[] | undefined) ?? []), ...extras.alerts];
  if (extras.consoleErrors?.length) out.consoleErrors = extras.consoleErrors;
  if (extras.notes?.length) out.notes = extras.notes;
  return out;
}

export function okResult(out: ToolOutput, extras: Extras = {}): CallToolResult {
  const value = withExtras(out.text !== undefined ? {} : out.value, extras);
  let text: string;
  if (out.text !== undefined) {
    text = Object.keys(value).length ? `${out.text}\n${JSON.stringify(value)}` : out.text;
  } else text = JSON.stringify(value);
  if (text.length > MAX_TEXT_CHARS) {
    return errorResult(
      new ToolError(
        "RESULT_TOO_LARGE",
        `result is ${text.length} chars (limit ${MAX_TEXT_CHARS}); narrow it (limit, fields, where) or save to a file`
      ),
      extras
    );
  }
  const content: CallToolResult["content"] = [];
  for (const img of out.images ?? []) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  content.push({ type: "text", text });
  return out.text !== undefined ? { content } : { content, structuredContent: value };
}

export function errorResult(err: unknown, extras: Extras = {}): CallToolResult {
  const e =
    err instanceof ToolError
      ? err
      : new ToolError("SERVER_ERROR", err instanceof Error ? err.message : String(err), {
          details: err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 4).join("\n") : undefined
        });
  const body: Record<string, unknown> = {
    error: {
      code: e.code,
      message: e.message,
      ...(e.candidates?.length ? { candidates: e.candidates } : {}),
      ...(e.details !== undefined ? { details: e.details } : {})
    }
  };
  const full = withExtras(body, extras);
  let lead = `${e.code}: ${e.message}`;
  if (e.candidates?.length) {
    const names = e.candidates
      .slice(0, 8)
      .map(c => {
        const r = c as { i?: unknown; name?: unknown };
        return r && typeof r === "object" ? `${String(r.name)} (${String(r.i)})` : String(c);
      })
      .join(", ");
    lead += `\ncandidates: ${names}`;
  }
  return { isError: true, content: [{ type: "text", text: `${lead}\n${JSON.stringify(full)}` }] };
}

/** Throw a ToolError for a failed envelope; return its value otherwise. */
export function unwrap<T>(env: Envelope<T>): T {
  if (!env.ok) throw ToolError.from(env.error ?? { code: "PAGE_ERROR", message: "bridge call failed" });
  return env.value as T;
}
