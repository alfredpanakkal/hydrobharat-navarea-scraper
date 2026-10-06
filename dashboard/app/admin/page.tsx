import { supabase } from "@/lib/supabase";
import AdminWarningsTable from "./AdminWarningsTable";

export const dynamic = "force-dynamic";

interface AdminWarningRow {
  id: string;
  warning_id: string;
  source_id: string;
  title: string | null;
  revision: number | null;
  spatial: unknown[] | null;
  extraction_method: string | null;
  risk_level: string | null;
  is_cancelled: boolean | null;
  last_seen_at: string | null;
  updated_at: string | null;
  raw_text: string | null;
}

export default async function AdminPage() {
  const { data, error } = await supabase
    .from("nav_warnings_admin")
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
          <div>
            <span className="text-lg font-medium">Total: {warnings.length}</span>
          </div>
          <div>
            <span className="text-lg font-medium">Active: {activeCount}</span>
          </div>
          <div>
            <span className="text-lg font-medium">Cancelled: {cancelledCount}</span>
          </div>
          <div>
            <span className="text-lg font-medium">High Risk: {highRiskCount}</span>
          </div>
          <div>
            <span className="text-lg font-medium">With Geometry: {withSpatial}</span>
          </div>
        </div>
      </header>

      <AdminWarningsTable warnings={warnings} />

      <footer className="mt-4 text-xs text-zinc-600">
        Showing latest {warnings.length} rows from{" "}
        <code className="rounded bg-zinc-900 px-1 py-0.5">nav_warnings_admin</code>{" "}
        via the <code className="rounded bg-zinc-900 px-1 py-0.5">nav_warnings_admin</code>{" "}
        view.
      </footer>
    </div>
  );
}