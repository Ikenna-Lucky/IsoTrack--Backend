import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { NewUser, User } from "@/db/schema";

// ─── Read ──────────────────────────────────────────────────────────────────────

export async function findUserById(id: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return user ?? null;
}

export async function findUserWithProfile(id: string) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
    with: {
      business: true,
      driver: true,
    },
  });
}

// ─── Write ─────────────────────────────────────────────────────────────────────

export async function createUser(data: NewUser): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ ...data, email: data.email.toLowerCase() })
    .returning();
  if (!user) throw new Error("Failed to create user");
  return user;
}

export async function updateUser(
  id: string,
  data: Partial<
    Pick<
      User,
      "name" | "phone" | "avatar" | "isEmailVerified" | "isActive" | "updatedAt"
    >
  >,
): Promise<User | null> {
  const [user] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return user ?? null;
}

// ─── Sanitize ──────────────────────────────────────────────────────────────────

/** Strip sensitive fields before sending to client */
export function sanitizeUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _, ...safe } = user;
  return safe;
}
