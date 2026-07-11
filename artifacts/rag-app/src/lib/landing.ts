import { hasAtLeastRole, type CurrentUser } from "@/types/api";

export function defaultLandingPath(user: CurrentUser): string {
  return hasAtLeastRole(user, "manager") ? "/admin/documents" : "/chat";
}

