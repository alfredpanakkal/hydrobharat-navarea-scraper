"use client";

import "leaflet/dist/leaflet.css";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Circle,
  Polygon,
  Polyline,
} from "react-leaflet";
import type { NavWarning, SpatialItem } from "@/lib/types";

const RISK_COLORS: Record<string, string> = {
  HIGH: "#ef4444",
  REVIEW: "#f97316",
  NORMAL: "#3b82f6",
};

function colorFor(risk: string | null): string {
  return RISK_COLORS[risk ?? ""] ?? "#71717a";
}

function positionsFor(item: SpatialItem): [number, number][] {
  return item.coords
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => [c.lat, c.lon]);
}

function GeometryLayer({ item, risk }: { item: SpatialItem; risk: string | null }) {
  const color = colorFor(risk);

  switch (item.type) {
    case "point": {
      const p = item.coords.find(
        (c) => Number.isFinite(c.lat) && Number.isFinite(c.lon)
      );
      if (!p) return null;
      return (
        <CircleMarker
          center={[p.lat, p.lon]}
          radius={6}
          pathOptions={{ color, fillColor: color, fillOpacity: 0.75 }}
        />
      );
    }
    case "circle": {
      const p = item.coords.find(
        (c) => Number.isFinite(c.lat) && Number.isFinite(c.lon)
      );
      const radius = (item.radius_nm ?? 0) * 1852;
      if (!p || radius <= 0) return null;
      return (
        <Circle
          center={[p.lat, p.lon]}
          radius={radius}
          pathOptions={{ color, fillColor: color, fillOpacity: 0.2 }}
        />
      );
    }
    case "polygon": {
      const positions = positionsFor(item);
      if (positions.length < 3) return null;
      return (
        <Polygon
          positions={positions}
          pathOptions={{ color, fillColor: color, fillOpacity: 0.25 }}
        />
      );
    }
    case "line": {
      const positions = positionsFor(item);
      if (positions.length < 2) return null;
      return <Polyline positions={positions} pathOptions={{ color, weight: 3 }} />;
    }
    default:
      return null;
  }
}

export default function MapView({ warnings }: { warnings: NavWarning[] }) {
  return (
    <MapContainer
      center={[18, 72]}
      zoom={5}
      scrollWheelZoom={false}
      className="h-full w-full"
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      {warnings.flatMap((w) =>
        (w.spatial ?? []).map((item, i) => (
          <GeometryLayer
            key={`${w.source_id}:${w.warning_id ?? w.id}:${i}`}
            item={item}
            risk={w.risk_level}
          />
        ))
      )}
    </MapContainer>
  );
}