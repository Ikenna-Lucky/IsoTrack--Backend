export type UserRole = "business" | "driver" | "customer";

export interface JwtPayload {
  sub: string;
  role: UserRole;
  iat: number;
  exp: number;
}

export interface Coordinates {
  lat: number;
  lng: number;
}

declare module "hono" {
  interface ContextVariableMap {
    userId: string;
    userRole: UserRole;
    user: import("@/db/schema").User;
  }
}
