import { useState } from "react";

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

const AdminWarningsTable: React.FC<AdminWarningsTableProps> = ({
  warnings,
  onRowExpandToggle,
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    onRowExpandToggle?.(id);
  };

  const columnCount = 9;

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
            &nbsp;
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
          warnings.map((w) => (
            <tr
              key={w.id ?? w.warning_id}
              className="hover:bg-zinc-800/50"
              onClick={() => toggleExpand(w.id)}
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
                {formatter(w.last_seen_at)}
              </td>
              <td className="px-4 py-3 text-xs text-zinc-400">
                {formatter(w.updated_at)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
};

/** Expanded row that appears below the clicked row */
const ExpandedRow = ({
  row,
  columnCount,
}: {
  row: AdminWarningRow;
  columnCount: number;
}) => {
  return (
    <tr>
      <td colSpan={columnCount} className="bg-muted/40 p-0">
        <pre
          className="whitespace-pre-wrap break-words max-h-96 overflow-y-auto
                      text-xs leading-relaxed p-4 m-2 rounded bg-background">
          {row.raw_text ?? "— no raw text —"}
        </pre>
        <div className="mt-2 text-xs text-zinc-500">
          {row.source_id} · {row.extraction_method} · {formatDate(row.last_seen_at)}
        </div>
      </td>
    </tr>
  );
});

/** Simple date formatter mirroring the server component's logic */
const formatter = (iso: string | null) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

export { AdminWarningsTable, ExpandedRow, AdminWarningRow };