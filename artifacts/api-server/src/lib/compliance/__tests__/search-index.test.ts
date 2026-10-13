import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryObjectStorage } from "../../storage/object-storage.js";
import { complianceDocumentKey, sha256Hex, type ComplianceManifest } from "../documents.js";
import {
  __resetComplianceSearchIndexForTests,
  getComplianceSearchIndex
} from "../search-index.js";

const MARKDOWN = "## Access\n\nQuarterly access reviews.\n";

async function setup(): Promise<{ storage: InMemoryObjectStorage; manifest: ComplianceManifest }> {
  const storage = new InMemoryObjectStorage();
  const sha256 = sha256Hex(Buffer.from(MARKDOWN));
  await storage.put(complianceDocumentKey({ slug: "plan", sha256 }), Buffer.from(MARKDOWN));
  return {
    storage,
    manifest: {
      schemaVersion: 1,
      documents: [{ slug: "plan", title: "Plan", version: "1", date: "2026-10-13", sha256, size: MARKDOWN.length }]
    }
  };
}

beforeEach(() => __resetComplianceSearchIndexForTests());

describe("getComplianceSearchIndex", () => {
  it("stops a request's wait at its deadline while the shared build carries on", async () => {
    const { storage, manifest } = await setup();
    let release: (() => void) | undefined;
    let embeds = 0;
    const embed = async (texts: string[]): Promise<number[][]> => {
      embeds += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return texts.map(() => [1, 0]);
    };
    const controller = new AbortController();
    const waiting = getComplianceSearchIndex(manifest, { storage, embed }, { signal: controller.signal });
    controller.abort(new Error("deadline"));
    await expect(waiting).rejects.toThrow("deadline");

    // A later question joins the same build instead of starting another.
    const later = getComplianceSearchIndex(manifest, { storage, embed });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    const index = await later;
    expect(index.passages).toHaveLength(1);
    expect(embeds).toBe(1);
  });

  it("fails a build stalled on storage at its timeout so the next question retries", async () => {
    const { storage, manifest } = await setup();
    const realGet = storage.get.bind(storage);
    let stall = true;
    storage.get = (key: string) => (stall ? new Promise<Buffer>(() => undefined) : realGet(key));
    const embed = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 0]);
    await expect(
      getComplianceSearchIndex(manifest, { storage, embed, buildTimeoutMs: 50 })
    ).rejects.toThrow();
    stall = false;
    const index = await getComplianceSearchIndex(manifest, { storage, embed, buildTimeoutMs: 50 });
    expect(index.passages).toHaveLength(1);
  });
});
