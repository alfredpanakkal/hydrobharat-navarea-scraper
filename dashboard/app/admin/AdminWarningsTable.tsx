"use client";

import { Fragment, useState } from "react";

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

interface AdminWarningsTableProps {
  warnings: AdminWarningRow[];
  onRowExpandToggle?: (id: string) => void;
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

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function AdminWarningsTable({
  warnings,
  onRowExpandToggle,
}: AdminWarningsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
    onRowExpandToggle?.(id);
  };

  const columnCount = 10;

  return (
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
          <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
            <span className="sr-only">Expand</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-800 bg-zinc-900/50">
        {warnings.length === 0 ? (
          <tr>
            <td colSpan={columnCount} className="px-4 py-8 text-center text-sm text-zinc-500">
              No warnings found.
            </td>
          </tr>
        ) : (
          warnings.map((w) => {
            const rowId = w.id ?? w.warning_id;
            const isExpanded = expandedId === rowId;
            return (
              <Fragment key={rowId}>
                <tr
                  className="hover:bg-zinc-800/50"
                  onClick={() => toggleExpand(rowId)}
                  aria-expanded={isExpanded}
                >
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
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(rowId);
                      }}
                      className="text-zinc-400 hover:text-zinc-200"
                    >
                      {isExpanded ? "▼" : "▶"}
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={columnCount} className="bg-zinc-900/70 p-0">
                      <pre className="whitespace-pre-wrap break-words max-h-96 overflow-y-auto text-xs leading-relaxed p-4 m-2 rounded bg-zinc-950 text-zinc-200">
                        {w.raw_text ?? "— no raw text —"}
                      </pre>
                      <div className="px-4 pb-2 text-xs text-zinc-500">
                        {w.source_id} · {w.extraction_method} · {formatDate(w.last_seen_at)}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })
        )}
      </tbody>
    </table>
  );
}