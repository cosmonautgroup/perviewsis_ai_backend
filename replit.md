# Perviewsis

## Overview

Perviewsis is an AI-Powered Observability & Incident Intelligence Platform designed to integrate with APM tools like AppDynamics and Dynatrace. It offers comprehensive dashboards for applications and infrastructure, AI-driven incident analysis, root cause identification, predictive forecasting, and OpenTelemetry pipeline simulation. The platform aims to provide persona-based views for business and SRE teams, alongside enterprise management features. It is built as a monorepo with a React frontend (Vite) and a Node.js/Express backend, ensuring type-safe communication via shared schemas.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend

- **Framework**: React 18 with Vite.
- **Routing**: `wouter` for client-side navigation.
- **State Management**: TanStack React Query v5 for API calls via custom hooks.
- **UI**: shadcn/ui (New York style) customized with Tailwind CSS for theming (light/dark mode).
- **Charting**: Recharts, integrated through shadcn/ui.
- **Forms**: React Hook Form with Zod for validation.
- **Core Pages**: Includes dashboards for applications, incidents, capacity planning, OpenTelemetry, persona-based views, and platform management (profile, integrations, subscription).
- **AI-Powered Capacity Planning**: Features a global dashboard, detailed risk analysis pages with scenario selection and correlation, application-level capacity views, and Kubernetes cluster capacity management. Includes bidirectional navigation for capacity risks from incident and alert details.
- **Shared Correlation Components**: Universal context bar, SVG-based visual correlation graph, and AI-driven correlation insight panels are provided for detailed entity analysis.

### Backend

- **Runtime**: Node.js with TypeScript (Express 5).
- **Data Storage**: PostgreSQL via Drizzle ORM for all persistent data (APM sync tables, users, orgs, sessions). `MemStorage` is a minimal stub returning empty data for any endpoints not yet backed by real DB queries — no hardcoded mock data.
- **APM Integration**: Dedicated services for AppDynamics and Dynatrace API communication. AppDynamics auth format: `{username}@{account}:{password}`. Real API clients in `server/services/appDynamics.ts` and `server/services/dynatrace.ts`.
- **Sync Service**: Background service running every 1 minute. Syncs: applications, servers, health-rule alerts, incidents, business transactions (`apm_transactions`), and error events (`apm_errors`). `syncSource` auto-resolves DB credentials when no credentialId specified.
- **Org-Scoped Real Data**: All API endpoints return real DB data scoped to the authenticated user's org credentials. Returns empty arrays/404 when no credentials configured. Profile is fully DB-backed via `req.user`.
- **Authentication**: Multi-tenant session-based authentication using `express-session`, `connect-pg-simple` (requires `session` table in DB), and `passport` with `passport-local` strategy. Supports distinct roles (Admin, SRE, Business Viewer) and manages organizations, users, and invitations.
- **API Structure**: Type-safe API routes defined in a shared layer using Zod schemas for end-to-end type safety.
- **No Demo Accounts**: All seed scripts removed (`auto-seed.ts`, `seed-showcase.ts`, `seed-demo.ts`). No hardcoded test users, orgs, or APM data. Production-ready: users must sign up and connect their own APM controllers.

### Shared Layer

- **Schema Definition**: Zod schemas for all data types and API contracts, ensuring type safety across frontend and backend.
- **API Routes**: Centralized definition of all API endpoints with input/output schemas.

### Build System

- **Development**: `tsx` for direct TypeScript execution.
- **Production**: Vite for frontend bundling, `esbuild` for server bundling into a single CJS file.

## External Dependencies

### Core Technologies
- `express`: HTTP server.
- `react`, `react-dom`: UI framework.
- `vite`: Frontend build tool.
- `tsx`, `esbuild`: TypeScript execution and bundling.

### Database
- `drizzle-orm`, `drizzle-kit`: ORM and migration.
- `pg`: PostgreSQL client.
- `connect-pg-simple`: PostgreSQL session store.
- **Requirement**: `DATABASE_URL` environment variable for PostgreSQL connection.

### UI & Styling
- `tailwindcss`, `autoprefixer`, `postcss`: CSS framework.
- `@radix-ui/*`: Headless UI primitives.
- `lucide-react`: Icon library.
- `recharts`: Charting.
- `embla-carousel-react`, `vaul`, `cmdk`, `react-resizable-panels`, `react-day-picker`, `input-otp`: UI components.

### Forms & Validation
- `react-hook-form`: Form management.
- `@hookform/resolvers`: Zod integration for forms.
- `zod`, `drizzle-zod`: Schema validation.

### Data Fetching
- `@tanstack/react-query`: Server state management.

### Routing
- `wouter`: Lightweight client-side router.

### Utilities
- `date-fns`: Date manipulation.
- `nanoid`: Unique ID generation.
- `axios`: HTTP client.
- `memorystore`: In-memory session store.

### Authentication
- `passport`, `passport-local`, `bcrypt`: User authentication.

### AI / Ollama
- `ollama`: Official Ollama JS client for local LLM inference.
- **Host**: `http://localhost:11434` (default) — overridable via `OLLAMA_HOST` env var.
- **Model**: `llama3.2` (default) — overridable via `OLLAMA_MODEL` env var.
- **Required setup**: Run `ollama serve` and `ollama pull llama3.2` on the host machine before using AI features.
- **5 AI modules**: Causal & Predictive, Root Cause Analysis, Correlation Insights, Recommendations, Service Risk Rankings.
- **Service files**: `server/services/ollama.service.ts` (low-level wrapper), `server/services/ai.service.ts` (feature logic).
- **Endpoints**: All `POST /api/ai/*` — auth-gated, org-scoped, return structured JSON.
- **Graceful errors**: Returns HTTP 503 with a clear message when Ollama is unreachable.

### Fonts
- Google Fonts (DM Sans, Fira Code, Geist Mono, Architects Daughter) via CDN.

## AI Modules — Setup & Usage

### Installation

```bash
# Install Ollama (macOS/Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Start the Ollama server
ollama serve

# Pull the default model
ollama pull llama3.2

# (Optional) Pull embedding model for RAG workflows
ollama pull nomic-embed-text
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Model used for chat/generate |

### API Endpoints

| Endpoint | Description | Key Input |
|---|---|---|
| `POST /api/ai/causal-predictive` | Causal chain discovery + 72h predictions | None (uses all org APM data) |
| `POST /api/ai/root-cause` | Root cause analysis with probability scores | `{ incidentContext?: string }` |
| `POST /api/ai/correlation-insights` | Hidden correlation discovery | None |
| `POST /api/ai/recommendations` | Prioritised remediation actions | `{ rootCauseSummary?: string }` |
| `POST /api/ai/service-risk-ranking` | Services ranked by composite risk score | None |
| `GET /api/ai/health` | Ollama connectivity check + model list | None |

### Standard Response Schema

All AI endpoints return:

```json
{
  "summary": "string",
  "confidence": 0.0,
  "recommendations": [
    { "action": "string", "impact": "string", "priority": "high|medium|low" }
  ],
  "relatedIssues": [
    { "service": "string", "issueId": "string", "severity": "string" }
  ]
}
```

Plus module-specific fields (causalChains, rootCauseDetails, correlations, rankings, etc.).