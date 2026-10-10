// Local fixture API for visual review of the Sources and Source usage pages.
// Plain Node, no dependencies. State lives in memory; /__mock/reset reseeds.
// Shapes mirror artifacts/rag-app/src/types/api.ts.

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { buildSeed, CLEARANCE_RANK, nextId } from "./seed.mjs";

const PORT = Number(process.env.MOCK_PORT) || 5099;
const FRONTEND_PORT = Number(process.env.PORT) || 5173;
const DAY = 24 * 60 * 60 * 1000;
const NEW_WINDOW_MS = 14 * DAY;
const COLORS = ["slate", "blue", "green", "amber", "red", "violet", "teal", "pink"];
const ROLE_RANK = { super_user: 100, senior_manager: 80, manager: 60, supervisor: 40, csr: 20 };
const DEMO_MESSAGE = "Demo accounts can't do this";
const TEAM_PINNER_MESSAGE = "Only supervisors can recommend sources to a team.";
/** Team pins and a supervisor's recommended list share this cap. */
const MAX_FEATURED = 12;
const MAX_TEAM_ASSIGNMENT = 200;
const ASK_EXAMPLES_MAX = 6;
const ASK_EXAMPLE_MAX_LENGTH = 200;
const DEFAULT_ASK_EXAMPLES = [
  "What's the cancellation fee on the Basic plan?",
  "How long does a refund take to post to the original card?",
  "Who must approve a courtesy refund?"
];

let state = buildSeed();
let delayMs = Number(process.env.MOCK_DELAY_MS) || 0;
/** Upper bound for the delay control, so a typo cannot stall the fixture. */
const MAX_DELAY_MS = 10000;
const failPaths = new Set();
const audit = [];

// ---------------------------------------------------------------------------
// HTTP helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const notFound = () => new HttpError(404, "Not found");
const badRequest = (message) => new HttpError(400, message);

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(badRequest("The request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

/** One cookie's value, or undefined. */
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/** Strips line breaks so a request path cannot forge extra log lines. */
const logSafe = (text) => String(text).replace(/\n|\r/g, "");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** zod .strict() stand-in: object body with only the allowed keys. */
function strictBody(body, allowed) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("The request body must be a JSON object.");
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw badRequest(`The field "${key}" is not accepted here.`);
  }
  return body;
}

function idList(value, label, max) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw badRequest(`${label} must be a list of ids.`);
  }
  if (value.length > max) throw badRequest(`${label} can have at most ${max} entries.`);
  if (new Set(value).size !== value.length) throw badRequest(`${label} has the same id twice.`);
  return value;
}

function colorField(value) {
  if (value === undefined) return undefined;
  if (!COLORS.includes(value)) throw badRequest("Pick one of the listed colors.");
  return value;
}

function nameField(value, max, label) {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) {
    throw badRequest(`${label} names must be 1 to ${max} characters.`);
  }
  return value.trim();
}

function windowDays(url) {
  const raw = url.searchParams.get("days");
  if (raw === null) return 30;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw badRequest("The time window must be a whole number of days from 1 to 365.");
  }
  return days;
}

const iso = (ms) => new Date(ms).toISOString();
const normalizeQuestion = (q) =>
  q.toLowerCase().replace(/\s+/g, " ").trim().replace(/[?.!\s]+$/, "");

// ---------------------------------------------------------------------------
// Auth and scope

const ROLE_ALIASES = {
  csr: "jordan.reyes@acme-wireless.example",
  supervisor: "renee.alvarez@acme-wireless.example",
  demo_supervisor: "demo.supervisor@truenote.example",
  manager: "maria.chen@acme-wireless.example",
  demo_manager: "demo.manager@truenote.example",
  super_user: "sam.okafor@truenote.example"
};

/** A role alias (csr, manager...), an email, a user id or a first name, as /__mock/as/<key> takes. */
function userByKey(key) {
  const email = ROLE_ALIASES[key];
  return state.users.find(
    (u) => u.email === email || u.email === key || u.id === key || u.name.split(" ")[0].toLowerCase() === key
  );
}

function currentUser(req) {
  // The cookie holds the key the role switch was given, never user data.
  const cookie = readCookie(req, "mock_user");
  if (cookie === "out") return null;
  const user = userByKey(cookie ?? "manager");
  return user && user.isActive ? user : null;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    programId: user.programId,
    name: user.name,
    mustResetPassword: user.mustResetPassword
  };
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "Unauthorized");
  return user;
}

function requireRole(user, minimum) {
  if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) throw new HttpError(403, "Forbidden");
}

function effectiveProgramId(user, req) {
  if (user.role !== "super_user") return user.programId;
  const header = req.headers["x-program-id"];
  if (typeof header !== "string") return null;
  return state.programs.some((p) => p.id === header) ? header : null;
}

function requireProgram(user, req) {
  const programId = effectiveProgramId(user, req);
  if (!programId) throw badRequest("No program selected.");
  return programId;
}

const canSee = (user, doc) => CLEARANCE_RANK[user.clearance] >= CLEARANCE_RANK[doc.classification];
/**
 * lib/auth/demo-limits.ts: demo accounts are limited until a super user
 * lifts the limits on the Security page.
 */
const demoLimits = { enabled: true, updatedAt: null, updatedByName: null, updatedByEmail: null };
const limitedDemo = (user) => Boolean(user.isDemo) && demoLimits.enabled;
const securityEvents = [];
const canOrganize = (user) => ROLE_RANK[user.role] >= ROLE_RANK.manager && !limitedDemo(user);
/** lib/kb-library.ts canPinForTeam plus the demo block on the list flag. */
const canPinForTeam = (user) => user.role === "supervisor" && !limitedDemo(user);

/**
 * lib/teams.ts teamScope: a supervisor sees their own id plus their CSRs'
 * ids; every other role gets null (no team filter, program-wide).
 */
function teamScope(user) {
  if (user.role !== "supervisor") return null;
  const ids = state.teamMembers
    .filter((m) => m.supervisorId === user.id && m.programId === user.programId)
    .map((m) => m.csrId)
    .sort();
  return [user.id, ...ids];
}

/** routes/admin/insights.ts isUserInScope: a null scope admits everyone. */
function isUserInScope(scope, userId) {
  if (scope === null) return true;
  const wanted = String(userId).toLowerCase();
  return scope.some((id) => id.toLowerCase() === wanted);
}

/**
 * Whose recommended list (kb_team_shortcuts) the viewer reads, as in
 * routes/kb.ts teamPinSql: a supervisor their own, a CSR their supervisor's
 * in this program, anyone else none.
 */
function teamListOwner(user, programId) {
  if (user.role === "supervisor") return user.id;
  if (user.role !== "csr") return null;
  return state.teamMembers.find((m) => m.csrId === user.id && m.programId === programId)?.supervisorId ?? null;
}

function visibleDocs(user, programId) {
  return state.documents.filter((d) => d.programId === programId && !d.retired && canSee(user, d));
}

function visibleDoc(user, programId, id) {
  const doc = visibleDocs(user, programId).find((d) => d.id === id);
  if (!doc) throw notFound();
  return doc;
}

const activeVersion = (doc) => doc.versions.find((v) => v.id === doc.activeVersionId);

function record(action, user, programId, detail) {
  audit.push({ at: iso(Date.now()), action, actor: user.email, programId, detail });
}

// ---------------------------------------------------------------------------
// Knowledge base reads

function userStateOf(user, docId) {
  return state.userState.get(`${user.id}:${docId}`) ?? null;
}

/** kb_category_user_prefs stand-in: the user's private category color, or null. */
function myCategoryColor(user, categoryId) {
  return state.categoryPrefs.get(`${user.id}:${categoryId}`)?.color ?? null;
}

function categoryOut(category, visibleIds, user) {
  const documentIds = state.categoryDocs
    .filter((m) => m.categoryId === category.id && visibleIds.has(m.documentId))
    .sort((a, b) => a.position - b.position)
    .map((m) => m.documentId);
  return {
    id: category.id,
    parentId: category.parentId,
    name: category.name,
    color: category.color,
    myColor: myCategoryColor(user, category.id),
    position: category.position,
    documentIds
  };
}

function programCategories(programId) {
  return state.categories
    .filter((c) => c.programId === programId)
    .sort((a, b) => a.position - b.position);
}

function kbList(user, req) {
  const programId = effectiveProgramId(user, req);
  if (!programId) {
    return {
      items: [],
      categories: [],
      tags: [],
      labels: colorLabelsOf(user),
      canOrganize: false,
      canPinForTeam: canPinForTeam(user),
      noProgramSelected: true
    };
  }
  const now = Date.now();
  const since30 = now - 30 * DAY;
  const docs = visibleDocs(user, programId);
  const visibleIds = new Set(docs.map((d) => d.id));
  const viewCounts = new Map();
  const myLastView = new Map();
  for (const view of state.views) {
    if (!visibleIds.has(view.documentId)) continue;
    const at = Date.parse(view.viewedAt);
    if (at >= since30) viewCounts.set(view.documentId, (viewCounts.get(view.documentId) ?? 0) + 1);
    if (view.userId === user.id && (myLastView.get(view.documentId) ?? 0) < at) {
      myLastView.set(view.documentId, at);
    }
  }
  const citationCounts = new Map();
  for (const row of state.queryLog) {
    if (row.programId !== programId || Date.parse(row.createdAt) < since30) continue;
    for (const docId of new Set(row.citations.map((c) => c.doc_id))) {
      citationCounts.set(docId, (citationCounts.get(docId) ?? 0) + 1);
    }
  }
  const featured = new Map(
    state.featured.filter((f) => f.programId === programId).map((f) => [f.documentId, f.position])
  );
  const teamOwner = teamListOwner(user, programId);
  const teamPins = new Map(
    state.teamShortcuts
      .filter((t) => teamOwner !== null && t.supervisorId === teamOwner && t.programId === programId)
      .map((t) => [t.documentId, t.position])
  );
  const items = docs
    .map((doc) => {
      const version = activeVersion(doc);
      const mine = userStateOf(user, doc.id);
      const freshest = Math.max(Date.parse(version.uploadedAt), Date.parse(doc.createdAt));
      return {
        documentId: doc.id,
        title: doc.title,
        updatedAt: version.uploadedAt,
        createdAt: doc.createdAt,
        isNew: now - freshest <= NEW_WINDOW_MS,
        viewCount: viewCounts.get(doc.id) ?? 0,
        citationCount: citationCounts.get(doc.id) ?? 0,
        lastViewedByMeAt: myLastView.has(doc.id) ? iso(myLastView.get(doc.id)) : null,
        pinnedAt: mine?.pinnedAt ?? null,
        note: mine?.note ?? null,
        noteUpdatedAt: mine?.noteUpdatedAt ?? null,
        myColor: mine?.color ?? null,
        featuredPosition: featured.has(doc.id) ? featured.get(doc.id) : null,
        teamPinPosition: teamPins.has(doc.id) ? teamPins.get(doc.id) : null,
        categoryIds: state.categoryDocs.filter((m) => m.documentId === doc.id).map((m) => m.categoryId),
        tagIds: state.docTags.filter((t) => t.documentId === doc.id).map((t) => t.tagId)
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  return {
    items,
    categories: programCategories(programId).map((c) => categoryOut(c, visibleIds, user)),
    tags: state.tags
      .filter((t) => t.programId === programId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name, color }) => ({ id, name, color })),
    labels: colorLabelsOf(user),
    canOrganize: canOrganize(user),
    canPinForTeam: canPinForTeam(user)
  };
}

function kbDocument(user, req, docId, url) {
  const programId = requireProgram(user, req);
  // A retired source stays readable through a citation receipt the user owns,
  // so look it up before the receipt check, not through visibleDoc.
  const doc = state.documents.find((d) => d.id === docId && d.programId === programId && canSee(user, d));
  if (!doc) throw notFound();
  const versionId = url.searchParams.get("version");
  const version = versionId ? doc.versions.find((v) => v.id === versionId) : activeVersion(doc);
  if (!version) throw notFound();
  let citationTarget = null;
  const queryId = url.searchParams.get("query");
  const sourceIndex = Number(url.searchParams.get("source"));
  if (queryId && Number.isInteger(sourceIndex)) {
    const row = state.queryLog.find((r) => r.id === queryId && r.userId === user.id);
    const source = row?.citations[sourceIndex];
    if (source && source.doc_id === doc.id && source.document_version_id === version.id) {
      citationTarget = {
        excerpt: source.excerpt,
        sourceStart: source.source_start,
        sourceEnd: source.source_end
      };
    }
  }
  if (doc.retired && citationTarget === null) throw notFound();
  const isCurrentVersion = version.id === doc.activeVersionId;
  const mine = userStateOf(user, doc.id);
  if (isCurrentVersion) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const recent = state.views.some(
      (v) => v.userId === user.id && v.documentId === doc.id && Date.parse(v.viewedAt) >= cutoff
    );
    if (!recent) {
      state.views.push({
        userId: user.id,
        documentId: doc.id,
        viewedAt: iso(Date.now()),
        via: citationTarget ? "citation" : "browse"
      });
    }
  }
  return {
    documentId: doc.id,
    documentVersionId: version.id,
    versionNumber: version.versionNumber,
    isCurrentVersion,
    title: doc.title,
    markdown: version.markdown,
    updatedAt: version.uploadedAt,
    citationAuthorized: citationTarget !== null,
    citationTarget,
    pinnedAt: mine?.pinnedAt ?? null,
    note: mine?.note ?? null,
    noteUpdatedAt: mine?.noteUpdatedAt ?? null,
    myColor: mine?.color ?? null
  };
}

// ---------------------------------------------------------------------------
// Personal pins, notes, colors and highlights

function userStateResponse(user, docId) {
  const mine = userStateOf(user, docId);
  return {
    documentId: docId,
    pinnedAt: mine?.pinnedAt ?? null,
    note: mine?.note ?? null,
    noteUpdatedAt: mine?.noteUpdatedAt ?? null,
    color: mine?.color ?? null
  };
}

/** kb_source_user_state stand-in: the row lives while a pin, note or color is set. */
function writeUserState(user, docId, patch) {
  const key = `${user.id}:${docId}`;
  const next = {
    pinnedAt: null,
    note: null,
    noteUpdatedAt: null,
    color: null,
    ...state.userState.get(key),
    ...patch
  };
  if (next.pinnedAt === null && next.note === null && next.color === null) state.userState.delete(key);
  else state.userState.set(key, next);
  return userStateResponse(user, docId);
}

/** { color } body for both color endpoints: a palette color, or null to clear. */
function personalColorBody(body) {
  strictBody(body, ["color"]);
  if (body.color === null) return null;
  if (body.color === undefined) throw badRequest("color is required (use null to clear it).");
  return colorField(body.color);
}

/** kb_user_color_labels stand-in: the user's named colors, in palette order. */
function colorLabelsOf(user) {
  return COLORS.filter((color) => state.colorLabels.has(`${user.id}:${color}`)).map((color) => ({
    color,
    name: state.colorLabels.get(`${user.id}:${color}`).name
  }));
}

/** Name one of your colors, or clear the name with null or blank text. Every role, demo included. */
function setColorLabel(user, color, body) {
  if (!COLORS.includes(color)) throw badRequest("Pick one of the listed colors.");
  strictBody(body, ["name"]);
  if (body.name === undefined) throw badRequest("name is required (use null to clear it).");
  if (body.name !== null && typeof body.name !== "string") throw badRequest("name must be text or null.");
  const name = body.name === null ? "" : body.name.trim();
  const key = `${user.id}:${color}`;
  if (name === "") {
    state.colorLabels.delete(key);
    return { item: null };
  }
  if (name.length > 40) throw badRequest("Color names must be 1 to 40 characters.");
  state.colorLabels.set(key, { name, updatedAt: iso(Date.now()) });
  return { item: { color, name } };
}

/** Delete one of your labels everywhere: off every source that has it, in every program, then its name. */
function deleteColorLabel(user, color) {
  if (!COLORS.includes(color)) throw badRequest("Pick one of the listed colors.");
  let cleared = 0;
  for (const [key, value] of state.userState) {
    if (!key.startsWith(`${user.id}:`) || value.color !== color) continue;
    cleared += 1;
    const next = { ...value, color: null };
    if (next.pinnedAt === null && next.note === null) state.userState.delete(key);
    else state.userState.set(key, next);
  }
  state.colorLabels.delete(`${user.id}:${color}`);
  return { cleared };
}

function setSourceColor(user, req, docId, body) {
  const programId = requireProgram(user, req);
  const doc = visibleDoc(user, programId, docId);
  const color = personalColorBody(body);
  return { item: writeUserState(user, doc.id, { color }) };
}

function setCategoryColor(user, req, categoryId, body) {
  const programId = requireProgram(user, req);
  const category = state.categories.find((c) => c.id === categoryId && c.programId === programId);
  if (!category) throw notFound();
  const color = personalColorBody(body);
  const key = `${user.id}:${category.id}`;
  if (color === null) state.categoryPrefs.delete(key);
  else state.categoryPrefs.set(key, { color, updatedAt: iso(Date.now()) });
  return { item: { categoryId: category.id, myColor: color } };
}

function setPin(user, req, docId, body) {
  const programId = requireProgram(user, req);
  const doc = visibleDoc(user, programId, docId);
  strictBody(body, ["pinned"]);
  if (typeof body.pinned !== "boolean") throw badRequest("pinned must be true or false.");
  const existing = userStateOf(user, doc.id);
  const pinnedAt = body.pinned ? existing?.pinnedAt ?? iso(Date.now()) : null;
  return { item: writeUserState(user, doc.id, { pinnedAt }) };
}

function setNote(user, req, docId, body) {
  const programId = requireProgram(user, req);
  const doc = visibleDoc(user, programId, docId);
  strictBody(body, ["note"]);
  if (typeof body.note !== "string") throw badRequest("note must be text.");
  if (body.note.length > 4000) throw badRequest("Notes can be at most 4000 characters.");
  const note = body.note.trim() || null;
  return {
    item: writeUserState(user, doc.id, { note, noteUpdatedAt: note ? iso(Date.now()) : null })
  };
}

function highlightOut(h) {
  const { id, highlightedText, startOffset, endOffset, color, createdAt, updatedAt } = h;
  return { id, highlightedText, startOffset, endOffset, color, createdAt, updatedAt };
}

function listHighlights(user, req, docId) {
  const programId = requireProgram(user, req);
  const doc = visibleDoc(user, programId, docId);
  return {
    items: state.highlights
      .filter((h) => h.userId === user.id && h.documentVersionId === doc.activeVersionId)
      .sort((a, b) => a.startOffset - b.startOffset)
      .map(highlightOut),
    documentVersionId: doc.activeVersionId,
    canWriteHighlights: true
  };
}

function createHighlight(user, req, docId, body) {
  const programId = requireProgram(user, req);
  const doc = visibleDoc(user, programId, docId);
  strictBody(body, ["documentVersionId", "highlightedText", "startOffset", "endOffset", "color"]);
  if (body.documentVersionId !== doc.activeVersionId) {
    throw new HttpError(409, "This document changed. Reload to highlight the current version.");
  }
  if (
    !Number.isInteger(body.startOffset) ||
    !Number.isInteger(body.endOffset) ||
    body.endOffset <= body.startOffset ||
    !["yellow", "green", "blue"].includes(body.color)
  ) {
    throw badRequest("Invalid highlight.");
  }
  const now = iso(Date.now());
  const item = {
    id: nextId(),
    userId: user.id,
    documentVersionId: doc.activeVersionId,
    highlightedText: String(body.highlightedText ?? ""),
    startOffset: body.startOffset,
    endOffset: body.endOffset,
    color: body.color,
    createdAt: now,
    updatedAt: now
  };
  state.highlights.push(item);
  return { item: highlightOut(item) };
}

// ---------------------------------------------------------------------------
// Library organization (manager+, not demo)

function requireOrganizer(user, req) {
  requireRole(user, "manager");
  if (limitedDemo(user)) throw new HttpError(403, DEMO_MESSAGE);
  return requireProgram(user, req);
}

function findCategory(programId, id) {
  const category = state.categories.find((c) => c.id === id && c.programId === programId);
  if (!category) throw notFound();
  return category;
}

function categoryDepth(category) {
  let depth = 1;
  let parentId = category.parentId;
  while (parentId) {
    depth += 1;
    parentId = state.categories.find((c) => c.id === parentId)?.parentId ?? null;
  }
  return depth;
}

function subtreeHeight(category) {
  const children = state.categories.filter((c) => c.parentId === category.id);
  return 1 + Math.max(0, ...children.map(subtreeHeight));
}

function isDescendant(candidateId, ancestorId) {
  let current = state.categories.find((c) => c.id === candidateId);
  while (current) {
    if (current.id === ancestorId) return true;
    current = current.parentId ? state.categories.find((c) => c.id === current.parentId) : null;
  }
  return false;
}

function siblings(programId, parentId) {
  return state.categories
    .filter((c) => c.programId === programId && c.parentId === parentId)
    .sort((a, b) => a.position - b.position);
}

function assertUniqueSiblingName(programId, parentId, name, exceptId) {
  const clash = siblings(programId, parentId).some(
    (c) => c.id !== exceptId && c.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (clash) throw new HttpError(409, "A category with that name already exists here.");
}

function nextSiblingPosition(programId, parentId, exceptId) {
  const list = siblings(programId, parentId).filter((c) => c.id !== exceptId);
  return list.length === 0 ? 0 : Math.max(...list.map((c) => c.position)) + 1;
}

function visibleIdSet(user, programId) {
  return new Set(visibleDocs(user, programId).map((d) => d.id));
}

function createCategory(user, req, body) {
  const programId = requireOrganizer(user, req);
  strictBody(body, ["name", "parentId", "color"]);
  const name = nameField(body.name, 80, "Category");
  const color = colorField(body.color) ?? "slate";
  const parentId = body.parentId ?? null;
  if (parentId !== null) {
    const parent = findCategory(programId, parentId);
    if (categoryDepth(parent) + 1 > 4) throw new HttpError(409, "Categories can nest at most 4 levels.");
  }
  assertUniqueSiblingName(programId, parentId, name, null);
  const category = {
    id: nextId(),
    programId,
    parentId,
    name,
    color,
    position: nextSiblingPosition(programId, parentId, null)
  };
  state.categories.push(category);
  record("kb.library.category.create", user, programId, { id: category.id, name });
  return categoryOut(category, visibleIdSet(user, programId), user);
}

function updateCategory(user, req, id, body) {
  const programId = requireOrganizer(user, req);
  const category = findCategory(programId, id);
  strictBody(body, ["name", "color", "parentId"]);
  if (Object.keys(body).length === 0) throw badRequest("Nothing to update.");
  const name = body.name === undefined ? category.name : nameField(body.name, 80, "Category");
  const color = colorField(body.color) ?? category.color;
  let parentId = category.parentId;
  if (body.parentId !== undefined) {
    parentId = body.parentId;
    if (parentId !== null) {
      const parent = findCategory(programId, parentId);
      if (parent.id === category.id || isDescendant(parent.id, category.id)) {
        throw new HttpError(409, "A category can't be moved inside itself.");
      }
      if (categoryDepth(parent) + subtreeHeight(category) > 4) {
        throw new HttpError(409, "Categories can nest at most 4 levels.");
      }
    }
  }
  assertUniqueSiblingName(programId, parentId, name, category.id);
  if (parentId !== category.parentId) {
    category.position = nextSiblingPosition(programId, parentId, category.id);
    category.parentId = parentId;
  }
  category.name = name;
  category.color = color;
  record("kb.library.category.update", user, programId, { id, body });
  return categoryOut(category, visibleIdSet(user, programId), user);
}

function deleteCategory(user, req, id) {
  const programId = requireOrganizer(user, req);
  const category = findCategory(programId, id);
  let position = nextSiblingPosition(programId, category.parentId, category.id);
  for (const child of siblings(programId, category.id)) {
    child.parentId = category.parentId;
    child.position = position;
    position += 1;
  }
  state.categoryDocs = state.categoryDocs.filter((m) => m.categoryId !== id);
  // kb_category_user_prefs rows cascade with the category.
  for (const key of [...state.categoryPrefs.keys()]) {
    if (key.endsWith(`:${id}`)) state.categoryPrefs.delete(key);
  }
  state.categories = state.categories.filter((c) => c.id !== id);
  record("kb.library.category.delete", user, programId, { id, name: category.name });
  return { ok: true };
}

function reorderCategories(user, req, body) {
  const programId = requireOrganizer(user, req);
  strictBody(body, ["parentId", "orderedIds"]);
  const parentId = body.parentId ?? null;
  if (parentId !== null) findCategory(programId, parentId);
  const orderedIds = idList(body.orderedIds, "orderedIds", 500);
  const current = siblings(programId, parentId);
  const currentIds = new Set(current.map((c) => c.id));
  if (orderedIds.length !== current.length || orderedIds.some((cid) => !currentIds.has(cid))) {
    throw badRequest("The order must list every category at that level exactly once.");
  }
  orderedIds.forEach((cid, index) => {
    state.categories.find((c) => c.id === cid).position = index;
  });
  record("kb.library.category.reorder", user, programId, { parentId, orderedIds });
  return { ok: true };
}

function setCategoryDocuments(user, req, id, body) {
  const programId = requireOrganizer(user, req);
  const category = findCategory(programId, id);
  strictBody(body, ["documentIds"]);
  const documentIds = idList(body.documentIds, "documentIds", 500);
  const visible = visibleIdSet(user, programId);
  if (documentIds.some((docId) => !visible.has(docId))) throw notFound();
  // Memberships of documents this user cannot see are kept, after the new order.
  const hidden = state.categoryDocs
    .filter((m) => m.categoryId === id && !visible.has(m.documentId))
    .sort((a, b) => a.position - b.position);
  state.categoryDocs = state.categoryDocs.filter((m) => m.categoryId !== id);
  documentIds.forEach((documentId, position) =>
    state.categoryDocs.push({ categoryId: id, documentId, position })
  );
  hidden.forEach((m, index) =>
    state.categoryDocs.push({ ...m, position: documentIds.length + index })
  );
  record("kb.library.category.members", user, programId, { id, documentIds });
  return categoryOut(category, visible, user);
}

function setDocumentCategories(user, req, docId, body) {
  const programId = requireOrganizer(user, req);
  const doc = visibleDoc(user, programId, docId);
  strictBody(body, ["categoryIds"]);
  const categoryIds = idList(body.categoryIds, "categoryIds", 50);
  for (const cid of categoryIds) findCategory(programId, cid);
  const wanted = new Set(categoryIds);
  state.categoryDocs = state.categoryDocs.filter(
    (m) => m.documentId !== doc.id || wanted.has(m.categoryId)
  );
  for (const cid of categoryIds) {
    if (state.categoryDocs.some((m) => m.documentId === doc.id && m.categoryId === cid)) continue;
    const positions = state.categoryDocs.filter((m) => m.categoryId === cid).map((m) => m.position);
    state.categoryDocs.push({
      categoryId: cid,
      documentId: doc.id,
      position: positions.length === 0 ? 0 : Math.max(...positions) + 1
    });
  }
  record("kb.library.document.categories", user, programId, { documentId: doc.id, categoryIds });
  return { ok: true };
}

function findTag(programId, id) {
  const tag = state.tags.find((t) => t.id === id && t.programId === programId);
  if (!tag) throw notFound();
  return tag;
}

function assertUniqueTagName(programId, name, exceptId) {
  const clash = state.tags.some(
    (t) => t.programId === programId && t.id !== exceptId && t.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (clash) throw new HttpError(409, "A tag with that name already exists.");
}

const tagOut = ({ id, name, color }) => ({ id, name, color });

function createTag(user, req, body) {
  const programId = requireOrganizer(user, req);
  strictBody(body, ["name", "color"]);
  const name = nameField(body.name, 40, "Tag");
  const color = colorField(body.color) ?? "slate";
  assertUniqueTagName(programId, name, null);
  const tag = { id: nextId(), programId, name, color };
  state.tags.push(tag);
  record("kb.library.tag.create", user, programId, { id: tag.id, name });
  return tagOut(tag);
}

function updateTag(user, req, id, body) {
  const programId = requireOrganizer(user, req);
  const tag = findTag(programId, id);
  strictBody(body, ["name", "color"]);
  if (Object.keys(body).length === 0) throw badRequest("Nothing to update.");
  const name = body.name === undefined ? tag.name : nameField(body.name, 40, "Tag");
  assertUniqueTagName(programId, name, tag.id);
  tag.name = name;
  tag.color = colorField(body.color) ?? tag.color;
  record("kb.library.tag.update", user, programId, { id, body });
  return tagOut(tag);
}

function deleteTag(user, req, id) {
  const programId = requireOrganizer(user, req);
  const tag = findTag(programId, id);
  state.docTags = state.docTags.filter((t) => t.tagId !== id);
  state.tags = state.tags.filter((t) => t.id !== id);
  record("kb.library.tag.delete", user, programId, { id, name: tag.name });
  return { ok: true };
}

function setDocumentTags(user, req, docId, body) {
  const programId = requireOrganizer(user, req);
  const doc = visibleDoc(user, programId, docId);
  strictBody(body, ["tagIds"]);
  const tagIds = idList(body.tagIds, "tagIds", 30);
  for (const tid of tagIds) findTag(programId, tid);
  state.docTags = state.docTags.filter((t) => t.documentId !== doc.id);
  for (const tagId of tagIds) state.docTags.push({ documentId: doc.id, tagId });
  record("kb.library.document.tags", user, programId, { documentId: doc.id, tagIds });
  return { ok: true };
}

function setFeatured(user, req, body) {
  const programId = requireOrganizer(user, req);
  strictBody(body, ["documentIds"]);
  const documentIds = idList(body.documentIds, "documentIds", 500);
  const visible = visibleIdSet(user, programId);
  if (documentIds.some((docId) => !visible.has(docId))) throw notFound();
  // Team pins on documents this user cannot see (clearance or not live) are
  // kept, after the new order. The cap counts them, like the server's
  // post-write check that rolls back.
  const hidden = state.featured
    .filter((f) => f.programId === programId && !visible.has(f.documentId))
    .sort((a, b) => a.position - b.position);
  if (documentIds.length + hidden.length > 12) throw badRequest("Team pins are limited to 12.");
  state.featured = state.featured.filter((f) => f.programId !== programId);
  documentIds.forEach((documentId, position) => state.featured.push({ programId, documentId, position }));
  hidden.forEach((f, index) => state.featured.push({ ...f, position: documentIds.length + index }));
  record("kb.library.featured.set", user, programId, { documentIds });
  return { ok: true };
}

/**
 * PUT /api/kb/library/team-shortcuts: replaces the acting supervisor's own
 * list, like /featured replaces the program's. Supervisors only (403 for
 * every other role, before the demo block), never demo accounts. Other
 * supervisors' rows are never touched; the actor's rows for sources they
 * can't see right now are kept and count toward the cap.
 */
function setTeamShortcuts(user, req, body) {
  if (user.role !== "supervisor") throw new HttpError(403, TEAM_PINNER_MESSAGE);
  if (limitedDemo(user)) throw new HttpError(403, DEMO_MESSAGE);
  const programId = requireProgram(user, req);
  strictBody(body, ["documentIds"]);
  // featuredSchema (uniqueIdList): uuids, at most 12, no repeats in any case,
  // lowercased, before the stored-row cap below.
  const raw = body.documentIds;
  if (!Array.isArray(raw)) throw badRequest("Send a list of ids.");
  if (raw.some((id) => typeof id !== "string" || !UUID_RE.test(id))) throw badRequest("Invalid uuid");
  if (raw.length > MAX_FEATURED) {
    throw badRequest(`You can pin at most ${MAX_FEATURED} sources for the team.`);
  }
  const documentIds = raw.map((id) => id.toLowerCase());
  if (new Set(documentIds).size !== documentIds.length) {
    throw badRequest("The list has the same item more than once.");
  }
  const visible = visibleIdSet(user, programId);
  if (documentIds.some((docId) => !visible.has(docId))) throw notFound();
  const mine = (t) => t.supervisorId === user.id && t.programId === programId;
  const hidden = state.teamShortcuts
    .filter((t) => mine(t) && !visible.has(t.documentId))
    .sort((a, b) => a.position - b.position);
  if (documentIds.length + hidden.length > MAX_FEATURED) {
    throw badRequest(`Team pins are limited to ${MAX_FEATURED}.`);
  }
  state.teamShortcuts = state.teamShortcuts.filter((t) => !mine(t));
  documentIds.forEach((documentId, position) =>
    state.teamShortcuts.push({ supervisorId: user.id, programId, documentId, position })
  );
  hidden.forEach((t, index) => state.teamShortcuts.push({ ...t, position: documentIds.length + index }));
  record("kb.library.team_shortcuts.set", user, programId, { documentIds });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Teams (routes/admin/teams.ts): supervisor and above read, manager+ writes

/** Active supervisors in the program, or just `onlyId` when given. */
function listSupervisors(programId, onlyId) {
  return state.users
    .filter(
      (u) =>
        u.programId === programId &&
        u.role === "supervisor" &&
        u.isActive &&
        (onlyId === null || u.id === onlyId)
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map(({ id, name, email }) => ({ id, name, email }));
}

/**
 * Active CSRs in the program with their supervisor. `supervisorId` is null
 * unless the row points at an active supervisor in the same program, so the
 * list never names someone the supervisor list leaves out.
 */
function listCsrs(programId, onlySupervisorId) {
  return state.users
    .filter((u) => u.programId === programId && u.role === "csr" && u.isActive)
    .map((u) => {
      const row = state.teamMembers.find((m) => m.csrId === u.id && m.programId === programId);
      const lead = row && state.users.find((s) => s.id === row.supervisorId);
      const supervisorId =
        lead && lead.role === "supervisor" && lead.isActive && lead.programId === programId ? lead.id : null;
      return { id: u.id, name: u.name, email: u.email, lastLoginAt: u.lastLoginAt, supervisorId };
    })
    .filter((c) => onlySupervisorId === null || c.supervisorId === onlySupervisorId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function teamsList(user, req) {
  requireRole(user, "supervisor");
  const programId = requireProgram(user, req);
  // Only the supervisor tier is narrowed to its own team.
  const ownTeam = user.role === "supervisor" ? user.id : null;
  return {
    supervisors: listSupervisors(programId, ownTeam),
    csrs: listCsrs(programId, ownTeam),
    canEdit: ownTeam === null
  };
}

/** lib/teams.ts assignmentBodySchema: csrIds 1..200 uuids (deduped, lower case), supervisorId uuid or null. */
function assignmentBody(body) {
  strictBody(body, ["csrIds", "supervisorId"]);
  const { csrIds, supervisorId } = body;
  if (csrIds === undefined) throw badRequest("Pick at least one CSR.");
  if (!Array.isArray(csrIds)) throw badRequest("Send a list of ids.");
  if (csrIds.length < 1) throw badRequest("Pick at least one CSR.");
  if (csrIds.length > MAX_TEAM_ASSIGNMENT) {
    throw badRequest(`Move at most ${MAX_TEAM_ASSIGNMENT} CSRs at a time.`);
  }
  if (csrIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) throw badRequest("Invalid uuid");
  if (supervisorId !== null && (typeof supervisorId !== "string" || !UUID_RE.test(supervisorId))) {
    throw badRequest("Invalid uuid");
  }
  return {
    csrIds: [...new Set(csrIds.map((id) => id.toLowerCase()))],
    supervisorId: supervisorId === null ? null : supervisorId.toLowerCase()
  };
}

function assignTeam(user, req, body) {
  requireRole(user, "manager");
  if (limitedDemo(user)) throw new HttpError(403, DEMO_MESSAGE);
  const programId = requireProgram(user, req);
  const { csrIds, supervisorId } = assignmentBody(body);
  const activeIn = (id, role) =>
    state.users.some((u) => u.id === id && u.role === role && u.isActive && u.programId === programId);
  if (!csrIds.every((id) => activeIn(id, "csr"))) {
    throw badRequest("One or more people are not active CSRs in this program.");
  }
  if (supervisorId !== null && !activeIn(supervisorId, "supervisor")) {
    throw badRequest("Choose an active supervisor in this program.");
  }
  const previousSupervisorIds = Object.fromEntries(
    csrIds.map((id) => [id, state.teamMembers.find((m) => m.csrId === id)?.supervisorId ?? null])
  );
  state.teamMembers = state.teamMembers.filter((m) => !csrIds.includes(m.csrId));
  if (supervisorId !== null) {
    for (const csrId of csrIds) state.teamMembers.push({ csrId, supervisorId, programId });
  }
  record("team.assign", user, programId, { count: csrIds.length, supervisorId, csrIds, previousSupervisorIds });
  return { csrs: listCsrs(programId, null) };
}

// ---------------------------------------------------------------------------
// Ask examples (routes/ask-examples.ts): everyone reads, manager+ replaces

function askExamples(user, req) {
  const programId = requireProgram(user, req);
  const stored = state.askExamples.get(programId);
  return stored ? { questions: [...stored], custom: true } : { questions: [...DEFAULT_ASK_EXAMPLES], custom: false };
}

/** Replace the list. An empty list goes back to the defaults. */
function setAskExamples(user, req, body) {
  requireRole(user, "manager");
  if (limitedDemo(user)) throw new HttpError(403, DEMO_MESSAGE);
  const programId = requireProgram(user, req);
  const questions = body?.questions;
  const valid =
    Array.isArray(questions) &&
    questions.length <= ASK_EXAMPLES_MAX &&
    questions.every(
      (q) => typeof q === "string" && q.trim().length >= 1 && q.trim().length <= ASK_EXAMPLE_MAX_LENGTH
    );
  if (!valid) {
    throw badRequest(
      `Send up to ${ASK_EXAMPLES_MAX} questions, each 1 to ${ASK_EXAMPLE_MAX_LENGTH} characters.`
    );
  }
  // Drop repeats (case-insensitive), keeping the first spelling and order.
  const seen = new Set();
  const kept = questions
    .map((q) => q.trim())
    .filter((q) => {
      const key = q.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (kept.length === 0) state.askExamples.delete(programId);
  else state.askExamples.set(programId, kept);
  record("ask.examples.set", user, programId, { count: kept.length, reset: kept.length === 0 });
  return askExamples(user, req);
}

// ---------------------------------------------------------------------------
// Analytics (manager+)

/**
 * Question rows in the window, optionally one asker. `scope` is teamScope():
 * for a supervisor only their team's rows (rows with no asker drop out, as
 * NULL = ANY(...) does in SQL); null keeps the whole program.
 */
function windowRows(programId, days, userId, scope = null) {
  const since = Date.now() - days * DAY;
  return state.queryLog.filter(
    (r) =>
      r.programId === programId &&
      Date.parse(r.createdAt) >= since &&
      (userId === null || r.userId === userId) &&
      (scope === null || (r.userId !== null && isUserInScope(scope, r.userId)))
  );
}

/** A person in the program and, for a supervisor, on their team; anyone else is a 404. */
function programUser(programId, id, scope = null) {
  const user = state.users.find((u) => u.id === id && u.programId === programId);
  if (!user || !isUserInScope(scope, id)) throw notFound();
  return user;
}

function titleFor(viewer, docId) {
  const doc = state.documents.find((d) => d.id === docId);
  return doc && canSee(viewer, doc) ? doc.title : null;
}

const answered = (row) => !row.refused && row.citations.length > 0;

/** Top-level categories a document sits under, through any of its categories. */
function topCategoryIds(docId) {
  const out = new Set();
  for (const m of state.categoryDocs) {
    if (m.documentId !== docId) continue;
    let category = state.categories.find((c) => c.id === m.categoryId);
    while (category?.parentId) category = state.categories.find((c) => c.id === category.parentId);
    if (category) out.add(category.id);
  }
  return out;
}

/** A fallback suggestion needs at least this many team answers in the window. */
const TEAM_TOP_MIN_CITATIONS = 3;

/**
 * Up to 3 live sources teammates cited in the window that this person can open
 * and never cited. Same rule as the backend (insights.ts suggestionsQuery and
 * source-usage.ts selectSourceSuggestions):
 * topics = top-level categories of the sources cited on this person's refused
 * or thumbs-down answers, plus those of the sources cited by anyone else's
 * non-refused answer to the same question (normalizeQuestion) as one of this
 * person's refused answers. Candidates = sources other named people cited,
 * minus the person's own, retired ones, and ones the person's or the viewer's
 * clearance hides. "related" (top-level category is a topic) when any exist,
 * else "team_top" (at least TEAM_TOP_MIN_CITATIONS team answers). Never
 * mixed. Ties: team citations desc, latest team citation desc, document id.
 */
function suggestionsFor(viewer, person, allRows) {
  const mine = allRows.filter((r) => r.userId === person.id);
  const others = allRows.filter((r) => r.userId !== null && r.userId !== person.id);
  const citedByMe = new Set(mine.flatMap(rowDocIds));
  const topics = new Set();
  const addTopics = (row) =>
    rowDocIds(row).forEach((docId) => topCategoryIds(docId).forEach((id) => topics.add(id)));
  for (const row of mine) {
    if (row.refused || row.feedback === -1) addTopics(row);
  }
  // A refused answer cites nothing, so its topic comes from the sources behind
  // other people's answers to the same question (unnamed askers included, as
  // in the backend's IS DISTINCT FROM join).
  const refusedQuestions = new Set(mine.filter((r) => r.refused).map((r) => normalizeQuestion(r.question)));
  for (const row of allRows) {
    if (row.userId === person.id || row.refused) continue;
    if (refusedQuestions.has(normalizeQuestion(row.question))) addTopics(row);
  }
  const team = new Map();
  for (const row of others) {
    for (const docId of rowDocIds(row)) {
      const entry = team.get(docId) ?? { count: 0, last: "" };
      entry.count += 1;
      if (row.createdAt > entry.last) entry.last = row.createdAt;
      team.set(docId, entry);
    }
  }
  const candidates = [...team.entries()]
    .filter(([docId]) => {
      const doc = state.documents.find((d) => d.id === docId);
      return !citedByMe.has(docId) && doc && !doc.retired && canSee(person, doc) && titleFor(viewer, docId) !== null;
    })
    .map(([documentId, e]) => ({
      documentId,
      title: titleFor(viewer, documentId),
      teamCitations: e.count,
      lastCitedAt: e.last
    }))
    .sort(
      (a, b) =>
        b.teamCitations - a.teamCitations ||
        b.lastCitedAt.localeCompare(a.lastCitedAt) ||
        a.documentId.localeCompare(b.documentId)
    );
  const related = candidates.filter((c) => [...topCategoryIds(c.documentId)].some((id) => topics.has(id)));
  const reason = related.length > 0 ? "related" : "team_top";
  const pool = related.length > 0 ? related : candidates.filter((c) => c.teamCitations >= TEAM_TOP_MIN_CITATIONS);
  return pool
    .slice(0, 3)
    .map((c) => ({ documentId: c.documentId, title: c.title, reason, teamCitations: c.teamCitations }));
}
const rowDocIds = (row) => [...new Set(row.citations.map((c) => c.doc_id))];

function sourceUsage(user, req, url) {
  requireRole(user, "supervisor");
  const scope = teamScope(user);
  const days = windowDays(url);
  const programId = effectiveProgramId(user, req);
  const userId = url.searchParams.get("userId") || null;
  const empty = {
    windowDays: days,
    suggestions: [],
    userId,
    person: null,
    people: [],
    matrix: { documentIds: [], rows: [] },
    totals: { questions: 0, answered: 0, refused: 0, sourcesCited: 0, sourcesNeverCited: 0, activeUsers: 0 },
    sources: [],
    users: []
  };
  if (!programId) return { ...empty, noProgramSelected: true };
  const selected = userId ? programUser(programId, userId, scope) : null;
  const person = selected
    ? { userId: selected.id, name: selected.name, email: selected.email, role: selected.role }
    : null;
  const rows = windowRows(programId, days, userId, scope);
  const allRows = userId ? windowRows(programId, days, null, scope) : rows;
  const since = Date.now() - days * DAY;

  // Person picker: every active csr and above in the program (a supervisor's
  // team only), 0 questions allowed.
  const questionsBy = new Map();
  for (const row of allRows) {
    if (row.userId) questionsBy.set(row.userId, (questionsBy.get(row.userId) ?? 0) + 1);
  }
  const people = state.users
    .filter(
      (u) =>
        u.isActive &&
        u.programId === programId &&
        ["csr", "supervisor", "manager", "senior_manager"].includes(u.role) &&
        isUserInScope(scope, u.id)
    )
    .map((u) => ({ userId: u.id, name: u.name, role: u.role, questionCount: questionsBy.get(u.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // People x sources for everyone in the window, whatever the userId filter.
  const citationsBy = new Map();
  for (const row of allRows) {
    for (const docId of rowDocIds(row)) citationsBy.set(docId, (citationsBy.get(docId) ?? 0) + 1);
  }
  const matrixDocIds = [...citationsBy.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([docId]) => docId);
  const matrixRows = [...questionsBy.entries()]
    .map(([id, count]) => ({ id, count, name: state.users.find((u) => u.id === id)?.name ?? "Unknown user" }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map(({ id }) => {
      const counts = matrixDocIds.map(() => 0);
      for (const row of allRows) {
        if (row.userId !== id) continue;
        const cited = rowDocIds(row);
        matrixDocIds.forEach((docId, i) => {
          if (cited.includes(docId)) counts[i] += 1;
        });
      }
      return { userId: id, counts };
    });
  const matrix = { documentIds: matrixDocIds, rows: matrixRows };

  const bySource = new Map();
  for (const row of rows) {
    for (const docId of rowDocIds(row)) {
      const entry = bySource.get(docId) ?? {
        citationCount: 0,
        questions: new Set(),
        users: new Set(),
        negativeCount: 0,
        lastCitedAt: null
      };
      entry.citationCount += 1;
      entry.questions.add(normalizeQuestion(row.question));
      if (row.userId) entry.users.add(row.userId);
      if (row.feedback === -1) entry.negativeCount += 1;
      if (!entry.lastCitedAt || entry.lastCitedAt < row.createdAt) entry.lastCitedAt = row.createdAt;
      bySource.set(docId, entry);
    }
  }
  const viewCounts = new Map();
  for (const view of state.views) {
    if (Date.parse(view.viewedAt) < since) continue;
    if (userId && view.userId !== userId) continue;
    if (!isUserInScope(scope, view.userId)) continue;
    viewCounts.set(view.documentId, (viewCounts.get(view.documentId) ?? 0) + 1);
  }
  const sources = [...bySource.entries()]
    .map(([documentId, e]) => {
      const doc = state.documents.find((d) => d.id === documentId);
      return {
        documentId,
        title: titleFor(user, documentId),
        isLive: Boolean(doc && !doc.retired),
        citationCount: e.citationCount,
        questionCount: e.questions.size,
        userCount: e.users.size,
        viewCount: viewCounts.get(documentId) ?? 0,
        negativeCount: e.negativeCount,
        lastCitedAt: e.lastCitedAt
      };
    })
    .sort(
      (a, b) =>
        b.citationCount - a.citationCount || (b.lastCitedAt ?? "").localeCompare(a.lastCitedAt ?? "")
    )
    .slice(0, 100);

  const byUser = new Map();
  for (const row of rows) {
    if (!row.userId) continue;
    const entry = byUser.get(row.userId) ?? {
      questionCount: 0,
      answeredCount: 0,
      refusedCount: 0,
      negativeCount: 0,
      docs: new Map(),
      lastAskedAt: null
    };
    entry.questionCount += 1;
    if (answered(row)) entry.answeredCount += 1;
    if (row.refused) entry.refusedCount += 1;
    if (row.feedback === -1) entry.negativeCount += 1;
    for (const docId of rowDocIds(row)) entry.docs.set(docId, (entry.docs.get(docId) ?? 0) + 1);
    if (!entry.lastAskedAt || entry.lastAskedAt < row.createdAt) entry.lastAskedAt = row.createdAt;
    byUser.set(row.userId, entry);
  }
  const users = [...byUser.entries()]
    .map(([id, e]) => {
      const person = state.users.find((u) => u.id === id);
      return {
        userId: id,
        name: person?.name ?? "Unknown user",
        email: person?.email ?? "",
        role: person?.role ?? "csr",
        questionCount: e.questionCount,
        answeredCount: e.answeredCount,
        refusedCount: e.refusedCount,
        negativeCount: e.negativeCount,
        topSources: [...e.docs.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([documentId, count]) => ({ documentId, title: titleFor(user, documentId), count })),
        lastAskedAt: e.lastAskedAt
      };
    })
    .sort((a, b) => b.questionCount - a.questionCount || a.name.localeCompare(b.name));

  const sourcesNeverCited = visibleDocs(user, programId).filter((d) => !bySource.has(d.id)).length;
  return {
    windowDays: days,
    suggestions: selected ? suggestionsFor(user, selected, allRows) : [],
    userId,
    person,
    people,
    matrix,
    totals: {
      questions: rows.length,
      answered: rows.filter(answered).length,
      refused: rows.filter((r) => r.refused).length,
      sourcesCited: bySource.size,
      sourcesNeverCited,
      activeUsers: new Set(rows.map((r) => r.userId).filter(Boolean)).size
    },
    sources,
    users
  };
}

function sourceUsageQuestions(user, req, url) {
  requireRole(user, "supervisor");
  const scope = teamScope(user);
  const days = windowDays(url);
  const programId = effectiveProgramId(user, req);
  if (!programId) return { items: [], truncated: false };
  const userId = url.searchParams.get("userId") || null;
  const documentId = url.searchParams.get("documentId") || null;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequest("limit must be a whole number from 1 to 200.");
  }
  if (userId) programUser(programId, userId, scope);
  // Same gating that nulls titles: a source the viewer cannot see is a 404
  // here, so its questions never leak through the drill-down.
  if (
    documentId &&
    !state.documents.some((d) => d.id === documentId && d.programId === programId && canSee(user, d))
  ) {
    throw notFound();
  }
  const wanted = documentId?.toLowerCase() ?? null;
  const rows = windowRows(programId, days, userId, scope)
    .filter((r) => !wanted || r.citations.some((c) => String(c.doc_id).toLowerCase() === wanted))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    items: rows.slice(0, limit).map((row) => ({
      queryLogId: row.id,
      question: row.question,
      askedAt: row.createdAt,
      userId: row.userId,
      userName: state.users.find((u) => u.id === row.userId)?.name ?? null,
      refused: row.refused,
      feedback: row.feedback === 0 ? null : row.feedback,
      sources: rowDocIds(row).map((docId) => ({ documentId: docId, title: titleFor(user, docId) }))
    })),
    truncated: rows.length > limit
  };
}

function kbGaps(user, req, url) {
  requireRole(user, "supervisor");
  const days = windowDays(url);
  const programId = effectiveProgramId(user, req);
  const totals = { queries: 0, refused: 0, flaggedMissing: 0, negativeFeedback: 0 };
  if (!programId) return { items: [], windowDays: days, totals, noProgramSelected: true };
  // Supervisor: gaps and totals come from their team's questions only.
  const rows = windowRows(programId, days, null, teamScope(user));
  const groups = new Map();
  for (const row of rows) {
    totals.queries += 1;
    if (row.refused) totals.refused += 1;
    if (row.flaggedMissing) totals.flaggedMissing += 1;
    if (row.feedback === -1) totals.negativeFeedback += 1;
    if (!row.refused && !row.flaggedMissing && row.feedback !== -1) continue;
    const key = normalizeQuestion(row.question);
    const entry = groups.get(key) ?? {
      question: row.question,
      askCount: 0,
      refusedCount: 0,
      flaggedCount: 0,
      negativeCount: 0,
      lastAskedAt: row.createdAt
    };
    entry.askCount += 1;
    if (row.refused) entry.refusedCount += 1;
    if (row.flaggedMissing) entry.flaggedCount += 1;
    if (row.feedback === -1) entry.negativeCount += 1;
    if (entry.lastAskedAt < row.createdAt) entry.lastAskedAt = row.createdAt;
    groups.set(key, entry);
  }
  const items = [...groups.values()].sort(
    (a, b) => b.askCount - a.askCount || b.lastAskedAt.localeCompare(a.lastAskedAt)
  );
  return { items, windowDays: days, totals };
}

function queryLogList(user, req, url) {
  requireRole(user, "manager");
  const programId = effectiveProgramId(user, req);
  const filter = url.searchParams.get("filter") ?? "all";
  if (!["flagged", "refused", "negative", "all"].includes(filter)) throw badRequest("Unknown filter.");
  const rows = state.queryLog
    .filter((r) => !programId || r.programId === programId)
    .filter(
      (r) =>
        filter === "all" ||
        (filter === "flagged" && r.flaggedMissing) ||
        (filter === "refused" && r.refused) ||
        (filter === "negative" && r.feedback === -1)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200);
  return {
    items: rows.map((r) => ({
      id: r.id,
      question: r.question,
      refused: r.refused,
      flaggedMissing: r.flaggedMissing,
      feedback: r.feedback,
      latencyMs: r.latencyMs,
      programId: r.programId,
      createdAt: r.createdAt
    }))
  };
}

/** GET /api/admin/users: supervisor and above; a supervisor lists only the CSRs on their own team. */
function userList(user, req) {
  requireRole(user, "supervisor");
  const programId = user.role === "super_user" ? effectiveProgramId(user, req) : user.programId;
  const onTeam = (u) =>
    u.role === "csr" &&
    state.teamMembers.some((m) => m.csrId === u.id && m.supervisorId === user.id && m.programId === u.programId);
  const items = state.users
    .filter((u) => (programId ? u.programId === programId : true))
    .filter((u) => user.role === "super_user" || u.role !== "super_user")
    .filter((u) => user.role !== "supervisor" || onTeam(u))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      programId: u.programId,
      isActive: u.isActive,
      mustResetPassword: u.mustResetPassword,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt
    }));
  return { items };
}

/** routes/admin/users.ts canManageUser: who a manager+ actor may administer. */
function canManageUser(actor, target) {
  if (actor.id === target.id) return false;
  if (actor.role === "super_user") return true;
  if (target.role === "super_user" || target.role === "senior_manager") return false;
  if (!actor.programId || actor.programId !== target.programId) return false;
  if (actor.role === "senior_manager") return ["csr", "supervisor", "manager"].includes(target.role);
  if (actor.role === "manager") return ["csr", "supervisor"].includes(target.role);
  return false;
}

/**
 * POST /api/admin/users/:id/reset-password: supervisor and above, never demo
 * accounts. A supervisor may reset only a CSR on their own team; manager and
 * above go through canManageUser. Anyone out of scope is a 404, not a 403.
 * Returns the temporary password once and sets mustResetPassword.
 */
function resetUserPassword(user, id) {
  requireRole(user, "supervisor");
  if (limitedDemo(user)) throw new HttpError(403, DEMO_MESSAGE);
  if (!UUID_RE.test(id)) throw badRequest("Invalid user id");
  const target = state.users.find((u) => u.id === id.toLowerCase());
  if (!target) throw notFound();
  const allowed =
    user.role === "supervisor"
      ? target.id !== user.id &&
        target.role === "csr" &&
        target.programId === user.programId &&
        state.teamMembers.some(
          (m) => m.csrId === target.id && m.supervisorId === user.id && m.programId === user.programId
        )
      : canManageUser(user, target);
  if (!allowed) throw notFound();
  // routes/admin/users.ts demoTargetLocked: only a super user resets a demo account.
  if (target.isDemo && user.role !== "super_user") throw new HttpError(403, DEMO_MESSAGE);
  target.mustResetPassword = true;
  return { tempPassword: randomBytes(12).toString("base64url") };
}

function adminDocuments(user, req) {
  requireRole(user, "manager");
  const programId = effectiveProgramId(user, req);
  if (!programId) return { items: [], sources: [], controlsReady: true, noProgramSelected: true };
  const items = state.documents
    .filter((d) => d.programId === programId)
    .map((d) => {
      const version = activeVersion(d);
      return {
        documentId: d.id,
        title: d.title,
        versionId: version.id,
        parseStatus: "ready",
        uploadedAt: version.uploadedAt,
        lifecycleState: d.retired ? "retired" : "active",
        scanStatus: "clean",
        classification: d.classification,
        isActive: !d.retired,
        sourceName: null,
        sourceOriginUri: null,
        sourceOwner: null,
        uploadedById: null,
        uploadedByName: "Maria Chen",
        approvedByName: "Maria Chen",
        findings: [],
        canApprove: false,
        canReject: false,
        canRevoke: false,
        canRescan: false
      };
    });
  return { items, sources: [], controlsReady: true };
}

// ---------------------------------------------------------------------------
// Chat (enough for /chat to work against the fixture library)

function sourceForCitation(citation) {
  const doc = state.documents.find((d) => d.id === citation.doc_id);
  const superseded = doc ? citation.document_version_id !== doc.activeVersionId : false;
  return superseded ? { ...citation, superseded: true } : { ...citation };
}

// Mirrors routes/sessions.ts: an exchange is shown only when every cited
// document is still live and readable by the user, so uncited rows
// (refusals included) stay out of history.
// The title (named from the opening exchange) shows only when that exchange
// is visible and every other hidden exchange is an uncited refusal. Sessions
// with nothing visible are left out of the list.
function sessionHistory(session, user) {
  const rows = state.queryLog
    .filter((r) => r.sessionId === session.id && r.userId === user.id && r.programId === session.programId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const isVisible = (r) =>
    r.citations.length > 0 &&
    r.citations.every((c) => state.documents.some((d) => d.id === c.doc_id && !d.retired && canSee(user, d)));
  const visible = rows.filter(isVisible);
  const titleAllowed =
    rows.length > 0 && isVisible(rows[0]) &&
    rows.every((r) => isVisible(r) || (r.refused && r.citations.length === 0));
  return { visible, title: titleAllowed ? session.title : null };
}

function listSessions(user, req) {
  const programId = effectiveProgramId(user, req);
  if (!programId) return { items: [], noProgramSelected: true };
  return {
    items: state.sessions
      .filter((s) => s.userId === user.id && s.programId === programId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({ session: s, history: sessionHistory(s, user) }))
      .filter(({ history }) => history.visible.length > 0)
      .map(({ session, history }) => ({ id: session.id, title: history.title, updatedAt: session.updatedAt }))
  };
}

function sessionDetail(user, req, id) {
  const programId = requireProgram(user, req);
  const session = state.sessions.find(
    (s) => s.id === id && s.userId === user.id && s.programId === programId
  );
  if (!session) throw notFound();
  const history = sessionHistory(session, user);
  return {
    id: session.id,
    title: history.title,
    exchanges: history.visible
      .map((r) => ({
        queryLogId: r.id,
        question: r.question,
        answer: r.answer,
        refused: r.refused,
        latencyMs: r.latencyMs,
        feedback: r.feedback,
        sources: r.citations.map(sourceForCitation)
      }))
  };
}

const STOPWORDS = new Set(
  "a an the and or of to for on in is are can i we do does how what when what's whats with my our your it be at by from this that customer caller".split(
    " "
  )
);
const words = (text) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

function answerQuestion(user, req, body) {
  const programId = requireProgram(user, req);
  if (!body || typeof body.question !== "string" || !body.question.trim()) {
    throw badRequest("Ask a question first.");
  }
  const question = body.question.trim();
  const qWords = new Set(words(question));
  const scored = visibleDocs(user, programId)
    .map((doc) => {
      const titleWords = words(doc.title);
      const bodyWords = new Set(words(activeVersion(doc).markdown));
      let score = 0;
      for (const w of qWords) {
        if (titleWords.includes(w)) score += 3;
        else if (bodyWords.has(w)) score += 1;
      }
      return { doc, score };
    })
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  let session = state.sessions.find(
    (s) => s.id === body.sessionId && s.userId === user.id && s.programId === programId
  );
  const nowIso = iso(Date.now());
  if (!session) {
    session = {
      id: nextId(),
      userId: user.id,
      programId,
      title: question.length > 60 ? `${question.slice(0, 57)}...` : question,
      updatedAt: nowIso
    };
    state.sessions.push(session);
  }
  session.updatedAt = nowIso;

  const row = {
    id: nextId(),
    programId,
    userId: user.id,
    sessionId: session.id,
    question,
    answer: "I couldn't find this in the knowledge base.",
    createdAt: nowIso,
    refused: scored.length === 0,
    feedback: null,
    flaggedMissing: false,
    latencyMs: 1200 + Math.floor(Math.random() * 900),
    citations: []
  };
  if (scored.length > 0) {
    const sentences = [];
    scored.forEach(({ doc }, index) => {
      const version = activeVersion(doc);
      const passage =
        version.passages.find((p) => words(p.text).some((w) => qWords.has(w))) ?? version.passages[0];
      const chunkId = nextId();
      row.citations.push({
        chunk_id: chunkId,
        doc_title: doc.title,
        excerpt: passage.text,
        doc_id: doc.id,
        document_version_id: version.id,
        version_number: version.versionNumber,
        citation_index: index,
        source_start: passage.start,
        source_end: passage.end
      });
      sentences.push(`${passage.text} [${chunkId}]`);
    });
    row.answer = sentences.join("\n\n");
  }
  state.queryLog.push(row);
  return {
    queryLogId: row.id,
    sessionId: session.id,
    answer: row.answer,
    sources: row.citations.map(sourceForCitation),
    refused: row.refused,
    confidence: row.refused ? "low" : scored[0].score >= 6 ? "high" : "medium",
    retrievedChunks: row.citations.map((c) => ({ id: c.chunk_id, content: c.excerpt, docTitle: c.doc_title })),
    latencyMs: row.latencyMs,
    topScore: row.refused ? null : Math.min(0.99, scored[0].score / 10),
    rewrittenQuestion: null
  };
}

async function streamAnswer(user, req, res, body) {
  const result = answerQuestion(user, req, body);
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  for (const stage of ["searching", "reranking", "generating"]) {
    res.write(`${JSON.stringify({ type: "stage", stage })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  res.write(`${JSON.stringify({ type: "result", result })}\n`);
  res.end();
}

// ---------------------------------------------------------------------------
// Routing

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route("GET", /^\/api\/config$/, () => ({
  minPasswordLength: 12,
  emailResetAvailable: false,
  oidcEnabled: false,
  localLoginMode: "enabled",
  demoAccounts: [
    { label: "CSR (Jordan Reyes)", email: ROLE_ALIASES.csr, password: "mock-password", role: "csr" },
    {
      label: "Supervisor (Renee Alvarez)",
      email: ROLE_ALIASES.supervisor,
      password: "mock-password",
      role: "supervisor"
    },
    { label: "Manager (Maria Chen)", email: ROLE_ALIASES.manager, password: "mock-password", role: "manager" }
  ]
}));
route("GET", /^\/api\/health$/, () => ({ ok: true }));

// routes/admin/security.ts: super users only. The scanner part is a fixed
// "on, not configured" stub; the demo-limits switch works.
function securityDashboard() {
  return {
    malwareScanning: {
      enabled: true,
      persistenceReady: true,
      disabledStatusReady: true,
      scannerConfigured: false,
      scannerTransportSecure: false,
      updatedAt: null,
      updatedByName: null,
      updatedByEmail: null
    },
    demoLimits: { ...demoLimits, persistenceReady: true, demoAccountsConfigured: true },
    summary: { quarantined: 0, unavailable: 0, errors: 0, infected: 0, disabled: 0 },
    scans: [],
    controlEvents: securityEvents.slice(0, 50)
  };
}
route("GET", /^\/api\/admin\/security$/, ({ user }) => {
  requireRole(user, "super_user");
  return securityDashboard();
});
route("PATCH", /^\/api\/admin\/security\/demo-limits$/, ({ user, body }) => {
  requireRole(user, "super_user");
  if (typeof body?.enabled !== "boolean") throw badRequest("Provide the demo limits state");
  const at = iso(Date.now());
  Object.assign(demoLimits, { enabled: body.enabled, updatedAt: at, updatedByName: user.name, updatedByEmail: user.email });
  securityEvents.unshift({
    id: `sec-${securityEvents.length + 1}`,
    occurredAt: at,
    action: `security.demo_limits.${body.enabled ? "enabled" : "disabled"}`,
    actorEmail: user.email,
    details: { enabled: body.enabled }
  });
  return securityDashboard();
});
// routes/compliance.ts: super users only. Fixture text is invented; real
// documents live only in object storage.
const COMPLIANCE_FIXTURES = [
  {
    slug: "fixture-plan-of-action",
    title: "Fixture plan of action and milestones",
    version: "0.1",
    date: "2026-10-10",
    markdown: [
      "# Fixture plan of action",
      "",
      "Invented rows for the local preview. No real weakness is described here.",
      "",
      "| Item | Control | Status | Target date |",
      "| --- | --- | --- | --- |",
      "| FX-1 | Example access control | Open | 2026-12-01 |",
      "| FX-2 | Example logging control | In progress | 2027-01-15 |",
      "| FX-3 | Example backup control | Closed | 2026-09-30 |",
      "",
      "## Notes",
      "",
      "- Each row would link to its evidence in the real document.[^1]",
      "- `FX` identifiers exist only in this fixture. See the [NIST catalog](https://csrc.nist.gov/).",
      "",
      "[^1]: Fixture footnote, used to check footnote links in the viewer."
    ].join("\n")
  },
  {
    slug: "fixture-system-security-plan",
    title: "Fixture system security plan",
    version: "0.2",
    date: "2026-10-08",
    markdown: "# Fixture system security plan\n\nPlaceholder text for the local preview."
  }
].map((doc) => {
  const body = Buffer.from(doc.markdown, "utf8");
  return { ...doc, sha256: createHash("sha256").update(body).digest("hex"), size: body.length };
});

route("GET", /^\/api\/compliance\/documents$/, ({ user }) => {
  requireRole(user, "super_user");
  return { documents: COMPLIANCE_FIXTURES.map(({ markdown: _markdown, ...doc }) => doc) };
});
route("GET", /^\/api\/compliance\/documents\/([^/]+)$/, ({ user, params }) => {
  requireRole(user, "super_user");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(params[0]) || params[0].length > 80) {
    throw badRequest("Invalid document id");
  }
  const doc = COMPLIANCE_FIXTURES.find((candidate) => candidate.slug === params[0]);
  if (!doc) throw notFound();
  audit.push({ at: iso(Date.now()), action: "compliance.document_read", actor: user.email, slug: doc.slug, sha256: doc.sha256 });
  const { size: _size, ...body } = doc;
  return body;
});

route("GET", /^\/api\/me$/, ({ req }) => ({ user: publicUser(requireUser(req)) }));
route("POST", /^\/api\/auth\/login$/, ({ body, res }) => {
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const user = state.users.find((u) => u.email === email);
  if (!user) throw new HttpError(401, "Invalid email or password.");
  // An account with a passkey gets the second step, not a session.
  if (state.mfa.get(user.id)?.passkeys.length) return startMfaLogin(user, res);
  res.setHeader("Set-Cookie", `mock_user=${user.id}; Path=/; SameSite=Lax`);
  return { user: publicUser(user) };
});
route("POST", /^\/api\/auth\/logout$/, ({ res }) => {
  res.setHeader("Set-Cookie", "mock_user=out; Path=/; SameSite=Lax");
  return { ok: true };
});
route("POST", /^\/api\/auth\/forgot-password$/, () => undefined);
// POST /api/auth/reset-password (routes/auth.ts). Fixture tokens are
// `mock-reset-<key>`, where <key> is anything /__mock/as/<key> takes (a first
// name, a role alias, an email); each works once until /__mock/reset. No
// email is sent and the new password is not stored, because the fixture
// login takes any password. An account with a passkey gets no session and
// must sign in again with its second factor, as on the server; the fixture
// runs in "enabled" local login mode, so the break_glass branch never applies.
const RESET_TOKEN_PREFIX = "mock-reset-";
const PUBLISHED_DEMO_EMAILS = new Set([ROLE_ALIASES.csr, ROLE_ALIASES.supervisor, ROLE_ALIASES.manager]);
route("POST", /^\/api\/auth\/reset-password$/, ({ body, res }) => {
  const token = typeof body?.token === "string" ? body.token : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < 12) throw badRequest("New password must be at least 12 characters");
  const user = token.startsWith(RESET_TOKEN_PREFIX) ? userByKey(token.slice(RESET_TOKEN_PREFIX.length)) : null;
  // Demo accounts never reset their published password (isDemoEmail on the server).
  if (
    !user || !user.isActive || user.isDemo || PUBLISHED_DEMO_EMAILS.has(user.email) ||
    state.usedResetTokens.has(token)
  ) {
    throw badRequest("This reset link is invalid or has expired");
  }
  state.usedResetTokens.add(token);
  user.mustResetPassword = false;
  if (state.mfa.get(user.id)?.passkeys.length) {
    // The server also revokes every session; the fixture's only session is
    // the role cookie, so sign the browser out.
    res.setHeader("Set-Cookie", "mock_user=out; Path=/; SameSite=Lax");
    securityEvents.unshift({
      id: `sec-${securityEvents.length + 1}`,
      occurredAt: iso(Date.now()),
      action: "auth.password_reset.sign_in_required",
      actorEmail: user.email,
      details: { authMethod: "local", reason: "second_factor_required" }
    });
    return { passwordReset: true, signInRequired: true };
  }
  res.setHeader("Set-Cookie", `mock_user=${user.id}; Path=/; SameSite=Lax`);
  return { user: publicUser(user) };
});

// ---------------------------------------------------------------------------
// Break-glass second factor (routes/mfa.ts, lib/auth/mfa.ts).
//
// FIXTURE ONLY: no WebAuthn cryptography. The passkey endpoints accept any
// browser response whose credential id is registered to the account; they
// never check a signature, an attestation, the challenge or the origin. This
// exercises the SPA flow (prompts, cookies, errors), nothing about the
// server's verification, which routes/__tests__/mfa-login.test.ts covers.
//
// The RP ID is "localhost", so open the SPA on http://localhost:<port>, not
// 127.0.0.1. Enrollment changes take any current password except
// "wrong-password", which returns the server's 401 for the error state.

const MFA_TTL_MS = 5 * 60 * 1000;
const MFA_COOKIE = "mock_mfa";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const pendingMfa = new Map();
const base64url = (buf) => Buffer.from(buf).toString("base64url");
const mfaExpired = () =>
  Object.assign(new HttpError(401, "Your sign-in expired. Enter your email and password again."), {
    code: "mfa_expired"
  });

function mfaRecord(userId) {
  if (!state.mfa.has(userId)) state.mfa.set(userId, { passkeys: [], recoveryCodes: [] });
  return state.mfa.get(userId);
}

function newRecoveryCode() {
  const bytes = randomBytes(16);
  const raw = Array.from(bytes, (b) => BASE32[b & 31]).join("");
  return raw.match(/.{4}/g).join("-");
}

function passkeySummary(p) {
  return { id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt };
}

/** Pending challenge for the request's mock_mfa cookie, or a 401 mfa_expired. */
function pendingChallenge(req, purpose, userId) {
  const entry = purpose === "login"
    ? pendingMfa.get(readCookie(req, MFA_COOKIE) ?? "")
    : [...pendingMfa.values()].reverse().find((c) => c.purpose === "register" && c.userId === userId);
  if (!entry || entry.purpose !== purpose || entry.consumed || entry.expiresAt <= Date.now()) {
    throw mfaExpired();
  }
  return entry;
}

function finishMfaLogin(res, entry) {
  entry.consumed = true;
  const user = state.users.find((u) => u.id === entry.userId);
  res.setHeader("Set-Cookie", [
    `mock_user=${user.id}; Path=/; SameSite=Lax`,
    `${MFA_COOKIE}=; Path=/api/auth/mfa; Max-Age=0; HttpOnly; SameSite=Lax`
  ]);
  return { user: publicUser(user) };
}

/** POST /api/auth/login for an account with passkeys: no session, a challenge. */
function startMfaLogin(user, res) {
  const token = base64url(randomBytes(24));
  const challenge = base64url(randomBytes(32));
  pendingMfa.set(token, { purpose: "login", userId: user.id, challenge, expiresAt: Date.now() + MFA_TTL_MS });
  res.setHeader(
    "Set-Cookie",
    `${MFA_COOKIE}=${token}; Path=/api/auth/mfa; Max-Age=${MFA_TTL_MS / 1000}; HttpOnly; SameSite=Lax`
  );
  return {
    mfaRequired: true,
    methods: ["passkey", "recovery_code"],
    passkeyOptions: {
      challenge,
      timeout: MFA_TTL_MS,
      rpId: "localhost",
      allowCredentials: mfaRecord(user.id).passkeys.map((p) => ({
        id: p.credentialId,
        type: "public-key",
        transports: p.transports
      })),
      userVerification: "required"
    }
  };
}

function checkCurrentPassword(body) {
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) throw badRequest("Enter your current password.");
  if (password === "wrong-password") throw new HttpError(401, "Current password is incorrect");
}

route("POST", /^\/api\/auth\/mfa\/passkey$/, ({ req, res, body }) => {
  const entry = pendingChallenge(req, "login");
  const passkey = mfaRecord(entry.userId).passkeys.find((p) => p.credentialId === body?.id);
  // Fixture only: a registered credential id is enough, no signature check.
  if (!passkey) throw new HttpError(401, "Invalid credentials");
  passkey.lastUsedAt = iso(Date.now());
  return finishMfaLogin(res, entry);
});
route("POST", /^\/api\/auth\/mfa\/recovery-code$/, ({ req, res, body }) => {
  const entry = pendingChallenge(req, "login");
  const typed = String(body?.code ?? "").toLowerCase().replace(/[\s-]/g, "");
  const code = mfaRecord(entry.userId).recoveryCodes.find(
    (c) => c.usedAt === null && c.code.replace(/-/g, "") === typed
  );
  if (!code) throw new HttpError(401, "Invalid credentials");
  code.usedAt = iso(Date.now());
  return finishMfaLogin(res, entry);
});
route("GET", /^\/api\/auth\/mfa\/status$/, ({ user }) => {
  requireRole(user, "super_user");
  const record = mfaRecord(user.id);
  return {
    passkeyAvailable: true,
    passkeys: record.passkeys.map(passkeySummary),
    unusedRecoveryCodes: record.recoveryCodes.filter((c) => c.usedAt === null).length
  };
});
route("POST", /^\/api\/auth\/mfa\/passkeys\/options$/, ({ user, body }) => {
  requireRole(user, "super_user");
  checkCurrentPassword(body);
  const challenge = base64url(randomBytes(32));
  pendingMfa.set(base64url(randomBytes(24)), {
    purpose: "register",
    userId: user.id,
    challenge,
    expiresAt: Date.now() + MFA_TTL_MS
  });
  return {
    options: {
      rp: { name: "Truenote", id: "localhost" },
      user: { id: base64url(Buffer.from(user.id)), name: user.email, displayName: user.name },
      challenge,
      pubKeyCredParams: [
        { alg: -8, type: "public-key" },
        { alg: -7, type: "public-key" },
        { alg: -257, type: "public-key" }
      ],
      timeout: MFA_TTL_MS,
      attestation: "none",
      excludeCredentials: mfaRecord(user.id).passkeys.map((p) => ({
        id: p.credentialId,
        type: "public-key",
        transports: p.transports
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required", requireResidentKey: false }
    }
  };
});
route("POST", /^\/api\/auth\/mfa\/passkeys$/, ({ user, body, res }) => {
  requireRole(user, "super_user");
  checkCurrentPassword(body);
  const credentialId = body?.response?.id;
  if (typeof credentialId !== "string" || !credentialId) throw badRequest("Invalid request");
  const entry = pendingChallenge({ headers: {} }, "register", user.id);
  const record = mfaRecord(user.id);
  if (record.passkeys.some((p) => p.credentialId === credentialId)) {
    throw new HttpError(409, "This passkey is already registered, or the request expired.");
  }
  // Fixture only: the attestation is not verified.
  entry.consumed = true;
  const transports = Array.isArray(body.response.response?.transports) ? body.response.response.transports : [];
  const passkey = {
    id: nextId(),
    credentialId,
    transports,
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "Passkey",
    createdAt: iso(Date.now()),
    lastUsedAt: null
  };
  record.passkeys.push(passkey);
  res.statusCode = 201;
  return { passkey: passkeySummary(passkey) };
});
route("DELETE", /^\/api\/auth\/mfa\/passkeys\/([^/]+)$/, ({ user, body, params }) => {
  requireRole(user, "super_user");
  checkCurrentPassword(body);
  const record = mfaRecord(user.id);
  const index = record.passkeys.findIndex((p) => p.id === params[0]);
  if (index < 0) throw notFound();
  record.passkeys.splice(index, 1);
  return undefined;
});
route("POST", /^\/api\/auth\/mfa\/recovery-codes$/, ({ user, body }) => {
  requireRole(user, "super_user");
  checkCurrentPassword(body);
  const codes = Array.from({ length: 10 }, newRecoveryCode);
  mfaRecord(user.id).recoveryCodes = codes.map((code) => ({ code, usedAt: null }));
  return { codes };
});
route("POST", /^\/api\/auth\/change-password$/, ({ req }) => {
  // Any password is accepted; changing it clears a reset from the Users page.
  const user = requireUser(req);
  user.mustResetPassword = false;
  return { user: publicUser(user) };
});

route("GET", /^\/api\/sessions$/, ({ user, req }) => listSessions(user, req));
route("GET", /^\/api\/sessions\/([^/]+)$/, ({ user, req, params }) => sessionDetail(user, req, params[0]));
route("POST", /^\/api\/ask$/, ({ user, req, body }) => answerQuestion(user, req, body));
route("POST", /^\/api\/ask\/stream$/, ({ user, req, res, body }) => streamAnswer(user, req, res, body));
route("POST", /^\/api\/feedback$/, ({ user, body }) => {
  const row = state.queryLog.find((r) => r.id === body?.queryLogId && r.userId === user.id);
  if (!row) throw notFound();
  row.feedback = body.feedback === 0 ? null : body.feedback;
  return { ok: true };
});
route("POST", /^\/api\/flag-missing$/, ({ user, body }) => {
  const row = state.queryLog.find((r) => r.id === body?.queryLogId && r.userId === user.id);
  if (!row) throw notFound();
  row.flaggedMissing = true;
  return { ok: true };
});

route("GET", /^\/api\/kb\/documents$/, ({ user, req }) => kbList(user, req));
route("GET", /^\/api\/kb\/documents\/([^/]+)$/, ({ user, req, params, url }) =>
  kbDocument(user, req, params[0], url)
);
route("PUT", /^\/api\/kb\/documents\/([^/]+)\/pin$/, ({ user, req, params, body }) =>
  setPin(user, req, params[0], body)
);
route("PUT", /^\/api\/kb\/documents\/([^/]+)\/note$/, ({ user, req, params, body }) =>
  setNote(user, req, params[0], body)
);
route("PUT", /^\/api\/kb\/documents\/([^/]+)\/color$/, ({ user, req, params, body }) =>
  setSourceColor(user, req, params[0], body)
);
route("PUT", /^\/api\/kb\/categories\/([^/]+)\/color$/, ({ user, req, params, body }) =>
  setCategoryColor(user, req, params[0], body)
);
route("PUT", /^\/api\/kb\/labels\/([^/]+)$/, ({ user, params, body }) => setColorLabel(user, params[0], body));
route("DELETE", /^\/api\/kb\/labels\/([^/]+)$/, ({ user, params }) => deleteColorLabel(user, params[0]));
route("GET", /^\/api\/kb\/documents\/([^/]+)\/highlights$/, ({ user, req, params }) =>
  listHighlights(user, req, params[0])
);
route("POST", /^\/api\/kb\/documents\/([^/]+)\/highlights$/, ({ user, req, params, body, res }) => {
  res.statusCode = 201;
  return createHighlight(user, req, params[0], body);
});
route("PATCH", /^\/api\/kb\/highlights\/([^/]+)$/, ({ user, params, body }) => {
  const h = state.highlights.find((x) => x.id === params[0] && x.userId === user.id);
  if (!h) throw notFound();
  if (!["yellow", "green", "blue"].includes(body?.color)) throw badRequest("Invalid highlight color.");
  h.color = body.color;
  h.updatedAt = iso(Date.now());
  return { item: highlightOut(h) };
});
route("DELETE", /^\/api\/kb\/highlights\/([^/]+)$/, ({ user, params }) => {
  const before = state.highlights.length;
  state.highlights = state.highlights.filter((x) => !(x.id === params[0] && x.userId === user.id));
  if (state.highlights.length === before) throw notFound();
  return { ok: true };
});

const L = "\\/api\\/kb\\/library";
route("POST", new RegExp(`^${L}\\/categories$`), ({ user, req, body, res }) => {
  const item = createCategory(user, req, body);
  res.statusCode = 201;
  return { item };
});
route("PUT", new RegExp(`^${L}\\/categories\\/order$`), ({ user, req, body }) => reorderCategories(user, req, body));
route("PATCH", new RegExp(`^${L}\\/categories\\/([^/]+)$`), ({ user, req, params, body }) => ({
  item: updateCategory(user, req, params[0], body)
}));
route("DELETE", new RegExp(`^${L}\\/categories\\/([^/]+)$`), ({ user, req, params }) =>
  deleteCategory(user, req, params[0])
);
route("PUT", new RegExp(`^${L}\\/categories\\/([^/]+)\\/documents$`), ({ user, req, params, body }) => ({
  item: setCategoryDocuments(user, req, params[0], body)
}));
route("PUT", new RegExp(`^${L}\\/documents\\/([^/]+)\\/categories$`), ({ user, req, params, body }) =>
  setDocumentCategories(user, req, params[0], body)
);
route("PUT", new RegExp(`^${L}\\/documents\\/([^/]+)\\/tags$`), ({ user, req, params, body }) =>
  setDocumentTags(user, req, params[0], body)
);
route("POST", new RegExp(`^${L}\\/tags$`), ({ user, req, body, res }) => {
  const item = createTag(user, req, body);
  res.statusCode = 201;
  return { item };
});
route("PATCH", new RegExp(`^${L}\\/tags\\/([^/]+)$`), ({ user, req, params, body }) => ({
  item: updateTag(user, req, params[0], body)
}));
route("DELETE", new RegExp(`^${L}\\/tags\\/([^/]+)$`), ({ user, req, params }) => deleteTag(user, req, params[0]));
route("PUT", new RegExp(`^${L}\\/featured$`), ({ user, req, body }) => setFeatured(user, req, body));
route("PUT", new RegExp(`^${L}\\/team-shortcuts$`), ({ user, req, body }) => setTeamShortcuts(user, req, body));

route("GET", /^\/api\/ask-examples$/, ({ user, req }) => askExamples(user, req));
route("PUT", /^\/api\/ask-examples$/, ({ user, req, body }) => setAskExamples(user, req, body));
route("GET", /^\/api\/admin\/teams$/, ({ user, req }) => teamsList(user, req));
route("PUT", /^\/api\/admin\/teams\/assignments$/, ({ user, req, body }) => assignTeam(user, req, body));

route("GET", /^\/api\/admin\/insights\/kb-gaps$/, ({ user, req, url }) => kbGaps(user, req, url));
route("GET", /^\/api\/admin\/insights\/source-usage$/, ({ user, req, url }) => sourceUsage(user, req, url));
route("GET", /^\/api\/admin\/insights\/source-usage\/questions$/, ({ user, req, url }) =>
  sourceUsageQuestions(user, req, url)
);
route("GET", /^\/api\/admin\/queries$/, ({ user, req, url }) => queryLogList(user, req, url));
route("GET", /^\/api\/admin\/users$/, ({ user, req }) => userList(user, req));
route("POST", /^\/api\/admin\/users\/([^/]+)\/reset-password$/, ({ user, params }) =>
  resetUserPassword(user, params[0])
);
// Manager and above; a super user gets every program, anyone else their own.
route("GET", /^\/api\/admin\/programs$/, ({ user }) => {
  requireRole(user, "manager");
  return {
    items: state.programs
      .filter((p) => user.role === "super_user" || p.id === user.programId)
      .sort((a, b) => a.name.localeCompare(b.name))
  };
});
route("GET", /^\/api\/documents$/, ({ user, req }) => adminDocuments(user, req));

const PUBLIC_PATHS = new Set([
  "/api/config",
  "/api/health",
  "/api/me",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/mfa/passkey",
  "/api/auth/mfa/recovery-code"
]);

// ---------------------------------------------------------------------------
// Fixture controls: /__mock/* (also reachable as /api/__mock/* through Vite)

function mockControl(req, res, url, path) {
  const sub = path.replace(/^\/(api\/)?__mock/, "");
  const asMatch = sub.match(/^\/as\/([^/]+)$/);
  if (asMatch) {
    const key = decodeURIComponent(asMatch[1]).toLowerCase();
    const user = userByKey(key);
    if (!user && key !== "out") {
      return send(res, 404, {
        error: `Unknown role "${key}". Use ${Object.keys(ROLE_ALIASES).join(", ")}, out, or a first name.`
      });
    }
    // Through the Vite proxy (xfwd: true) the browser is already on the SPA
    // origin, so a relative "/" lands on the app.
    const viaProxy = typeof req.headers["x-forwarded-host"] === "string";
    const location = viaProxy ? "/" : `http://localhost:${FRONTEND_PORT}/`;
    res.writeHead(302, {
      "Set-Cookie": `mock_user=${user ? encodeURIComponent(key) : "out"}; Path=/; SameSite=Lax`,
      Location: location
    });
    return res.end();
  }
  if (sub === "/reset") {
    state = buildSeed();
    pendingMfa.clear();
    failPaths.clear();
    audit.length = 0;
    return send(res, 200, { ok: true, documents: state.documents.length, questions: state.queryLog.length });
  }
  if (sub === "/fail") {
    const target = url.searchParams.get("path");
    if (target) failPaths.add(target);
    else failPaths.clear();
    return send(res, 200, { failing: [...failPaths] });
  }
  if (sub === "/delay") {
    const ms = Number(url.searchParams.get("ms")) || 0;
    if (!(ms >= 0 && ms <= MAX_DELAY_MS)) return send(res, 400, { error: `ms must be 0 to ${MAX_DELAY_MS}.` });
    delayMs = ms;
    return send(res, 200, { delayMs });
  }
  if (sub === "/audit") return send(res, 200, { items: audit });
  if (sub === "" || sub === "/") {
    return send(res, 200, {
      roles: Object.keys(ROLE_ALIASES),
      users: state.users.map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email })),
      failing: [...failPaths],
      delayMs
    });
  }
  return send(res, 404, { error: "Unknown mock control." });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  res.on("finish", () => {
    if (!path.includes("__mock")) {
      console.log(logSafe(`${req.method} ${path}${url.search} ${res.statusCode} ${Date.now() - started}ms`));
    }
  });
  try {
    if (/^\/(api\/)?__mock(\/|$)/.test(path)) return mockControl(req, res, url, path);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (failPaths.has(path)) return send(res, 500, { error: "Fixture failure injected for this endpoint." });

    const match = routes
      .map((r) => ({ r, m: r.method === req.method ? path.match(r.pattern) : null }))
      .find((x) => x.m);
    if (!match) {
      console.warn(logSafe(`[mock-api] no fixture for ${req.method} ${path}`));
      return send(res, 404, { error: "Not found" });
    }
    const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : undefined;
    const user = PUBLIC_PATHS.has(path) ? currentUser(req) : requireUser(req);
    const result = await match.r.handler({
      req,
      res,
      url,
      body,
      user,
      params: match.m.slice(1).map(decodeURIComponent)
    });
    if (res.writableEnded) return;
    if (result === undefined) {
      res.writeHead(res.statusCode === 200 ? 204 : res.statusCode);
      return res.end();
    }
    return send(res, res.statusCode || 200, result);
  } catch (error) {
    if (error instanceof HttpError) {
      return send(res, error.status, error.code ? { error: error.message, code: error.code } : { error: error.message });
    }
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: "The fixture server hit an error." });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[mock-api] listening on http://localhost:${PORT}`);
  console.log(`[mock-api] ${state.documents.length} documents, ${state.queryLog.length} questions, ${state.views.length} views`);
  console.log(`[mock-api] switch role: http://localhost:${FRONTEND_PORT}/api/__mock/as/<${Object.keys(ROLE_ALIASES).join(" | ")}>`);
});
