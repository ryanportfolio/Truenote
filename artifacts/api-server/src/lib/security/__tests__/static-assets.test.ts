import { describe, expect, it } from "vitest";
import { compressedAssetFileName } from "../static-assets.js";

describe("compressedAssetFileName", () => {
  it("accepts flat Vite asset basenames with server-selected compression", () => {
    expect(compressedAssetFileName("index-C0FFEE.js", ".br")).toBe(
      "index-C0FFEE.js.br"
    );
    expect(compressedAssetFileName("styles.a1b2.css", ".gz")).toBe(
      "styles.a1b2.css.gz"
    );
  });

  it("rejects traversal, absolute, nested, encoded, and control-character paths", () => {
    for (const value of [
      "../secret.js",
      "..\\secret.js",
      "/absolute.js",
      "C:\\absolute.js",
      "nested/index.js",
      "nested\\index.js",
      "%2e%2e%2fsecret.js",
      "index.js%00",
      "index.js\nforged",
      ".hidden.js"
    ]) {
      expect(compressedAssetFileName(value, ".br")).toBeNull();
    }
  });

  it("rejects asset types the build does not precompress", () => {
    expect(compressedAssetFileName("font.woff2", ".br")).toBeNull();
    expect(compressedAssetFileName("photo.png", ".gz")).toBeNull();
  });
});
