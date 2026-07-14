import { afterEach, describe, expect, it } from "vitest";
import {
  getMinPasswordLength,
  resetMinPasswordLengthCacheForTests
} from "../config.js";

const originalMinimum = process.env.MIN_PASSWORD_LENGTH;

afterEach(() => {
  if (originalMinimum === undefined) {
    delete process.env.MIN_PASSWORD_LENGTH;
  } else {
    process.env.MIN_PASSWORD_LENGTH = originalMinimum;
  }
  resetMinPasswordLengthCacheForTests();
});

describe("getMinPasswordLength", () => {
  it("defaults to the 15-character single-factor floor", () => {
    delete process.env.MIN_PASSWORD_LENGTH;
    resetMinPasswordLengthCacheForTests();

    expect(getMinPasswordLength()).toBe(15);
  });

  it("rejects configured values below the hard floor", () => {
    process.env.MIN_PASSWORD_LENGTH = "8";
    resetMinPasswordLengthCacheForTests();

    expect(getMinPasswordLength()).toBe(15);
  });

  it("accepts a stronger configured value", () => {
    process.env.MIN_PASSWORD_LENGTH = "20";
    resetMinPasswordLengthCacheForTests();

    expect(getMinPasswordLength()).toBe(20);
  });
});
