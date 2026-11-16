import type { UserRow, WorkspaceMembershipRow } from "../db/schema.js";

export interface AuthContext {
  user: UserRow;
  sessionId: string;
  workspaceId: string | null;
}

export interface AppBindings {
  Variables: {
    requestId: string;
    auth: AuthContext;
    membership: WorkspaceMembershipRow;
  };
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}
