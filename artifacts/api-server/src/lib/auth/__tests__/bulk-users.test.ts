import { describe, expect, it } from "vitest";
import {
  BULK_USER_TEMP_PASSWORD,
  BulkUserEmailsSchema,
  MAX_BULK_USERS,
  bulkUserValues,
  nameFromEmail,
  normalizeBulkEmails
} from "../bulk-users.js";

describe("bulk user helpers", () => {
  it("normalizes and deduplicates emails", () => {
    expect(
      normalizeBulkEmails([" Alice@Example.com ", "alice@example.com"])
    ).toEqual(["alice@example.com"]);
  });

  it("derives a readable name from the email prefix", () => {
    expect(nameFromEmail("jane.doe+support@example.com")).toBe(
      "Jane Doe Support"
    );
  });

  it("keeps the reviewed temporary-password and batch-size contracts", () => {
    expect(BULK_USER_TEMP_PASSWORD).toBe("Truenote213");
    expect(
      BulkUserEmailsSchema.safeParse({
        emails: Array.from(
          { length: MAX_BULK_USERS + 1 },
          (_, index) => `user${index}@example.com`
        )
      }).success
    ).toBe(false);
  });

  it("creates active CSR values that force first-login password reset", () => {
    expect(
      bulkUserValues({
        email: "csr@example.com",
        name: "Csr",
        passwordHash: "hash",
        programId: "program-1",
        createdBy: "admin-1"
      })
    ).toMatchObject({
      role: "csr",
      isActive: true,
      mustResetPassword: true
    });
  });
});
