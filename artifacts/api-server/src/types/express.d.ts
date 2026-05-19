import type { CurrentUser } from "../lib/auth/current-user.js";

declare global {
  namespace Express {
    interface Request {
      /**
       * Authenticated principal, or null when the request has no valid
       * session. Route handlers that need a user must chain `requireAuth`
       * before themselves and then call `authedUser(req)` to get the
       * non-null value with proper typing.
       */
      user: CurrentUser | null;
    }
  }
}

export {};
