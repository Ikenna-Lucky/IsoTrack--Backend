import type { User } from "@/db/schema";
export function sanitizeUser(
  user: User,
): Omit<User, "passwordHash" | "credentialVersion"> {
  const { passwordHash: _, credentialVersion: __, ...safe } = user;
  return safe;
}
