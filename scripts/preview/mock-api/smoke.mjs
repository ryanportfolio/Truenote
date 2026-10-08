// Smoke check for the fixture API: exact key sets per types/api.ts and the
// main role rules. Run with the server up: node scripts/preview/mock-api/smoke.mjs

import { buildSeed, CLEARANCE_RANK } from "./seed.mjs";

const BASE = process.env.MOCK_BASE ?? "http://localhost:5099";
let failures = 0;

function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

function keysEqual(label, obj, expected) {
  const actual = Object.keys(obj ?? {}).sort();
  const want = [...expected].sort();
  const same = actual.length === want.length && actual.every((k, i) => k === want[i]);
  check(label, same, same ? "" : `got [${actual}] want [${want}]`);
}

async function as(role) {
  const res = await fetch(`${BASE}/__mock/as/${role}`, { redirect: "manual" });
  return res.headers.get("set-cookie").split(";")[0];
}

async function call(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

await fetch(`${BASE}/__mock/reset`);
const csr = await as("csr");
const manager = await as("manager");
const demo = await as("demo_manager");

const me = await call(csr, "GET", "/api/me");
keysEqual("me.user", me.json.user, ["id", "email", "role", "programId", "name", "mustResetPassword"]);

const list = await call(csr, "GET", "/api/kb/documents");
keysEqual("kb list", list.json, ["items", "categories", "tags", "labels", "canOrganize"]);
keysEqual("kb label", list.json.labels[0], ["color", "name"]);
check(
  "jordan seeded labels",
  JSON.stringify(list.json.labels) ===
    JSON.stringify([
      { color: "green", name: "Easy wins" },
      { color: "amber", name: "Changes often" },
      { color: "red", name: "Read before quoting fees" }
    ]),
  JSON.stringify(list.json.labels)
);
const colorCount = (c) => list.json.items.filter((i) => i.myColor === c).length;
check("label filters have sources", colorCount("red") >= 4 && colorCount("green") >= 2 && colorCount("amber") >= 2,
  `red ${colorCount("red")} green ${colorCount("green")} amber ${colorCount("amber")}`);
keysEqual("kb item", list.json.items[0], [
  "documentId", "title", "updatedAt", "createdAt", "isNew", "viewCount", "citationCount",
  "lastViewedByMeAt", "pinnedAt", "note", "noteUpdatedAt", "myColor", "featuredPosition", "categoryIds", "tagIds"
]);
keysEqual("kb category", list.json.categories[0], ["id", "parentId", "name", "color", "myColor", "position", "documentIds"]);
keysEqual("kb tag", list.json.tags[0], ["id", "name", "color"]);
const items = list.json.items;
check("csr canOrganize false", list.json.canOrganize === false);
check("csr does not see confidential doc", !items.some((i) => i.title.startsWith("Fraud team")));
check("some new docs", items.filter((i) => i.isNew).length >= 3, String(items.filter((i) => i.isNew).length));
check("some never cited", items.filter((i) => i.citationCount === 0).length >= 3);
check("csr pins", items.filter((i) => i.pinnedAt).length === 6);
check("csr notes", items.filter((i) => i.note).length === 4);
check("csr long note", items.some((i) => (i.note ?? "").length >= 300));
const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
const recent = items.filter((i) => i.lastViewedByMeAt && Date.parse(i.lastViewedByMeAt) >= tenDaysAgo);
check("csr recently opened", recent.length >= 6, String(recent.length));
check("csr source colors", items.filter((i) => i.myColor).length === 9, String(items.filter((i) => i.myColor).length));
check("csr category override", list.json.categories.filter((c) => c.myColor).length === 1);
check("doc in 2 categories", items.some((i) => i.categoryIds.length === 2));
check("long title", items.some((i) => i.title.length >= 90));
check("empty category", list.json.categories.some((c) => c.documentIds.length === 0));
check("team pins", items.filter((i) => i.featuredPosition !== null).length === 3);
const byId = new Map(list.json.categories.map((c) => [c.id, c]));
const depth = (c) => (c.parentId ? 1 + depth(byId.get(c.parentId)) : 1);
check("3-level path", list.json.categories.some((c) => depth(c) === 3));

const doc = items.find((i) => i.title === "Cancellation fee schedule");
const reader = await call(csr, "GET", `/api/kb/documents/${doc.documentId}`);
keysEqual("kb document", reader.json, [
  "documentId", "documentVersionId", "versionNumber", "isCurrentVersion", "title", "markdown",
  "updatedAt", "citationAuthorized", "citationTarget", "pinnedAt", "note", "noteUpdatedAt", "myColor"
]);
check("reader personal color", reader.json.myColor === "red");
check("markdown has table", reader.json.markdown.includes("| --- |"));
const pin = await call(csr, "PUT", `/api/kb/documents/${doc.documentId}/pin`, { pinned: true });
keysEqual("pin item", pin.json.item, ["documentId", "pinnedAt", "note", "noteUpdatedAt", "color"]);
const note = await call(csr, "PUT", `/api/kb/documents/${doc.documentId}/note`, { note: "  " });
check("blank note clears", note.json.item.note === null);
const tooLong = await call(csr, "PUT", `/api/kb/documents/${doc.documentId}/note`, { note: "x".repeat(4001) });
check("note over 4000 is 400", tooLong.status === 400, tooLong.json.error);
const extra = await call(csr, "PUT", `/api/kb/documents/${doc.documentId}/pin`, { pinned: true, x: 1 });
check("strict body", extra.status === 400, extra.json.error);

// Personal colors: every role, demo included; row deleted when pin, note and color are all null.
const color = await call(csr, "PUT", `/api/kb/documents/${doc.documentId}/color`, { color: "teal" });
keysEqual("color item", color.json.item, ["documentId", "pinnedAt", "note", "noteUpdatedAt", "color"]);
check("source color set", color.json.item.color === "teal");
const badColor = await call(csr, "PUT", `/api/kb/documents/${doc.documentId}/color`, { color: "orange" });
check("bad color 400", badColor.status === 400, badColor.json.error);
await call(csr, "PUT", `/api/kb/documents/${doc.documentId}/pin`, { pinned: false });
const cleared = await call(csr, "PUT", `/api/kb/documents/${doc.documentId}/color`, { color: null });
check("all null clears", cleared.json.item.pinnedAt === null && cleared.json.item.color === null);
const clearedReader = (await call(csr, "GET", `/api/kb/documents/${doc.documentId}`)).json;
check("reader after clear", clearedReader.myColor === null && clearedReader.pinnedAt === null);
const fraudId = (await call(manager, "GET", "/api/kb/documents")).json.items.find((i) => i.title.startsWith("Fraud team")).documentId;
const hiddenColor = await call(csr, "PUT", `/api/kb/documents/${fraudId}/color`, { color: "red" });
check("color on hidden source 404", hiddenColor.status === 404);
const retention = list.json.categories.find((c) => c.name === "Retention");
check("seeded override", retention.myColor === "pink" && retention.color === "violet");
const catColor = await call(csr, "PUT", `/api/kb/categories/${retention.id}/color`, { color: "amber" });
keysEqual("category color item", catColor.json.item, ["categoryId", "myColor"]);
const managerRetention = (await call(manager, "GET", "/api/kb/documents")).json.categories.find((c) => c.id === retention.id);
check("category color is private", managerRetention.myColor === null);
const resetCat = await call(csr, "PUT", `/api/kb/categories/${retention.id}/color`, { color: null });
check("use team color", resetCat.json.item.myColor === null);
const unknownCat = await call(csr, "PUT", "/api/kb/categories/00000000-0000-4000-8000-ffffffffffff/color", { color: "red" });
check("unknown category 404", unknownCat.status === 404);
const demoColor = await call(demo, "PUT", `/api/kb/documents/${doc.documentId}/color`, { color: "violet" });
check("demo source color ok", demoColor.status === 200 && demoColor.json.item.color === "violet");
const demoCatColor = await call(demo, "PUT", `/api/kb/categories/${retention.id}/color`, { color: "slate" });
check("demo category color ok", demoCatColor.status === 200);

// Color names: personal, every role, demo included.
const label = await call(csr, "PUT", "/api/kb/labels/teal", { name: "  Callbacks  " });
check("label set trims", label.status === 200 && label.json.item.color === "teal" && label.json.item.name === "Callbacks");
const relabel = await call(csr, "PUT", "/api/kb/labels/red", { name: "Fees" });
check("label rename", relabel.json.item.name === "Fees");
const labelsNow = (await call(csr, "GET", "/api/kb/documents")).json.labels;
check("labels palette order", labelsNow.map((l) => l.color).join() === "green,amber,red,teal", labelsNow.map((l) => l.color).join());
const blankLabel = await call(csr, "PUT", "/api/kb/labels/teal", { name: "   " });
check("blank label clears", blankLabel.status === 200 && blankLabel.json.item === null);
const nullLabel = await call(csr, "PUT", "/api/kb/labels/amber", { name: null });
check("null label clears", nullLabel.status === 200 && nullLabel.json.item === null);
const longLabel = await call(csr, "PUT", "/api/kb/labels/red", { name: "x".repeat(41) });
check("label over 40 is 400", longLabel.status === 400 && Boolean(longLabel.json.error), longLabel.json.error);
const badLabel = await call(csr, "PUT", "/api/kb/labels/orange", { name: "Nope" });
check("unknown label color 400", badLabel.status === 400, badLabel.json.error);
const missingLabel = await call(csr, "PUT", "/api/kb/labels/red", {});
check("label name required 400", missingLabel.status === 400, missingLabel.json.error);
const demoLabel = await call(demo, "PUT", "/api/kb/labels/violet", { name: "Demo" });
check("demo label ok", demoLabel.status === 200 && demoLabel.json.item.name === "Demo");
const managerLabels = (await call(manager, "GET", "/api/kb/documents")).json.labels;
check("labels are private", managerLabels.length === 0);
const suLabels = (await call(await as("super_user"), "GET", "/api/kb/documents")).json;
check("labels without program", Array.isArray(suLabels.labels));

const csrCat = await call(csr, "POST", "/api/kb/library/categories", { name: "Nope" });
check("csr library 403 Forbidden", csrCat.status === 403 && csrCat.json.error === "Forbidden");
const demoCat = await call(demo, "POST", "/api/kb/library/categories", { name: "Nope" });
check("demo library 403", demoCat.status === 403, demoCat.json.error);

const created = await call(manager, "POST", "/api/kb/library/categories", { name: "Device help", color: "teal" });
check("create category 201", created.status === 201);
keysEqual("category item", created.json.item, ["id", "parentId", "name", "color", "myColor", "position", "documentIds"]);
const dup = await call(manager, "POST", "/api/kb/library/categories", { name: "device help" });
check("duplicate name 409", dup.status === 409, dup.json.error);
const mlist = (await call(manager, "GET", "/api/kb/documents")).json;
check("manager canOrganize", mlist.canOrganize === true);
const annual = mlist.categories.find((c) => c.name === "Annual plans");
const billing = mlist.categories.find((c) => c.name === "Billing");
const cycle = await call(manager, "PATCH", `/api/kb/library/categories/${billing.id}`, { parentId: annual.id });
check("cycle 409", cycle.status === 409, cycle.json.error);
const l4 = await call(manager, "POST", "/api/kb/library/categories", { name: "L4", parentId: annual.id });
const l5 = await call(manager, "POST", "/api/kb/library/categories", { name: "L5", parentId: l4.json.item.id });
check("depth 409", l5.status === 409, l5.json.error);
const members = await call(manager, "PUT", `/api/kb/library/categories/${created.json.item.id}/documents`, {
  documentIds: [doc.documentId]
});
check("set members", members.json.item.documentIds[0] === doc.documentId);
const order = await call(manager, "PUT", "/api/kb/library/categories/order", { parentId: null, orderedIds: [billing.id] });
check("partial order 400", order.status === 400, order.json.error);
const del = await call(manager, "DELETE", `/api/kb/library/categories/${annual.id}`);
check("delete category", del.json.ok === true);
const after = (await call(manager, "GET", "/api/kb/documents")).json;
check("child moved up", after.categories.find((c) => c.name === "L4").parentId === annual.parentId);
const tag = await call(manager, "POST", "/api/kb/library/tags", { name: "Billing", color: "blue" });
check("create tag", tag.status === 201 && tag.json.item.name === "Billing");
const feat = await call(manager, "PUT", "/api/kb/library/featured", { documentIds: [doc.documentId] });
check("featured set", feat.json.ok === true);
const thirteen = mlist.items.slice(0, 13).map((i) => i.documentId);
const overCap = await call(manager, "PUT", "/api/kb/library/featured", { documentIds: thirteen });
check("featured cap 400", overCap.status === 400 && overCap.json.error === "Team pins are limited to 12.", overCap.json.error);
const twelve = await call(manager, "PUT", "/api/kb/library/featured", { documentIds: thirteen.slice(0, 12) });
check("featured 12 ok", twelve.json.ok === true);
const featuredNow = (await call(manager, "GET", "/api/kb/documents")).json.items.filter((i) => i.featuredPosition !== null);
check("featured count 12", featuredNow.length === 12, String(featuredNow.length));

const usage = await call(manager, "GET", "/api/admin/insights/source-usage?days=30");
keysEqual("usage", usage.json, ["windowDays", "suggestions", "userId", "person", "people", "matrix", "totals", "sources", "users"]);
check("usage person null", usage.json.person === null);
check("no suggestions without person", Array.isArray(usage.json.suggestions) && usage.json.suggestions.length === 0);
const top = usage.json.sources[0];
check("source with 12+ questions in 30 days", top.citationCount >= 12, `${top.title}: ${top.citationCount}`);
keysEqual("usage people item", usage.json.people[0], ["userId", "name", "role", "questionCount"]);
const peopleNames = usage.json.people.map((p) => p.name);
check("people sorted by name", peopleNames.every((n, i) => i === 0 || peopleNames[i - 1].localeCompare(n) <= 0));
check("people roles", usage.json.people.every((p) => ["csr", "manager", "senior_manager"].includes(p.role)));
check("people has devon at 0", usage.json.people.some((p) => p.name === "Devon Clarke" && p.questionCount === 0));
check("people excludes other program", !peopleNames.includes("Lena Park") && !peopleNames.includes("Sam Okafor"));
keysEqual("usage matrix", usage.json.matrix, ["documentIds", "rows"]);
check("matrix top 10", usage.json.matrix.documentIds.length === Math.min(10, usage.json.totals.sourcesCited));
check("matrix rows match users", usage.json.matrix.rows.map((r) => r.userId).join() === usage.json.users.map((u) => u.userId).join());
keysEqual("matrix row", usage.json.matrix.rows[0], ["userId", "counts"]);
check("matrix counts length", usage.json.matrix.rows.every((r) => r.counts.length === usage.json.matrix.documentIds.length));
keysEqual("usage totals", usage.json.totals, [
  "questions", "answered", "refused", "sourcesCited", "sourcesNeverCited", "activeUsers"
]);
keysEqual("usage source", usage.json.sources[0], [
  "documentId", "title", "isLive", "citationCount", "questionCount", "userCount", "viewCount",
  "negativeCount", "lastCitedAt"
]);
keysEqual("usage user", usage.json.users[0], [
  "userId", "name", "email", "role", "questionCount", "answeredCount", "refusedCount",
  "negativeCount", "topSources", "lastAskedAt"
]);
const u90 = (await call(manager, "GET", "/api/admin/insights/source-usage?days=90")).json;
check("restricted title null", u90.sources.some((s) => s.title === null));
const u30 = (await call(manager, "GET", "/api/admin/insights/source-usage?days=30")).json;
const restricted = u30.sources.find((s) => s.title === null);
check("restricted cited in 30 days", Boolean(restricted));
const restrictedQs = await call(manager, "GET", `/api/admin/insights/source-usage/questions?days=90&documentId=${restricted.documentId}`);
check("restricted questions 404", restrictedQs.status === 404);
check("retired isLive false", u90.sources.some((s) => s.isLive === false));
const priya = u90.users.find((u) => u.name === "Priya Shah");
const p7 = (await call(manager, "GET", `/api/admin/insights/source-usage?days=7&userId=${priya.userId}`)).json;
check("priya empty 7 days", p7.totals.questions === 0 && p7.userId === priya.userId);
const jordanId = me.json.user.id;
const j7 = (await call(manager, "GET", `/api/admin/insights/source-usage?days=7&userId=${jordanId}`)).json;
check("jordan has 7-day questions", j7.totals.questions > 0, String(j7.totals.questions));
const j30 = (await call(manager, "GET", `/api/admin/insights/source-usage?days=30&userId=${jordanId}`)).json;
keysEqual("suggestion", j30.suggestions[0], ["documentId", "title", "reason", "teamCitations"]);
check("jordan suggestions 1..3", j30.suggestions.length >= 1 && j30.suggestions.length <= 3, String(j30.suggestions.length));
check("jordan has related", j30.suggestions.some((x) => x.reason === "related"), j30.suggestions.map((x) => `${x.reason}:${x.title}`).join(" | "));
check("jordan related only", j30.suggestions.every((x) => x.reason === "related"), j30.suggestions.map((x) => x.reason).join());
// Backend rule (selectSourceSuggestions): related ones when any exist, else
// team_top with at least 3 team answers. Never mixed, for every person and window.
const mixedOrThin = [];
for (const p of usage.json.people) {
  for (const d of [7, 30, 90]) {
    const s = (await call(manager, "GET", `/api/admin/insights/source-usage?days=${d}&userId=${p.userId}`)).json.suggestions;
    if (new Set(s.map((x) => x.reason)).size > 1) mixedOrThin.push(`${p.name}/${d} mixed`);
    if (s.some((x) => x.reason === "team_top" && x.teamCitations < 3)) mixedOrThin.push(`${p.name}/${d} below floor`);
  }
}
check("suggestions never mixed, team_top >= 3 team answers", mixedOrThin.length === 0, mixedOrThin.join(" | "));
const jordanQs = (await call(manager, "GET", `/api/admin/insights/source-usage/questions?days=30&userId=${jordanId}&limit=200`)).json.items;
const jordanCited = new Set(jordanQs.flatMap((q) => q.sources.map((x) => x.documentId)));
check("suggestions never cited by jordan", j30.suggestions.every((x) => !jordanCited.has(x.documentId)));
const jordanVisible = new Set(items.map((i) => i.documentId));
check("suggestions jordan can open", j30.suggestions.every((x) => jordanVisible.has(x.documentId)));
check("suggestions have titles", j30.suggestions.every((x) => typeof x.title === "string" && x.title.length > 0));
const cancelId = items.find((i) => i.title === "Cancellation fee schedule").documentId;
const cancelQs = (await call(manager, "GET", `/api/admin/insights/source-usage/questions?days=30&documentId=${cancelId}&limit=200`)).json.items;
const norm = (q) => q.toLowerCase().replace(/s+/g, " ").trim().replace(/[?.!s]+$/, "");
const askers = new Map();
for (const q of cancelQs) {
  const k = norm(q.question);
  askers.set(k, new Set([...(askers.get(k) ?? []), q.userId]));
}
check("same question by 2+ people", [...askers.values()].some((set) => set.size >= 2));
const devon = (await call(manager, "GET", "/api/admin/users")).json.items.find((u) => u.name === "Devon Clarke");
const d90 = (await call(manager, "GET", `/api/admin/insights/source-usage?days=90&userId=${devon.id}`)).json;
check("devon no questions", d90.totals.questions === 0 && d90.sources.length === 0);
check("devon team_top suggestions", d90.suggestions.length === 3 && d90.suggestions.every((x) => x.reason === "team_top"),
  d90.suggestions.map((x) => x.reason).join());
check("suggestions skip restricted", d90.suggestions.every((x) => x.title !== null));
keysEqual("person", d90.person, ["userId", "name", "email", "role"]);
check("devon person", d90.person.name === "Devon Clarke" && d90.person.userId === devon.id);
const all90 = (await call(manager, "GET", "/api/admin/insights/source-usage?days=90")).json;
check("matrix ignores userId", JSON.stringify(d90.matrix) === JSON.stringify(all90.matrix) && d90.matrix.rows.length > 0);
check("people ignores userId", JSON.stringify(d90.people) === JSON.stringify(all90.people));
const bad = await call(manager, "GET", "/api/admin/insights/source-usage?userId=00000000-0000-4000-8000-ffffffffffff");
check("unknown user 404", bad.status === 404);
const csrUsage = await call(csr, "GET", "/api/admin/insights/source-usage");
check("csr usage 403", csrUsage.status === 403);

const qs = await call(manager, "GET", `/api/admin/insights/source-usage/questions?days=90&documentId=${usage.json.sources[0].documentId}&limit=5`);
keysEqual("questions", qs.json, ["items", "truncated"]);
keysEqual("question item", qs.json.items[0], [
  "queryLogId", "question", "askedAt", "userId", "userName", "refused", "feedback", "sources"
]);
check("questions truncated", qs.json.truncated === true && qs.json.items.length === 5);
check("questions newest first", qs.json.items[0].askedAt >= qs.json.items[4].askedAt);

const gaps = await call(manager, "GET", "/api/admin/insights/kb-gaps?days=30");
keysEqual("gaps", gaps.json, ["items", "windowDays", "totals"]);
const users = await call(manager, "GET", "/api/admin/users");
check("users list", users.json.items.length >= 8);
const sessions = await call(csr, "GET", "/api/sessions");
check("sessions", sessions.json.items.length > 0);
const session = await call(csr, "GET", `/api/sessions/${sessions.json.items[0].id}`);
check("session exchanges", session.json.exchanges.length > 0);
const askRes = await fetch(`${BASE}/api/ask/stream`, {
  method: "POST",
  headers: { cookie: csr, "Content-Type": "application/json" },
  body: JSON.stringify({ question: "What is the cancellation fee for Unlimited Plus?", history: [] })
});
const lines = (await askRes.text()).trim().split("\n").map((l) => JSON.parse(l));
const result = lines.at(-1);
check("ask stream result", result.type === "result" && result.result.sources.length > 0);

const su = await as("super_user");
const suList = (await call(su, "GET", "/api/kb/documents")).json;
check("super user no program", suList.noProgramSelected === true);

// Suggestions = the backend rule, recomputed here from the seed rows for every
// person x window (insights.ts suggestionsQuery + source-usage.ts
// selectSourceSuggestions, restated in the SourceUsageSuggestion comment in
// types/api.ts). Written from that rule, not from server.mjs.
{
  await fetch(`${BASE}/__mock/reset`);
  const seed = buildSeed();
  const fresh = await as("manager");
  const viewer = seed.users.find((u) => u.email === "maria.chen@acme-wireless.example");
  const DAY_MS = 24 * 60 * 60 * 1000;
  // The server seeded a moment before this copy: shift by the gap, found from one row.
  const probe = (await call(fresh, "GET", "/api/admin/insights/source-usage/questions?days=90&limit=1")).json.items[0];
  const shift = Date.parse(probe.askedAt) - Date.parse(seed.queryLog.find((r) => r.id === probe.queryLogId).createdAt);
  const norm = (q) => q.toLowerCase().replace(/\s+/g, " ").trim().replace(/[?.!\s]+$/, "");
  const docIds = (row) => [...new Set(row.citations.map((c) => c.doc_id))];
  const rootsOf = (docId) => {
    const roots = new Set();
    for (const m of seed.categoryDocs.filter((x) => x.documentId === docId)) {
      let c = seed.categories.find((x) => x.id === m.categoryId);
      while (c && c.parentId) c = seed.categories.find((x) => x.id === c.parentId);
      if (c) roots.add(c.id);
    }
    return roots;
  };
  const opens = (user, doc) => CLEARANCE_RANK[user.clearance] >= CLEARANCE_RANK[doc.classification];
  function expected(person, rows) {
    const mine = rows.filter((r) => r.userId === person.id);
    const minePaths = new Set(mine.flatMap(docIds));
    const topics = new Set();
    for (const r of mine.filter((x) => x.refused || x.feedback === -1)) {
      for (const d of docIds(r)) rootsOf(d).forEach((id) => topics.add(id));
    }
    const refusedNorm = new Set(mine.filter((r) => r.refused).map((r) => norm(r.question)));
    for (const r of rows) {
      if (r.userId === person.id || r.refused || !refusedNorm.has(norm(r.question))) continue;
      for (const d of docIds(r)) rootsOf(d).forEach((id) => topics.add(id));
    }
    const team = new Map();
    for (const r of rows.filter((x) => x.userId !== null && x.userId !== person.id)) {
      for (const d of docIds(r)) {
        const e = team.get(d) ?? { n: 0, last: 0 };
        e.n += 1;
        e.last = Math.max(e.last, Date.parse(r.createdAt));
        team.set(d, e);
      }
    }
    const lower = CLEARANCE_RANK[person.clearance] < CLEARANCE_RANK[viewer.clearance] ? person : viewer;
    const usable = [...team.entries()]
      .map(([id, e]) => ({ id, ...e, doc: seed.documents.find((d) => d.id === id) }))
      .filter((c) => c.doc && !c.doc.retired && !minePaths.has(c.id) && opens(lower, c.doc))
      .sort((a, b) => b.n - a.n || b.last - a.last || a.id.localeCompare(b.id));
    const related = usable.filter((c) => [...rootsOf(c.id)].some((id) => topics.has(id)));
    const reason = related.length > 0 ? "related" : "team_top";
    const picked = related.length > 0 ? related : usable.filter((c) => c.n >= 3);
    return picked.slice(0, 3).map((c) => `${reason}:${c.doc.title}:${c.n}`);
  }
  const people = (await call(fresh, "GET", "/api/admin/insights/source-usage?days=30")).json.people;
  const differ = [];
  let aisha30 = null;
  for (const p of people) {
    const person = seed.users.find((u) => u.id === p.userId);
    for (const days of [7, 30, 90]) {
      const since = Date.now() - shift - days * DAY_MS;
      const rows = seed.queryLog.filter((r) => r.programId === person.programId && Date.parse(r.createdAt) >= since);
      const res = (await call(fresh, "GET", `/api/admin/insights/source-usage?days=${days}&userId=${p.userId}`)).json;
      const got = res.suggestions.map((x) => `${x.reason}:${x.title}:${x.teamCitations}`);
      const want = expected(person, rows);
      if (got.join("|") !== want.join("|")) differ.push(`${p.name}/${days}: got [${got.join(" | ")}] want [${want.join(" | ")}]`);
      if (p.name === "Aisha Bello" && days === 30) aisha30 = res.suggestions;
    }
  }
  check(`suggestions equal the backend rule for ${people.length} people x 3 windows`, differ.length === 0, differ.join(" ; "));
  check(
    "aisha 30 days: related (refused question teammates answered)",
    aisha30 !== null && aisha30.length > 0 && aisha30.every((x) => x.reason === "related"),
    JSON.stringify(aisha30?.map((x) => `${x.reason}:${x.title}`))
  );
}

await fetch(`${BASE}/__mock/reset`);
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
