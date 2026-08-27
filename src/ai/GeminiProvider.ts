import { GoogleGenAI } from "@google/genai";
import { AppError } from "../utils/AppError.js";
import type {
  AIProvider,
  AnalyzeDocumentOptions,
  GenerateStructuredOptions,
} from "./AIProvider.js";

export const DEFAULT_MODEL = "gemini-3.6-flash";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * HTTP statuses that mean "this request will fail identically every time":
 * a malformed request, a bad or unauthorised API key, or a model id that does
 * not exist. Retrying them only delays the terminal outcome and burns quota,
 * so they are raised as AI_PROCESSING_FAILED, which the workers treat as
 * permanent. Everything else — 429, 5xx, timeouts, socket errors — stays
 * DEPENDENCY_UNAVAILABLE and keeps its BullMQ retries.
 */
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404]);

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.code === "number") {
    return candidate.code;
  }
  return null;
}

/**
 * Turns an SDK failure into the right AppError. Classification is by HTTP
 * status where the SDK exposes one; anything unrecognised is assumed transient,
 * because wrongly treating an outage as permanent loses work.
 */
function toAppError(error: unknown, context: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const cause = error instanceof Error ? error.message : error;
  const status = statusOf(error);

  if (status !== null && PERMANENT_HTTP_STATUSES.has(status)) {
    return new AppError("AI_PROCESSING_FAILED", `${context} (HTTP ${status})`, { cause });
  }

  return AppError.dependencyUnavailable(context, { cause });
}

export class GeminiProvider implements AIProvider {
  private readonly client: GoogleGenAI;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async generateStructured({
    systemPrompt,
    userPrompt,
    promptName,
  }: GenerateStructuredOptions): Promise<string> {
    // AbortSignal.timeout, not a Promise.race: racing leaves the request in
    // flight, so a timed-out job keeps a socket open and burns quota against
    // work nobody is waiting for any more.
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const response = await this.client.models.generateContent({
        model: DEFAULT_MODEL,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          abortSignal: signal,
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error("Empty response from Gemini");
      }
      return text;
    } catch (error) {
      throw toAppError(error, `Gemini request failed (${promptName})`);
    }
  }

  async analyzeDocument({
    systemPrompt,
    document,
    mimeType,
    promptName,
  }: AnalyzeDocumentOptions): Promise<string> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const response = await this.client.models.generateContent({
        model: DEFAULT_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { data: document.toString("base64"), mimeType } },
              { text: "Extract the structured data described in the system instructions." },
            ],
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          abortSignal: signal,
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error("Empty response from Gemini");
      }
      return text;
    } catch (error) {
      throw toAppError(error, `Gemini document analysis failed (${promptName})`);
    }
  }
}
