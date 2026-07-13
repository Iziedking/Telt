-- Telt persistence. Three tables carry the demo: the hands played, every move and
-- its Avow anchor, and the intel purchases that drive the economy. Everything here
-- mirrors something provable on chain; the database is a fast read mirror, not the
-- source of truth.

-- A single heads-up hand at a table.
create table if not exists hands (
  id            bigserial primary key,
  table_id      text not null,            -- on-chain Table object id
  hand_index    integer not null,         -- 0-based within the match
  button        text not null,            -- 'A' or 'B'
  board         text[] not null default '{}',
  pot           bigint not null default 0,
  winner_seat   text,                     -- 'A', 'B', or 'split'
  winner_owner  text,                     -- winner's Sui address
  reason        text,                     -- 'fold' or 'showdown'
  created_at    timestamptz not null default now(),
  unique (table_id, hand_index)
);

-- One agent decision: the action, the chips, and its Avow anchor (blob + hash + tx).
create table if not exists moves (
  id            bigserial primary key,
  table_id      text not null,
  hand_id       bigint not null references hands(id) on delete cascade,
  street        text not null,            -- preflop | flop | turn | river
  seat          text not null,            -- 'A' or 'B'
  agent_id      text not null,            -- on-chain Agent object id
  action        text not null,            -- fold | check | call | raise
  amount        bigint not null default 0,
  rationale     text,                     -- the agent's plain-words reason
  samples       integer not null default 1,
  -- Avow anchor for this move.
  blob_id       text,                     -- Walrus blob id of the sealed bundle
  evidence_hash text,                     -- hex sha-256, as anchored on chain
  anchor_digest text,                     -- Sui tx digest of the anchor
  within_mandate boolean,
  created_at    timestamptz not null default now()
);

create index if not exists moves_hand_idx on moves(hand_id);
create index if not exists moves_agent_idx on moves(agent_id);

-- A paid intel purchase: a buyer paid for a dossier on a target, settled on Sui, and
-- the delivery itself was anchored through Avow.
create table if not exists intel_purchases (
  id             bigserial primary key,
  table_id       text not null,
  buyer_owner    text not null,           -- buyer's Sui address
  buyer_agent    text,                    -- buyer's Agent object id
  target_agent   text not null,           -- the opponent the dossier is about
  amount         bigint not null,         -- fee paid, in MIST
  pay_digest     text not null,           -- Sui tx digest of buy_intel
  receipt_id     text,                    -- IntelReceipt object id
  -- Avow anchor for the delivered dossier (sealed to the buyer).
  dossier_blob   text,
  dossier_hash   text,
  dossier_digest text,
  delivered_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (pay_digest)
);

create index if not exists intel_table_idx on intel_purchases(table_id);

-- Faucet claims, so the twice-a-week rate limit survives a restart (the in-memory map does not).
create table if not exists faucet_claims (
  id          bigserial primary key,
  address     text not null,            -- claimant Sui address, lowercased
  amount      bigint not null,          -- tUSDC minted
  digest      text,                     -- mint tx digest
  created_at  timestamptz not null default now()
);
create index if not exists faucet_addr_idx on faucet_claims(address, created_at);

-- Off-chain contest markers (join-window deadline, kind, difficulty) the contract does not record.
-- Persisted so a restart does not orphan an in-flight contest: on boot these are reloaded and the
-- sweeper can still run and settle a contest whose window closed while the process was down.
create table if not exists contest_markers (
  contest_id  text primary key,
  kind        text,                     -- 'custom' | 'challenge' | null (general)
  difficulty  text,
  ends_at     bigint,                   -- join-window deadline, epoch ms
  played_at   timestamptz,              -- it has been run; never run it again
  updated_at  timestamptz not null default now()
);
alter table contest_markers add column if not exists played_at timestamptz;
