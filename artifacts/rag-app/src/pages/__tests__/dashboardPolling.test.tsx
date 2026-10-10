import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EffectCallback } from "react";
import type { CurrentUser } from "@/types/api";
import { AdminErrorsPage } from "../AdminErrors";
import { AdminObservabilityPage } from "../AdminObservability";

// Server rendering runs the components' hooks but skips effects. Collect the
// effects instead and run them after the render, so the pages' real load and
// timer code executes without a DOM. State updates after the render are
// ignored by the server renderer, which is fine: these tests only check the
// requests the pages make.
const effects: EffectCallback[] = [];
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: EffectCallback) => {
      effects.push(effect);
    }
  };
});

const api = vi.hoisted(() => ({
  listErrors: vi.fn(),
  getObservability: vi.fn()
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, ...api };
});

const superUser: CurrentUser = {
  id: "u1",
  email: "admin@example.com",
  role: "super_user",
  programId: null,
  name: "Admin",
  mustResetPassword: false
};

let intervals: Array<{ callback: () => void; ms: number }>;

beforeEach(() => {
  effects.length = 0;
  intervals = [];
  for (const mock of Object.values(api)) {
    mock.mockReset();
    mock.mockResolvedValue({ items: [] });
  }
  const win = Object.assign(new EventTarget(), {
    localStorage: { getItem: () => null },
    setInterval: (callback: () => void, ms: number) => intervals.push({ callback, ms }),
    clearInterval: () => undefined
  });
  vi.stubGlobal("window", win);
});
afterEach(() => vi.unstubAllGlobals());

function mount(element: JSX.Element): void {
  renderToStaticMarkup(element);
  for (const effect of effects.splice(0)) effect();
}

function thirtySecondTimer(): () => void {
  const matches = intervals.filter((entry) => entry.ms === 30_000);
  expect(matches).toHaveLength(1);
  return matches[0]!.callback;
}

describe("AdminErrorsPage polling", () => {
  it("loads first as user activity, then refreshes in the background", () => {
    mount(<AdminErrorsPage user={superUser} />);

    expect(api.listErrors).toHaveBeenCalledTimes(1);
    expect(api.listErrors.mock.calls[0]![1]).toEqual({});

    thirtySecondTimer()();
    expect(api.listErrors).toHaveBeenCalledTimes(2);
    expect(api.listErrors.mock.calls[1]![1]).toEqual({ background: true });
  });
});

describe("AdminObservabilityPage polling", () => {
  it("loads first as user activity, then refreshes in the background", () => {
    mount(<AdminObservabilityPage user={superUser} />);

    expect(api.getObservability).toHaveBeenCalledTimes(1);
    expect(api.getObservability.mock.calls[0]).toEqual([24, {}]);

    thirtySecondTimer()();
    expect(api.getObservability).toHaveBeenCalledTimes(2);
    expect(api.getObservability.mock.calls[1]).toEqual([24, { background: true }]);
  });
});
