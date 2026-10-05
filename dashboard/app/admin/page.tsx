import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface AdminWarningRow {
  id: string;
  warning_id: string;
  source_id: string;
  title: string | null;
  raw_text: string | null;
  checksum: string | null;
  revision: number | null;
  spatial: unknown[] | null;
  extraction_method: string | null;
  confidence_score: number | null;
  risk_level: string | null;
  is_cancelled: boolean | null;
  cancellation_text: string | null;
  valid_until_utc: string | null;
  last_seen_at: string | null;
  updated_at: string | null;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function RiskBadge({ level }: { level: string | null }) {
  const base = "rounded-full px-2 py-0.5 text-xs font-medium";
  if (level === "HIGH")
    return <span className={`${base} bg-red-500/20 text-red-400`}>HIGH</span>;
  if (level === "REVIEW")
    return (
      <span className={`${base} bg-orange-500/20 text-orange-400`}>REVIEW</span>
    );
  return (
    <span className={`${base} bg-blue-500/20 text-blue-400`}>
      {level ?? "NORMAL"}
    </span>
  );
}

function Pill({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${className}`}
    >
      <span className="font-semibold">{value}</span>
      {label}
    </span>
  );
}

export default async function AdminPage() {
  const { data, error } = await supabase
    .from("nav_warnings")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(100);

  const warnings = (data ?? []) as AdminWarningRow[];

  const activeCount = warnings.filter((w) => !w.is_cancelled).length;
  const cancelledCount = warnings.filter((w) => w.is_cancelled).length;
  const highRiskCount = warnings.filter((w) => w.risk_level === "HIGH").length;
  const withSpatial = warnings.filter(
    (w) => Array.isArray(w.spatial) && w.spatial.length > 0
  ).length;

  return (
    <div className="min-h-dvh bg-zinc-950 p-6 text-zinc-100">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Pill
            label="total"
            value={warnings.length}
            className="border-zinc-700 bg-zinc-900 text-zinc-300"
          />
          <Pill
            label="active"
            value={activeCount}
            className="border-emerald-800 bg-emerald-500/10 text-emerald-400"
          />
          <Pill
            label="cancelled"
            value={cancelledCount}
            className="border-zinc-700 bg-zinc-900 text-zinc-500"
          />
          <Pill
            label="high-risk"
            value={highRiskCount}
            className="border-red-800 bg-red-500/10 text-red-400"
          />
          <Pill
            label="with geometry"
            value={withSpatial}
            className="border-blue-800 bg-blue-500/10 text-blue-400"
          />
        </div>
      </header>

      {error ? (
        <div className="mb-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          Query error: {error.message}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-800 text-sm">
          <thead className="bg-zinc-900">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Warning ID
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Source
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Risk
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Spatial
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Revision
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Method
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Last Seen
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                Updated
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800 bg-zinc-900/50">
            {warnings.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-8 text-center text-sm text-zinc-500"
                >
                  No warnings found.
                </td>
              </tr>
            ) : (
              warnings.map((w) => (
                <tr key={w.id ?? w.warning_id} className="hover:bg-zinc-800/50">
                  <td className="max-w-[14rem] truncate px-4 py-3 font-mono text-xs">
                    <span title={w.title ?? w.warning_id}>{w.warning_id}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-300">
                    {w.source_id}
                  </td>
                  <td className="px-4 py-3">
                    <RiskBadge level={w.risk_level} />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {w.is_cancelled ? (
                      <span className="text-zinc-500 line-through">
                        Cancelled
                      </span>
                    ) : (
                      <span className="text-emerald-400">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {Array.isArray(w.spatial) ? w.spatial.length : 0} item(s)
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {w.revision ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {w.extraction_method ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {formatDate(w.last_seen_at)}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {formatDate(w.updated_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <footer className="mt-4 text-xs text-zinc-600">
        Showing latest {warnings.length} rows from{" "}
        <code className="rounded bg-zinc-900 px-1 py-0.5">nav_warnings</code>{" "}
        table.
      </footer>
    </div>
  );
}
