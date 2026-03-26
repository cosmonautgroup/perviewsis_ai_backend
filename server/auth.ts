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
  users, organizations, organizationMembers, invitations,
  User, Organization, OrganizationMember, Role, ROLES,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Pool } from "pg";

// ─── Session ─────────────────────────────────────────────────────────────────
const PgStore = ConnectPgSimple(session);

export function setupSession(app: any) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  app.use(
    session({
      store: new PgStore({ pool, createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET ?? "perviewsis-dev-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === "production",
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
        const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
        if (!user) return done(null, false, { message: "Invalid email or password" });
        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) return done(null, false, { message: "Invalid email or password" });
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
    const [user] = await db.select().from(users).where(eq(users.id, id));
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
  orgName: string
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
    interface User extends import("@shared/schema").User {}
  }
}

// Re-export Invitation type (fix circular import)
type Invitation = import("@shared/schema").Invitation;
