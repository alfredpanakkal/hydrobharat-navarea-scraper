export interface LatLon {
  lat: number;
  lon: number;
}

export interface Geometry {
  type: 'point' | 'polygon' | 'line' | 'circle';
  coords: Array<{ lat: number; lon: number }>;
  radius_nm?: number;
  spatial_group_id?: string;
}

export interface EvidenceTrailItem {
  rule: string;
  match: string;
}

export interface ParsedCoordinates {
  geometries: Geometry[];
  risk_level: 'NORMAL' | 'REVIEW' | 'HIGH';
  extraction_method: 'deterministic';
  confidence_score: number;
  evidence_trail: EvidenceTrailItem[];
  is_cancelled: boolean;
  cancellation_text: string | null;
  valid_until_utc: Date | null;
}

export interface NavWarning {
  docId: string;
  warningId: string;
  title: string;
  sizeInBytes: number;
  contentUrl: string;
}

export interface AlertPayload {
  warning_id: string;
  risk_level: string;
  title: string;
  snippet: string;
}

export interface MapWarning {
  id: string;
  source_id: string;
  warning_id: string;
  spatial: Geometry[] | null;
  spatial_groups: unknown[] | null;
  risk_level: string | null;
  is_cancelled: boolean;
  last_seen_at: string;
  updated_at: string;
}