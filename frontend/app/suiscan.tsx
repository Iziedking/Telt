// Shared Suiscan links so every on-chain id, transaction, and address in the app is traceable.
// Testnet by default; override with NEXT_PUBLIC_SUI_NETWORK if the deployment moves.
const NET = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";
const BASE = `https://suiscan.xyz/${NET}`;

export const suiscanObject = (id: string) => `${BASE}/object/${id}`;
export const suiscanTx = (digest: string) => `${BASE}/tx/${digest}`;
export const suiscanAccount = (addr: string) => `${BASE}/account/${addr}`;

export function shortHash(s: string, head = 6): string {
  return s && s.length > head + 5 ? `${s.slice(0, head)}…${s.slice(-4)}` : s;
}

// A clickable, shortened link to Suiscan for an object, transaction, or account.
export function SuiscanLink({
  kind,
  id,
  label,
  className,
}: {
  kind: "object" | "tx" | "account";
  id: string | null | undefined;
  label?: string;
  className?: string;
}) {
  if (!id) return null;
  const href = kind === "tx" ? suiscanTx(id) : kind === "account" ? suiscanAccount(id) : suiscanObject(id);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className ?? "suiscan-link"}
      title="View on Suiscan"
      onClick={(e) => e.stopPropagation()}
    >
      {label ?? shortHash(id)}
    </a>
  );
}
