export interface SpatialCoord {
  lat: number;
  lon: number;
}

export interface SpatialItem {
  type: "point" | "polygon" | "line" | "circle";
  coords: SpatialCoord[];
  radius_nm?: number;
}

export interface NavWarning {
  id: string;
  source_id: string;
  warning_id: string | null;
  spatial: SpatialItem[] | null;
  spatial_groups: unknown;
  risk_level: string | null;
  is_cancelled: boolean | null;
  last_seen_at: string | null;
  updated_at: string | null;
}