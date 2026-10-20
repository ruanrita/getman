import postgres from "postgres";

export type Sql = postgres.Sql;

/**
 * Ordered migrations. Never edit one that has shipped: append a new entry.
 * Kept inline (not .sql files) so the bundled server is a single file.
 */
const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "init",
    sql: `
      create table users (
        id uuid primary key default gen_random_uuid(),
        email text not null unique,
        name text not null,
        password_hash text not null,
        totp_secret text,              -- AES-256-GCM encrypted, see crypto.ts
        totp_enabled boolean not null default false,
        created_at timestamptz not null default now()
      );

      create table recovery_codes (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users on delete cascade,
        code_hash text not null,
        used_at timestamptz
      );
      create index on recovery_codes (user_id);

      create table sessions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users on delete cascade,
        token_hash text not null unique,
        user_agent text,
        ip text,
        created_at timestamptz not null default now(),
        last_used_at timestamptz not null default now(),
        expires_at timestamptz not null
      );
      create index on sessions (user_id);

      create table mfa_challenges (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users on delete cascade,
        token_hash text not null unique,
        attempts int not null default 0,
        expires_at timestamptz not null
      );

      create table workspaces (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        require_2fa boolean not null default false,
        globals jsonb not null default '[]',
        globals_version int not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table members (
        workspace_id uuid not null references workspaces on delete cascade,
        user_id uuid not null references users on delete cascade,
        role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
        added_at timestamptz not null default now(),
        primary key (workspace_id, user_id)
      );
      create index on members (user_id);
      -- Exactly one owner per workspace.
      create unique index members_one_owner on members (workspace_id) where role = 'owner';

      create table collections (
        workspace_id uuid not null references workspaces on delete cascade,
        id uuid not null,
        data jsonb not null,
        version int not null default 1,
        updated_at timestamptz not null default now(),
        updated_by uuid references users on delete set null,
        primary key (workspace_id, id)
      );

      create table environments (
        workspace_id uuid not null references workspaces on delete cascade,
        id uuid not null,
        data jsonb not null,
        version int not null default 1,
        updated_at timestamptz not null default now(),
        updated_by uuid references users on delete set null,
        primary key (workspace_id, id)
      );

      create table audit_log (
        id bigserial primary key,
        workspace_id uuid not null references workspaces on delete cascade,
        actor_id uuid references users on delete set null,
        action text not null,
        details jsonb not null default '{}',
        created_at timestamptz not null default now()
      );
      create index on audit_log (workspace_id, id desc);
    `,
  },
];

export function connect(url: string): Sql {
  return postgres(url, {
    onnotice: () => {},
    // jsonb columns come back parsed; dates as Date objects.
    transform: { undefined: null },
  });
}

export async function migrate(sql: Sql): Promise<void> {
  await sql`create table if not exists schema_migrations (id int primary key, name text not null, applied_at timestamptz not null default now())`;
  // Serialise concurrent server starts.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727274)`;
    const applied = new Set((await tx<{ id: number }[]>`select id from schema_migrations`).map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await tx.unsafe(m.sql);
      await tx`insert into schema_migrations (id, name) values (${m.id}, ${m.name})`;
    }
  });
}
