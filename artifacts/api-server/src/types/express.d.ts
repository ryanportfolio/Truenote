import type { CurrentUser } from "../lib/auth/current-user.js";

declare global {
  namespace Express {
    interface Request {
      user: CurrentUser;
    }
  }
}

export {};
