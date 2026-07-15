export const PUBLIC_HOME_TITLE =
  "Truenote | Cited Knowledge Answers for Customer Service Teams";

const EXACT_TITLES: Readonly<Record<string, string>> = {
  "/": PUBLIC_HOME_TITLE,
  "/login": "Sign In | Truenote",
  "/chat": "Ask a Question | Truenote",
  "/kb": "Knowledge Base | Truenote",
  "/admin/documents": "Documents | Truenote",
  "/admin/gaps": "Knowledge Gaps | Truenote",
  "/admin/insights": "Knowledge Gaps | Truenote",
  "/admin/programs": "Programs | Truenote",
  "/admin/model-routing": "Model Routing | Truenote",
  "/admin/observability": "Observability | Truenote",
  "/admin/errors": "Error Log | Truenote",
  "/admin/security": "Security | Truenote",
  "/admin/evaluations": "Evaluations | Truenote",
  "/admin/users": "Users | Truenote",
  "/forgot-password": "Forgot Password | Truenote",
  "/reset-password": "Reset Password | Truenote",
  "/change-password": "Change Password | Truenote"
};

export function pageTitleForPath(path: string): string {
  const [pathname = "/"] = path.split(/[?#]/);
  if (pathname.startsWith("/kb/")) return "Knowledge Base | Truenote";
  return EXACT_TITLES[pathname] ?? "Page Not Found | Truenote";
}
