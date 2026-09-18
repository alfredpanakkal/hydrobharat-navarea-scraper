"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { NavWarning } from "@/lib/types";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-zinc-500">
      Loading map…
    </div>
  ),
});

const SOURCES = [
  { value: "hydrobharat-gov-in", label: "Hydrobharat (India)" },
  { value: "ccg-navareas-map", label: "CCG Navareas Map" },
  { value: "uk-admiralty-html", label: "UK Admiralty" },
  { value: "kystverket-navarea-19", label: "Norway (Navarea 19)" },
  { value: "ukho-navarea-1", label: "UKHO Navarea 1" },
  { value: "ihm-navarea-3", label: "IHM Navarea 3" },
  { value: "amsa-navarea-10", label: "AMSA Navarea 10" },
  { value: "nga-navarea-4-12", label: "NGA (NAVAREA IV/XII)" },
  { value: "bulk-ai-test", label: "Bulk AI Test" },
  { value: "manual-paste-workflow", label: "Manual Paste" },
];

async function loadWarnings(src: string): Promise<NavWarning[]> {
  const params = new URLSearchParams();
  if (src && src !== "all") params.set("source", src);
  const qs = params.toString();
  const res = await fetch(`/api/warnings${qs ? `?${qs}` : ""}`);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error ?? `Request failed (${res.status})`);
  }
  return (json.data ?? []) as NavWarning[];
}

export default function Home() {
  const [source, setSource] = useState("hydrobharat-gov-in");
  const [warnings, setWarnings] = useState<NavWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadWarnings(source);
        if (cancelled) return;
        setWarnings(rows);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load warnings");
        setWarnings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const handleSourceChange = useCallback(
    (value: string) => {
      setError(null);
      setLoading(true);
      setSource(value);
    },
    []
  );

  const hasSpatial = warnings.some((w) => (w.spatial ?? []).length > 0);

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-zinc-950 text-zinc-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">
            NAVAREA Warnings Map
          </h1>
          <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300">
            {loading ? "…" : `${warnings.length} row${warnings.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          Source
          <select
            value={source}
            onChange={(e) => handleSourceChange(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            <option value="all">All sources</option>
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main className="relative flex-1">
        <div className="absolute inset-0">
          {error ? (
            <div className="flex h-full w-full items-center justify-center p-8 text-center text-sm text-red-400">
              {error}
            </div>
          ) : (
            <MapView warnings={hasSpatial ? warnings : []} />
          )}
        </div>
        {!error && (
          <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-zinc-800 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-300">
            <div className="mb-1 font-semibold text-zinc-400">Risk level</div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500" /> HIGH
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-orange-500" /> REVIEW
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-blue-500" /> NORMAL
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-zinc-500" /> OTHER
            </div>
          </div>
        )}
      </main>
    </div>
  );
}