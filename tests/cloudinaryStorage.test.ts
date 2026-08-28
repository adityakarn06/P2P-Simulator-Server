import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadInput } from "../src/storage/storage.interface.js";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from "../src/storage/storage.interface.js";
import { AppError } from "../src/utils/AppError.js";

// ---------------------------------------------------------------------------
// Mock the cloudinary SDK before importing the module under test.
// ---------------------------------------------------------------------------

const mockUploadStream = vi.fn();
const mockDestroy = vi.fn();
const mockUrl = vi.fn();
const mockPrivateDownloadUrl = vi.fn();

vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload_stream: mockUploadStream,
      destroy: mockDestroy,
    },
    url: mockUrl,
    utils: { private_download_url: mockPrivateDownloadUrl },
  },
}));

// Import after the mock is registered so the module picks up the stub.
const { CloudinaryStorage, buildPublicId } = await import("../src/storage/cloudinary.storage.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput(overrides: Partial<UploadInput> = {}): UploadInput {
  return {
    invoiceId: "inv-001",
    fileName: "receipt.pdf",
    buffer: Buffer.from("%PDF-1.4\nfake-pdf-content"),
    mimeType: "application/pdf",
    ...overrides,
  };
}

/**
 * Configure mockUploadStream so it immediately resolves with a fake
 * Cloudinary upload result.
 */
function stubSuccessfulUpload(bytes = 1024) {
  mockPrivateDownloadUrl.mockReturnValue("https://api.cloudinary.com/private-download");
  mockUrl.mockReturnValue(
    "https://res.cloudinary.com/test/image/authenticated/p2p/invoices/inv-001/receipt.pdf",
  );
  mockUploadStream.mockImplementation(
    (_opts: unknown, cb: (error: unknown, result?: unknown) => void) => {
      const fakeResult = {
        public_id: "p2p/invoices/inv-001/receipt",
        secure_url:
          "https://res.cloudinary.com/test/image/authenticated/p2p/invoices/inv-001/receipt.pdf",
        bytes,
      };
      // Return a stream-like object with an `end` method.
      return {
        end: () => cb(null, fakeResult),
      };
    },
  );
}

/** Minimal valid magic-byte prefixes for each allowed MIME type. */
const SIGNATURE_BYTES: Record<string, Buffer> = {
  "application/pdf": Buffer.from("%PDF-1.4\nfake-pdf-content"),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPublicId", () => {
  it("builds the correct path under p2p/invoices/{invoiceId}", () => {
    expect(buildPublicId("inv-42", "scan.pdf")).toBe("p2p/invoices/inv-42/scan");
  });

  it("strips the file extension", () => {
    expect(buildPublicId("inv-1", "photo.invoice.png")).toBe("p2p/invoices/inv-1/photo.invoice");
  });

  // originalname comes straight from the multipart headers, so the storage key
  // must not be able to escape the per-invoice folder.
  it.each([
    ["../../evil.pdf", "p2p/invoices/inv-1/evil"],
    ["a/b.pdf", "p2p/invoices/inv-1/a_b"],
    ["/etc/passwd.pdf", "p2p/invoices/inv-1/etc_passwd"],
    // Percent-encoded separators are not decoded anywhere, but the "%" is
    // still outside the safe set, so the name cannot carry one through.
    ["..%2f..%2fx.pdf", "p2p/invoices/inv-1/2f__2fx"],
  ])("neutralises %s", (fileName, expected) => {
    expect(buildPublicId("inv-1", fileName)).toBe(expected);
  });

  it("keeps the key valid when nothing survives sanitisation", () => {
    expect(buildPublicId("inv-1", "///.pdf")).toBe("p2p/invoices/inv-1/document");
  });

  it("caps a very long name so the key stays a sane length", () => {
    const key = buildPublicId("inv-1", `${"a".repeat(500)}.pdf`);

    expect(key.startsWith("p2p/invoices/inv-1/")).toBe(true);
    expect(key.length).toBeLessThanOrEqual("p2p/invoices/inv-1/".length + 64);
  });
});

describe("CloudinaryStorage", () => {
  let storage: InstanceType<typeof CloudinaryStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new CloudinaryStorage();
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe("upload – validation", () => {
    it("rejects unsupported MIME types", async () => {
      const input = validInput({ mimeType: "application/zip" });

      await expect(storage.upload(input)).rejects.toThrow(AppError);
      await expect(storage.upload(input)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });

    it.each(ALLOWED_MIME_TYPES)("accepts MIME type %s", async (mime) => {
      stubSuccessfulUpload();
      const input = validInput({ mimeType: mime, buffer: SIGNATURE_BYTES[mime] });

      const result = await storage.upload(input);
      expect(result).toHaveProperty("storageKey");
    });

    it("rejects a buffer whose content does not match the declared MIME type", async () => {
      const input = validInput({
        mimeType: "image/png",
        buffer: Buffer.from("%PDF-1.4\nnot actually a png"),
      });

      await expect(storage.upload(input)).rejects.toThrow(AppError);
      await expect(storage.upload(input)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });

    it("rejects files exceeding MAX_FILE_SIZE_BYTES", async () => {
      const oversizedBuffer = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
      const input = validInput({ buffer: oversizedBuffer });

      await expect(storage.upload(input)).rejects.toThrow(AppError);
      await expect(storage.upload(input)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });

    it("rejects empty files", async () => {
      const input = validInput({ buffer: Buffer.alloc(0) });

      await expect(storage.upload(input)).rejects.toThrow(AppError);
      await expect(storage.upload(input)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Upload (happy path)
  // -----------------------------------------------------------------------

  describe("upload – success", () => {
    it("returns storageKey, url, and bytes", async () => {
      stubSuccessfulUpload(2048);
      const input = validInput();

      const result = await storage.upload(input);

      expect(result).toEqual({
        storageKey: "p2p/invoices/inv-001/receipt",
        url: expect.stringContaining("cloudinary.com"),
        bytes: 2048,
      });
    });

    it("calls cloudinary upload_stream with correct options", async () => {
      stubSuccessfulUpload();
      const input = validInput();

      await storage.upload(input);

      expect(mockUploadStream).toHaveBeenCalledWith(
        expect.objectContaining({
          public_id: "p2p/invoices/inv-001/receipt",
          resource_type: "auto",
          type: "authenticated",
          overwrite: false,
        }),
        expect.any(Function),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Upload – Cloudinary errors
  // -----------------------------------------------------------------------

  describe("upload – Cloudinary failure", () => {
    it("wraps SDK errors as DEPENDENCY_UNAVAILABLE", async () => {
      mockUploadStream.mockImplementation(
        (_opts: unknown, cb: (error: unknown, result?: unknown) => void) => ({
          end: () => cb(new Error("Network timeout")),
        }),
      );

      const input = validInput();

      await expect(storage.upload(input)).rejects.toThrow(AppError);
      await expect(storage.upload(input)).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  describe("delete", () => {
    it("calls cloudinary.uploader.destroy with the storage key", async () => {
      mockDestroy.mockResolvedValue({ result: "ok" });

      await storage.delete("p2p/invoices/inv-001/receipt");

      expect(mockDestroy).toHaveBeenCalledWith("p2p/invoices/inv-001/receipt", {
        type: "authenticated",
        invalidate: true,
      });
    });

    it("wraps SDK errors as DEPENDENCY_UNAVAILABLE", async () => {
      mockDestroy.mockRejectedValue(new Error("Cloudinary is down"));

      await expect(storage.delete("key")).rejects.toThrow(AppError);
      await expect(storage.delete("key")).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Download
  // -----------------------------------------------------------------------

  describe("download", () => {
    it("fetches the signed URL and returns the bytes", async () => {
      const body = Buffer.from("%PDF-1.4\nfake-pdf-content");
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => body });
      vi.stubGlobal("fetch", fetchMock);

      // Pin Date.now() so the expires_at calculation is deterministic.
      const fixedNowMs = 1_700_000_000_000;
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNowMs);
      const expectedExpiresAt = Math.floor(fixedNowMs / 1000) + 300;

      try {
        const result = await storage.download("p2p/invoices/inv-001/receipt", "application/pdf");

        expect(result.equals(body)).toBe(true);
        // The abort signal is the only thing stopping a hung Cloudinary socket
        // from pinning an invoice worker's job open forever.
        expect(fetchMock).toHaveBeenCalledWith("https://api.cloudinary.com/private-download", {
          signal: expect.any(AbortSignal),
        });

        // Not the delivery URL: Cloudinary accounts block PDF *delivery* by
        // default and answer 401 no matter how well the URL is signed, so the
        // Admin API download link is the only way to read a PDF invoice back.
        expect(mockUrl).not.toHaveBeenCalled();
        expect(mockPrivateDownloadUrl).toHaveBeenCalledWith(
          "p2p/invoices/inv-001/receipt",
          "pdf",
          expect.objectContaining({
            type: "authenticated",
            resource_type: "image",
            expires_at: expectedExpiresAt,
          }),
        );
      } finally {
        dateNowSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it("reports a missing object as NOT_FOUND so the caller does not retry it", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      await expect(storage.download("missing-key", "application/pdf")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      vi.unstubAllGlobals();
    });

    it("reports a server-side failure as DEPENDENCY_UNAVAILABLE", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

      await expect(storage.download("key", "application/pdf")).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });

      vi.unstubAllGlobals();
    });

    it("treats a rate-limited response as retryable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));

      await expect(storage.download("key", "application/pdf")).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });

      vi.unstubAllGlobals();
    });

    it("reports a network failure as DEPENDENCY_UNAVAILABLE", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

      await expect(storage.download("key", "application/pdf")).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });

      vi.unstubAllGlobals();
    });
  });

  // -----------------------------------------------------------------------
  // getUrl
  // -----------------------------------------------------------------------

  describe("getUrl", () => {
    it("delegates to cloudinary.url with authenticated + signed options", () => {
      mockUrl.mockReturnValue("https://res.cloudinary.com/signed-url");

      const url = storage.getUrl("p2p/invoices/inv-001/receipt", "application/pdf");

      expect(url).toBe("https://res.cloudinary.com/signed-url");
      expect(mockUrl).toHaveBeenCalledWith("p2p/invoices/inv-001/receipt", {
        resource_type: "image",
        type: "authenticated",
        secure: true,
        sign_url: true,
        format: "pdf",
      });
    });

    // Regression: without an explicit format, Cloudinary reads the segment after
    // the last dot of `.../Invoice_v1.2` as the format, resolving public_id
    // `.../Invoice_v1` + format `2` — an object that does not exist. The signed
    // URL then denies, download() maps the 4xx to NOT_FOUND, and the invoice
    // worker treats NOT_FOUND as permanent and fails the invoice with no retry.
    it("names the format so a storage key containing a dot still resolves", () => {
      mockUrl.mockReturnValue("https://res.cloudinary.com/signed-url");

      storage.getUrl("p2p/invoices/inv-1/Invoice_v1.2", "image/png");

      expect(mockUrl).toHaveBeenCalledWith(
        "p2p/invoices/inv-1/Invoice_v1.2",
        expect.objectContaining({ format: "png" }),
      );
    });

    it("requests JPEGs as jpg, the format Cloudinary actually stores", () => {
      mockUrl.mockReturnValue("https://res.cloudinary.com/signed-url");

      storage.getUrl("p2p/invoices/inv-1/scan", "image/jpeg");

      expect(mockUrl).toHaveBeenCalledWith(
        "p2p/invoices/inv-1/scan",
        expect.objectContaining({ format: "jpg" }),
      );
    });

    it("rejects a MIME type it cannot map to a delivery format", () => {
      expect(() => storage.getUrl("p2p/invoices/inv-1/scan", "application/zip")).toThrow(AppError);
      expect(() => storage.getUrl("p2p/invoices/inv-1/scan", "application/zip")).toThrow(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    });
  });
});
