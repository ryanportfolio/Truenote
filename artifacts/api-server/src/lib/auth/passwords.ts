import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing parameters. argon2id with the @node-rs/argon2 library
 * defaults — these match the OWASP 2024 recommendation (memory 19MiB,
 * timeCost 2, parallelism 1). Explicit so a future library bump or a
 * different deployment topology doesn't silently change them.
 *
 * If we ever raise these (e.g., bigger memoryCost), existing hashes in the
 * DB stay valid — verify() reads the parameters from the hash string itself.
 * Login latency on Replit's shared CPU is ~50–100ms at these settings.
 */
const ARGON2_OPTIONS = {
  // Algorithm.Argon2id. The library's Algorithm is an ambient const enum,
  // which verbatimModuleSyntax forbids importing as a value; 2 is its
  // stable numeric value (Argon2d=0, Argon2i=1, Argon2id=2).
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Constant-time verification. Returns false on bad password OR malformed
 * hash — both surface as a generic "invalid credentials" to the caller, so
 * we never leak which path failed.
 */
export async function verifyPassword(
  plaintext: string,
  storedHash: string
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}
