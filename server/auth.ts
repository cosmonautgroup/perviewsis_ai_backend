/**
 * Authentication & Authorization
 * - Session-based auth via express-session + connect-pg-simple
 * - passport-local strategy with bcrypt
 * - requireAuth / requireRole / requireOrgMember middleware
 */

import { Request, Response, NextFunction } from "express";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import { db } from "./db";
import {
  users, organizations, organizationMembers, invitations, emailVerifications,
  User, Organization, OrganizationMember, Role, ROLES,
} from "@shared/schema";
import { eq, and, gt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Pool } from "pg";

// ─── Session ─────────────────────────────────────────────────────────────────
const PgStore = ConnectPgSimple(session);
const authReadPool = new Pool({ connectionString: process.env.DATABASE_URL });

function isMissingEmailVerifiedColumnError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return msg.includes("is_email_verified") && msg.includes("does not exist");
}

function mapLegacyUserRow(row: any): User {
  return {
    id: Number(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash ?? row.passwordHash ?? ""),
    name: String(row.name ?? ""),
    avatarInitials: row.avatar_initials ?? row.avatarInitials ?? null,
    // Legacy DBs may not have this column yet; treat as verified to avoid hard auth failure.
    isEmailVerified: true,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  } as User;
}

async function getUserByEmailCompat(email: string): Promise<User | null> {
  try {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    return user ?? null;
  } catch (err) {
    if (!isMissingEmailVerifiedColumnError(err)) throw err;
    const { rows } = await authReadPool.query(
      "SELECT id, email, password_hash, name, avatar_initials, created_at, updated_at FROM users WHERE lower(email) = lower($1) LIMIT 1",
      [email.toLowerCase()],
    );
    if (!rows?.[0]) return null;
    return mapLegacyUserRow(rows[0]);
  }
}

async function getUserByIdCompat(id: number): Promise<User | null> {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user ?? null;
  } catch (err) {
    if (!isMissingEmailVerifiedColumnError(err)) throw err;
    const { rows } = await authReadPool.query(
      "SELECT id, email, password_hash, name, avatar_initials, created_at, updated_at FROM users WHERE id = $1 LIMIT 1",
      [id],
    );
    if (!rows?.[0]) return null;
    return mapLegacyUserRow(rows[0]);
  }
}

export function setupSession(app: any) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  app.use(
    session({
      store: new PgStore({ pool, createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET ?? "perviewsis-dev-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false,//process.env.NODE_ENV === "production",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());
}

// ─── Passport Strategy ────────────────────────────────────────────────────────
passport.use(
  new LocalStrategy(
    { usernameField: "email", passwordField: "password" },
    async (email, password, done) => {
      try {
        const user = await getUserByEmailCompat(email);
        if (!user) return done(null, false, { message: "Invalid email or password" });
        if (!user.passwordHash || typeof user.passwordHash !== "string") {
          return done(null, false, { message: "Invalid email or password" });
        }
        let match = false;
        try {
          match = await bcrypt.compare(password, user.passwordHash);
        } catch {
          return done(null, false, { message: "Invalid email or password" });
        }
        if (!match) return done(null, false, { message: "Invalid email or password" });
        if (!user.isEmailVerified) return done(null, false, { message: "Please verify your email before signing in", code: "EMAIL_NOT_VERIFIED" } as any);
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

passport.serializeUser((user: any, done) => done(null, user.id));

passport.deserializeUser(async (id: number, done) => {
  try {
    const user = await getUserByIdCompat(id);
    done(null, user ?? false);
  } catch (err) {
    done(err);
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const user = req.user as User;
    const orgId = (req.session as any).currentOrgId;
    if (!orgId) return res.status(403).json({ error: "No organization selected" });

    const [membership] = await db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.userId, user.id), eq(organizationMembers.organizationId, orgId)));

    if (!membership) return res.status(403).json({ error: "Not a member of this organization" });
    if (!roles.includes(membership.role as Role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(" or ")}` });
    }
    next();
  };
}

// ─── User + Org Helpers ───────────────────────────────────────────────────────

export async function getUserOrg(userId: number): Promise<{ org: Organization; membership: OrganizationMember } | null> {
  const [membership] = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));
  if (!membership) return null;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, membership.organizationId));
  if (!org) return null;
  return { org, membership };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function generateInviteToken(): string {
  return nanoid(32);
}

export function generateEmailVerificationToken(): string {
  return nanoid(48);
}

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

// ─── Signup: create user + org atomically ────────────────────────────────────
export async function signupUser(
  email: string,
  password: string,
  name: string,
  orgName: string,
  options?: {
    skipEmailVerification?: boolean;
  }
): Promise<{ user: User; org: Organization; membership: OrganizationMember }> {
  // Check email taken
  const [existing] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (existing) throw new Error("Email already in use");

  const passwordHash = await hashPassword(password);
  const initials = name.split(" ").map(p => p[0]).join("").toUpperCase().slice(0, 2);

  // Create user
  const [user] = await db.insert(users).values({
    email: email.toLowerCase(),
    passwordHash,
    name,
    avatarInitials: initials,
    isEmailVerified: options?.skipEmailVerification ? true : false,
  }).returning();

  // Generate unique slug
  let slug = generateSlug(orgName);
  const [existingOrg] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (existingOrg) slug = `${slug}-${nanoid(4)}`;

  // Create organization
  const [org] = await db.insert(organizations).values({
    name: orgName,
    slug,
    plan: "starter",
    maxUsers: 5,
  }).returning();

  // Add user as Admin
  const [membership] = await db.insert(organizationMembers).values({
    organizationId: org.id,
    userId: user.id,
    role: "Admin",
  }).returning();

  return { user, org, membership };
}

export async function createEmailVerificationForUser(user: Pick<User, "id" | "email">): Promise<{ token: string; expiresAt: Date }> {
  await db.delete(emailVerifications).where(eq(emailVerifications.userId, user.id));
  const token = generateEmailVerificationToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(emailVerifications).values({
    userId: user.id,
    email: user.email,
    token,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function verifyEmailByToken(token: string): Promise<{ ok: boolean; reason?: string; userId?: number }> {
  if (!token || token.length < 20) return { ok: false, reason: "invalid-token" };
  const [row] = await db.select().from(emailVerifications).where(eq(emailVerifications.token, token));
  if (!row) return { ok: false, reason: "invalid-token" };
  if (row.verifiedAt) return { ok: true, userId: row.userId };
  if (row.expiresAt < new Date()) return { ok: false, reason: "expired" };

  await db.update(users).set({ isEmailVerified: true, updatedAt: new Date() }).where(eq(users.id, row.userId));
  await db.update(emailVerifications).set({ verifiedAt: new Date() }).where(eq(emailVerifications.id, row.id));
  return { ok: true, userId: row.userId };
}

export async function resendEmailVerification(email: string): Promise<{ sent: boolean; token?: string }> {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized) return { sent: false };
  const [user] = await db.select().from(users).where(eq(users.email, normalized));
  if (!user) return { sent: false };
  if (user.isEmailVerified) return { sent: true };

  const [existingActive] = await db.select().from(emailVerifications).where(and(
    eq(emailVerifications.userId, user.id),
    gt(emailVerifications.expiresAt, new Date()),
  ));
  if (existingActive && !existingActive.verifiedAt) {
    return { sent: true, token: existingActive.token };
  }

  const created = await createEmailVerificationForUser(user);
  return { sent: true, token: created.token };
}

// ─── Invite flow ─────────────────────────────────────────────────────────────
export async function createInvitation(
  orgId: number,
  email: string,
  role: Role,
  invitedById: number
): Promise<Invitation & { inviteUrl: string }> {
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [inv] = await db.insert(invitations).values({
    organizationId: orgId,
    email: email.toLowerCase(),
    role,
    token,
    invitedById,
    expiresAt,
  }).returning();

  const inviteUrl = `${process.env.APP_URL ?? "http://localhost:5000"}/accept-invite?token=${token}`;
  return { ...inv, inviteUrl };
}

export async function acceptInvitation(
  token: string,
  userId: number
): Promise<{ org: Organization; membership: OrganizationMember }> {
  const [inv] = await db.select().from(invitations).where(eq(invitations.token, token));
  if (!inv) throw new Error("Invalid invitation token");
  if (inv.acceptedAt) throw new Error("Invitation already used");
  if (inv.expiresAt < new Date()) throw new Error("Invitation expired");

  const [org] = await db.select().from(organizations).where(eq(organizations.id, inv.organizationId));
  if (!org) throw new Error("Organization not found");

  // Check if already a member
  const [existing] = await db.select().from(organizationMembers).where(
    and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, org.id))
  );

  let membership: OrganizationMember;
  if (existing) {
    membership = existing;
  } else {
    const [created] = await db.insert(organizationMembers).values({
      organizationId: org.id,
      userId,
      role: inv.role,
      invitedById: inv.invitedById,
    }).returning();
    membership = created;
  }

  // Mark invitation as accepted
  await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));

  return { org, membership };
}

// Augment Express types
declare global {
  namespace Express {
    interface User {
      id: import("@shared/schema").User["id"];
      email: import("@shared/schema").User["email"];
      passwordHash: import("@shared/schema").User["passwordHash"];
      name: import("@shared/schema").User["name"];
      avatarInitials: import("@shared/schema").User["avatarInitials"];
      isEmailVerified: import("@shared/schema").User["isEmailVerified"];
      createdAt: import("@shared/schema").User["createdAt"];
      updatedAt: import("@shared/schema").User["updatedAt"];
    }
  }
}

// Re-export Invitation type (fix circular import)
type Invitation = import("@shared/schema").Invitation;
