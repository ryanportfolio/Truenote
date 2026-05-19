export type UserRole = "admin" | "csr";

export interface CurrentUser {
  id: string;
  email: string;
  role: UserRole;
  programId: string;
}

const STUB_USER: CurrentUser = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "stub@local.test",
  role: "admin",
  programId: "00000000-0000-0000-0000-0000000000aa"
};

export async function currentUser(): Promise<CurrentUser> {
  return STUB_USER;
}

export async function requireRole(role: UserRole): Promise<CurrentUser> {
  const user = await currentUser();
  if (user.role !== role && user.role !== "admin") {
    throw new Error(`Forbidden: requires role ${role}`);
  }
  return user;
}
