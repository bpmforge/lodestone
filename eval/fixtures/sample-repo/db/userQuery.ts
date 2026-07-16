// SQL query building for user lookups (concept: sql_database).
export interface UserFilters {
  email?: string;
  active?: boolean;
}

export function findUserByEmail(email: string): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: "SELECT id, email, role FROM users WHERE email = ?",
    params: [email],
  };
}

export function buildUserQuery(filters: UserFilters): {
  sql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.email) {
    clauses.push("email = ?");
    params.push(filters.email);
  }
  if (filters.active !== undefined) {
    clauses.push("active = ?");
    params.push(filters.active ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { sql: `SELECT * FROM users ${where}`.trim(), params };
}
