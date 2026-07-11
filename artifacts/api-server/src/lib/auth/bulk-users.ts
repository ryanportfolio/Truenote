import { z } from "zod";

export const MAX_BULK_USERS = 100;

export const BulkUserEmailsSchema = z.object({
  emails: z
    .array(z.string().trim().email().max(254))
    .min(1, "CSV must contain at least one email")
    .max(MAX_BULK_USERS, `CSV can contain at most ${MAX_BULK_USERS} emails`)
});

export function normalizeBulkEmails(emails: readonly string[]): string[] {
  return Array.from(
    new Set(emails.map((email) => email.trim().toLowerCase()))
  );
}

export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "User";
  const words = local
    .replace(/[._+-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return (words.join(" ") || "User").slice(0, 120);
}

export function bulkUserValues(input: {
  email: string;
  name: string;
  passwordHash: string;
  programId: string;
  createdBy: string;
}) {
  return {
    ...input,
    role: "csr" as const,
    isActive: true,
    mustResetPassword: true
  };
}
