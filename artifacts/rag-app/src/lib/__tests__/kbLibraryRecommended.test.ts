import { describe, expect, it } from "vitest";
import {
  applyTeamShortcuts,
  isRecommended,
  recommendedDocs,
  shortcutShelf,
  supervisorPins,
  teamPins
} from "../kbLibrary";
import { withKbTeamPinDefaults } from "../api";
import type { KbDocumentListItem, KbDocumentListResponse } from "@/types/api";

function doc(
  id: string,
  featuredPosition: number | null,
  teamPinPosition: number | null,
  extra: Partial<KbDocumentListItem> = {}
): KbDocumentListItem {
  return {
    documentId: id,
    title: id,
    updatedAt: null,
    createdAt: null,
    isNew: false,
    viewCount: 0,
    citationCount: 0,
    lastViewedByMeAt: null,
    pinnedAt: null,
    note: null,
    noteUpdatedAt: null,
    myColor: null,
    featuredPosition,
    teamPinPosition,
    categoryIds: [],
    tagIds: [],
    ...extra
  };
}

function library(items: KbDocumentListItem[]): KbDocumentListResponse {
  return { items, categories: [], tags: [], labels: [], canOrganize: false, canPinForTeam: false };
}

const ids = (docs: KbDocumentListItem[]): string[] => docs.map((d) => d.documentId);

describe("isRecommended", () => {
  it("is true for a manager pin, a supervisor pin, or both", () => {
    expect(isRecommended(doc("a", 0, null))).toBe(true);
    expect(isRecommended(doc("b", null, 0))).toBe(true);
    expect(isRecommended(doc("c", 2, 1))).toBe(true);
  });

  it("is false when neither list has the source", () => {
    expect(isRecommended(doc("d", null, null))).toBe(false);
  });
});

describe("recommendedDocs", () => {
  it("puts manager pins first by featuredPosition, then supervisor pins by teamPinPosition", () => {
    const items = [
      doc("team-1", null, 1),
      doc("prog-1", 1, null),
      doc("plain", null, null),
      doc("team-0", null, 0),
      doc("prog-0", 0, null)
    ];
    expect(ids(recommendedDocs(items))).toEqual(["prog-0", "prog-1", "team-0", "team-1"]);
  });

  it("lists a source on both lists once, in the manager's place", () => {
    const items = [doc("both", 1, 0), doc("prog-0", 0, null), doc("team-1", null, 1)];
    expect(ids(recommendedDocs(items))).toEqual(["prog-0", "both", "team-1"]);
  });

  it("keeps teamPins on the manager's list only", () => {
    const items = [doc("team-0", null, 0), doc("prog-0", 0, null)];
    expect(ids(teamPins(items))).toEqual(["prog-0"]);
    expect(ids(supervisorPins(items))).toEqual(["team-0"]);
  });

  it("is empty when nothing is recommended", () => {
    expect(recommendedDocs([doc("a", null, null)])).toEqual([]);
  });
});

describe("shortcutShelf", () => {
  it("leads with Recommended in recommendedDocs order, then the user's own", () => {
    const items = [
      doc("mine", null, null, { pinnedAt: "2026-10-01T00:00:00Z" }),
      doc("team-0", null, 0, { pinnedAt: "2026-09-01T00:00:00Z" }),
      doc("prog-0", 0, null)
    ];
    expect(shortcutShelf(items).map((s) => [s.doc.documentId, s.source])).toEqual([
      ["prog-0", "team"],
      ["team-0", "team"],
      ["mine", "mine"]
    ]);
  });
});

describe("applyTeamShortcuts", () => {
  it("sets teamPinPosition from the ordered list and clears it elsewhere", () => {
    const next = applyTeamShortcuts(
      library([doc("a", null, 0), doc("b", 0, null), doc("c", null, 1)]),
      ["c", "b"]
    );
    expect(next.items.map((d) => [d.documentId, d.teamPinPosition, d.featuredPosition])).toEqual([
      ["a", null, null],
      ["b", 1, 0],
      ["c", 0, null]
    ]);
  });

  it("returns unchanged items as the same objects", () => {
    const a = doc("a", null, 0);
    const next = applyTeamShortcuts(library([a, doc("b", null, null)]), ["a", "b"]);
    expect(next.items[0]).toBe(a);
  });

  it("puts a saved list back over an older list that a reload read before the save landed", () => {
    // The page after a reload that ran while [a, b] was still queued: the server's old, empty list.
    const stale = library([doc("a", null, null), doc("b", null, null), doc("c", null, null)]);
    // The reconcile a successful [a, b] save returns.
    const reconcile = (d: KbDocumentListResponse) => applyTeamShortcuts(d, ["a", "b"]);
    expect(ids(supervisorPins(reconcile(stale).items))).toEqual(["a", "b"]);
  });

  it("changes nothing when the page already shows the saved list", () => {
    const current = applyTeamShortcuts(library([doc("a", null, null), doc("b", null, null)]), ["b", "a"]);
    const next = applyTeamShortcuts(current, ["b", "a"]);
    expect(next.items).toEqual(current.items);
    next.items.forEach((item, i) => expect(item).toBe(current.items[i]));
  });
});

describe("withKbTeamPinDefaults", () => {
  it("reads a missing teamPinPosition and canPinForTeam from an older server as null and false", () => {
    const old = {
      items: [{ ...doc("a", 0, null), teamPinPosition: undefined }],
      categories: [],
      tags: [],
      labels: [],
      canOrganize: true
    } as unknown as KbDocumentListResponse;
    const data = withKbTeamPinDefaults(old);
    expect(data.canPinForTeam).toBe(false);
    expect(data.items.map((d) => d.teamPinPosition)).toEqual([null]);
    expect(data.items.map(isRecommended)).toEqual([true]);
    expect(ids(recommendedDocs(data.items))).toEqual(["a"]);
  });

  it("keeps the values a current server sends", () => {
    const data = withKbTeamPinDefaults({ ...library([doc("a", null, 3)]), canPinForTeam: true });
    expect(data.canPinForTeam).toBe(true);
    expect(data.items.map((d) => d.teamPinPosition)).toEqual([3]);
  });
});
