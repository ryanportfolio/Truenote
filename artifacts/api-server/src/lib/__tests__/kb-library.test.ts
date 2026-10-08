import { describe, expect, it } from "vitest";
import {
  CATEGORY_CYCLE_MESSAGE,
  CATEGORY_DEPTH_MESSAGE,
  CATEGORY_NAME_TAKEN_MESSAGE,
  canNestAt,
  categoryConflictMessage,
  categoryDocumentsSchema,
  createCategorySchema,
  createTagSchema,
  FEATURED_LIMIT_MESSAGE,
  featuredOverCap,
  featuredSchema,
  libraryColorOrNull,
  normalizeNote,
  noteSchema,
  personalColorSchema,
  pgErrorCode,
  pinSchema,
  reorderCategoriesSchema,
  sameIdSet,
  serializeCategory,
  serializeUserState,
  updateCategorySchema,
  updateTagSchema,
  validationMessage
} from "../kb-library.js";

const A = "b60c8d5f-ff83-4516-b283-208b6b5ac2d0";
const B = "4f1f7a8e-2d1b-4c55-9a0e-6f2d9b8c1a11";

describe("personal pin and note validation", () => {
  it("accepts a boolean pin and rejects extra fields", () => {
    expect(pinSchema.safeParse({ pinned: true }).success).toBe(true);
    expect(pinSchema.safeParse({ pinned: "yes" }).success).toBe(false);
    expect(pinSchema.safeParse({ pinned: true, userId: A }).success).toBe(false);
  });

  it("trims notes, caps them at 4000 characters, and clears empty notes", () => {
    const parsed = noteSchema.safeParse({ note: "  call back within 24h  " });
    expect(parsed.success && parsed.data.note).toBe("call back within 24h");
    expect(noteSchema.safeParse({ note: "x".repeat(4000) }).success).toBe(true);
    expect(noteSchema.safeParse({ note: `  ${"x".repeat(4000)}  ` }).success).toBe(true);
    const tooLong = noteSchema.safeParse({ note: "x".repeat(4001) });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(validationMessage(tooLong.error, "fallback")).toBe(
        "Notes can be at most 4000 characters."
      );
    }
    expect(normalizeNote("   ")).toBeNull();
    expect(normalizeNote(" kept ")).toBe("kept");
  });

  it("serializes a missing state row as cleared", () => {
    expect(serializeUserState(A, undefined)).toEqual({
      documentId: A,
      pinnedAt: null,
      note: null,
      noteUpdatedAt: null,
      color: null
    });
    expect(
      serializeUserState(A, {
        document_id: A,
        pinned_at: null,
        note: null,
        note_updated_at: null,
        color: "violet"
      }).color
    ).toBe("violet");
  });
});

describe("personal colors", () => {
  it("accepts a palette color or null and requires the key", () => {
    const parsed = personalColorSchema.safeParse({ color: "teal" });
    expect(parsed.success && parsed.data.color).toBe("teal");
    const cleared = personalColorSchema.safeParse({ color: null });
    expect(cleared.success && cleared.data.color).toBeNull();
    expect(personalColorSchema.safeParse({}).success).toBe(false);
    expect(personalColorSchema.safeParse({ color: "#ff0000" }).success).toBe(false);
    expect(personalColorSchema.safeParse({ color: "Blue" }).success).toBe(false);
    expect(personalColorSchema.safeParse({ color: "blue", userId: A }).success).toBe(false);
  });

  it("explains an off-palette color in plain words", () => {
    const bad = personalColorSchema.safeParse({ color: "orange" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(validationMessage(bad.error, "fallback")).toBe("Pick one of the listed colors.");
    }
  });

  it("reads stored colors back only when they are in the palette", () => {
    expect(libraryColorOrNull("amber")).toBe("amber");
    expect(libraryColorOrNull("orange")).toBeNull();
    expect(libraryColorOrNull(null)).toBeNull();
    expect(libraryColorOrNull(undefined)).toBeNull();
  });

  it("returns the viewer's category override next to the team color", () => {
    const row = { id: A, parent_id: null, name: "Billing", color: "blue", position: 2 };
    expect(serializeCategory({ ...row, my_color: "red" }, [B])).toEqual({
      id: A,
      parentId: null,
      name: "Billing",
      color: "blue",
      myColor: "red",
      position: 2,
      documentIds: [B]
    });
    expect(serializeCategory({ ...row, my_color: null }, []).myColor).toBeNull();
  });
});

describe("category and tag validation", () => {
  it("trims names and enforces the length limits with readable messages", () => {
    const parsed = createCategorySchema.safeParse({ name: "  Billing  " });
    expect(parsed.success && parsed.data.name).toBe("Billing");
    const blank = createCategorySchema.safeParse({ name: "   " });
    expect(blank.success).toBe(false);
    if (!blank.success) {
      expect(validationMessage(blank.error, "fallback")).toBe("Enter a category name.");
    }
    expect(createCategorySchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(createTagSchema.safeParse({ name: "x".repeat(40) }).success).toBe(true);
    expect(createTagSchema.safeParse({ name: "x".repeat(41) }).success).toBe(false);
  });

  it("allows only the shared palette and rejects unknown keys", () => {
    expect(createCategorySchema.safeParse({ name: "Refunds", color: "teal" }).success).toBe(true);
    expect(createCategorySchema.safeParse({ name: "Refunds", color: "#fff" }).success).toBe(false);
    const extra = createTagSchema.safeParse({ name: "Urgent", programId: A });
    expect(extra.success).toBe(false);
    if (!extra.success) {
      expect(validationMessage(extra.error, "Enter a tag name.")).toBe("Enter a tag name.");
    }
  });

  it("requires at least one field on updates and accepts a move to the top level", () => {
    expect(updateCategorySchema.safeParse({}).success).toBe(false);
    expect(updateCategorySchema.safeParse({ parentId: null }).success).toBe(true);
    expect(updateTagSchema.safeParse({}).success).toBe(false);
    expect(updateTagSchema.safeParse({ color: "red" }).success).toBe(true);
  });

  it("rejects duplicate and oversized id lists and lowercases ids", () => {
    expect(categoryDocumentsSchema.safeParse({ documentIds: [A, A] }).success).toBe(false);
    expect(
      categoryDocumentsSchema.safeParse({ documentIds: [A, A.toUpperCase()] }).success
    ).toBe(false);
    const parsed = reorderCategoriesSchema.safeParse({
      parentId: null,
      orderedIds: [A.toUpperCase(), B]
    });
    expect(parsed.success && parsed.data.orderedIds).toEqual([A, B]);
    const many = Array.from({ length: 13 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    expect(featuredSchema.safeParse({ documentIds: many.slice(0, 12) }).success).toBe(true);
    expect(featuredSchema.safeParse({ documentIds: many }).success).toBe(false);
  });

  it("caps the program's team pins, counting rows kept for hidden sources", () => {
    expect(featuredOverCap(12)).toBe(false);
    expect(featuredOverCap(13)).toBe(true);
    expect(FEATURED_LIMIT_MESSAGE).toBe("Team pins are limited to 12.");
  });
});

describe("structure helpers", () => {
  it("compares sibling sets regardless of order and case", () => {
    expect(sameIdSet([A, B], [B, A.toUpperCase()])).toBe(true);
    expect(sameIdSet([A, B], [A])).toBe(false);
    expect(sameIdSet([A, B], [A, A])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });

  it("limits nesting to four levels including the moved subtree", () => {
    expect(canNestAt(0, 4)).toBe(true);
    expect(canNestAt(3, 1)).toBe(true);
    expect(canNestAt(3, 2)).toBe(false);
    expect(canNestAt(4, 1)).toBe(false);
  });
});

describe("database error mapping", () => {
  it("reads the SQLSTATE from the error or its wrapped cause", () => {
    expect(pgErrorCode({ code: "23505" })).toBe("23505");
    expect(pgErrorCode({ message: "wrapped", cause: { code: "23514" } })).toBe("23514");
    expect(pgErrorCode(new Error("plain"))).toBeUndefined();
  });

  it("maps trigger and index refusals to plain messages", () => {
    const wrap = (code: string, message: string) => ({
      message: "Failed query",
      cause: Object.assign(new Error(message), { code })
    });
    expect(categoryConflictMessage(wrap("23505", "duplicate key"))).toBe(
      CATEGORY_NAME_TAKEN_MESSAGE
    );
    expect(
      categoryConflictMessage(wrap("23514", "kb_categories: categories nest at most 4 levels"))
    ).toBe(CATEGORY_DEPTH_MESSAGE);
    expect(
      categoryConflictMessage(wrap("23514", "kb_categories: a category cannot be inside itself"))
    ).toBe(CATEGORY_CYCLE_MESSAGE);
    expect(categoryConflictMessage(wrap("22P02", "invalid input"))).toBeNull();
  });
});
