import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_PATH = "../src/config/env.js";

function validEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    DIRECT_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    GEMINI_API_KEY: "test-key",
    CLOUDINARY_CLOUD_NAME: "test-cloud",
    CLOUDINARY_API_KEY: "test-key",
    CLOUDINARY_API_SECRET: "test-secret",
  };
}

describe("env schema", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("exits when a required variable is missing", async () => {
    process.env = { ...validEnv(), DATABASE_URL: "" } as unknown as NodeJS.ProcessEnv;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as typeof process.exit);

    await expect(import(ENV_PATH)).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  // The enum exists so a typo cannot silently disable the production
  // error-message suppression in src/middleware/errorHandler.ts — but it must
  // not lock out a real deployment name either.
  it.each(["development", "test", "ci", "staging", "production"])(
    "accepts NODE_ENV=%s",
    async (nodeEnv) => {
      process.env = { ...validEnv(), NODE_ENV: nodeEnv } as unknown as NodeJS.ProcessEnv;

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) called`);
      }) as typeof process.exit);

      await expect(import(ENV_PATH)).resolves.toBeDefined();
      expect(exitSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
      vi.resetModules();
    },
  );

  it("exits on a misspelled NODE_ENV rather than silently treating it as non-production", async () => {
    process.env = { ...validEnv(), NODE_ENV: "producton" } as unknown as NodeJS.ProcessEnv;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as typeof process.exit);

    await expect(import(ENV_PATH)).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("defaults TRUST_PROXY_HOPS to 0 so a forged X-Forwarded-For cannot buy quota", async () => {
    process.env = validEnv() as unknown as NodeJS.ProcessEnv;

    const mod = (await import(ENV_PATH)) as { env: { TRUST_PROXY_HOPS: number } };

    expect(mod.env.TRUST_PROXY_HOPS).toBe(0);
  });

  it("exposes the coerced PORT as a number, not the raw string", async () => {
    process.env = { ...validEnv(), PORT: "5050" } as unknown as NodeJS.ProcessEnv;

    const mod = (await import(ENV_PATH)) as { env: { PORT: number } };

    expect(mod.env.PORT).toBe(5050);
  });

  it("loads cleanly when everything required is present", async () => {
    process.env = { ...validEnv(), PORT: "5050" } as unknown as NodeJS.ProcessEnv;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as typeof process.exit);

    await expect(import(ENV_PATH)).resolves.toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
