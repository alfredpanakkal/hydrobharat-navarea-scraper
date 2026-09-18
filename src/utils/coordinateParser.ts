import { createHash } from 'crypto';

export interface Geometry {
  type: 'point' | 'polygon' | 'line' | 'circle';
  coords: Array<{ lat: number; lon: number }>;
  radius_nm?: number;
  spatial_group_id?: string;
}

export interface ParsedCoordinates {
  geometries: Geometry[];
  risk_level: 'NORMAL' | 'REVIEW' | 'HIGH';
  extraction_method: 'deterministic';
  confidence_score: number;
  evidence_trail: Array<{ rule: string; match: string }>;
  is_cancelled: boolean;
  cancellation_text: string | null;
  valid_until_utc: Date | null;
}

// NAVAREA VIII approximate bounds
const NAVAREA_BOUNDS = { latMin: -10, latMax: 30, lonMin: 30, lonMax: 100 };

const COORD_PATTERNS = [
  // Hyphenated Deg-Min: 12-34.5N 074-12.3E
  {
    name: 'hyphenated-deg-min',
    regex: /(\d{1,2})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: (m[1] !== '0' ? parseFloat(m[1]) : 0) + parseFloat(m[2]) / 60 * (m[3].toUpperCase() === 'S' ? -1 : 1),
      lon: (m[4] !== '0' ? parseFloat(m[4]) : 0) + parseFloat(m[5]) / 60 * (m[6].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
  // Space-separated Deg-Min: 12 34.5N 074 12.3E
  {
    name: 'space-deg-min',
    regex: /(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: parseFloat(m[1]) + parseFloat(m[2]) / 60 * (m[3].toUpperCase() === 'S' ? -1 : 1),
      lon: parseFloat(m[4]) + parseFloat(m[5]) / 60 * (m[6].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
  // Concatenated Deg-Min: 1234.5N 07412.3E
  {
    name: 'concat-deg-min',
    regex: /(\d{2,4})(\d{2}(?:\.\d+)?)\s*([NS])\s+(\d{3,5})(\d{2}(?:\.\d+)?)\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => {
      const latDeg = Math.floor(parseFloat(m[1]) / 100);
      const latMin = parseFloat(m[1]) % 100 + parseFloat(m[2]) / 100;
      const lonDeg = Math.floor(parseFloat(m[4]) / 100);
      const lonMin = parseFloat(m[4]) % 100 + parseFloat(m[5]) / 100;
      return {
        lat: (latDeg + latMin / 60) * (m[3].toUpperCase() === 'S' ? -1 : 1),
        lon: (lonDeg + lonMin / 60) * (m[6].toUpperCase() === 'W' ? -1 : 1),
      };
    },
  },
  // DMS: 12°34'30"N 074°12'18"E
  {
    name: 'dms',
    regex: /(\d{1,2})[°](\d{1,2})['′](\d{1,2}(?:\.\d+)?)[\"″]?\s*([NS])\s+(\d{1,3})[°](\d{1,2})['′](\d{1,2}(?:\.\d+)?)[\"″]?\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: (parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600) * (m[4].toUpperCase() === 'S' ? -1 : 1),
      lon: (parseFloat(m[5]) + parseFloat(m[6]) / 60 + parseFloat(m[7]) / 3600) * (m[8].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
  // LAT/LONG labeled: LAT 12-34N LONG 074-12E
  {
    name: 'labeled',
    regex: /(?:LAT|纬)\s+(\d{1,2})-(\d{1,2})\s*([NS])\s+(?:LONG|经|LON)\s+(\d{1,3})-(\d{1,2})\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: (parseFloat(m[1]) + parseFloat(m[2]) / 60) * (m[3].toUpperCase() === 'S' ? -1 : 1),
      lon: (parseFloat(m[4]) + parseFloat(m[5]) / 60) * (m[6].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
  // Decimal degrees: 12.575N 74.205E
  {
    name: 'decimal-degrees',
    regex: /(\d{1,3}(?:\.\d+)?)\s*([NS])\s+(\d{1,3}(?:\.\d+)?)\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: parseFloat(m[1]) * (m[2].toUpperCase() === 'S' ? -1 : 1),
      lon: parseFloat(m[3]) * (m[4].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
];

const CANCEL_REGEX = /CANCEL\s+THIS\s+MSG\s+(\d{4})\s+UTC\s+(\w{3})\s+(\d{2})/i;
const RADIUS_REGEX = /(?:WITHIN|RADIUS)\s+(\d+(?:\.\d+)?)\s*(?:NM|KM|NAUTICAL\s*MILES)/i;
const BOUNDED_BY_REGEX = /BOUNDED\s+BY/i;
const JOINING_REGEX = /JOINING/i;

function isValidCoord(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function isWithinNavarea(lat: number, lon: number): boolean {
  return (
    lat >= NAVAREA_BOUNDS.latMin &&
    lat <= NAVAREA_BOUNDS.latMax &&
    lon >= NAVAREA_BOUNDS.lonMin &&
    lon <= NAVAREA_BOUNDS.lonMax
  );
}

export class CoordinateParser {
  parse(text: string): ParsedCoordinates {
    const geometries: Geometry[] = [];
    const evidence_trail: Array<{ rule: string; match: string }> = [];
    let risk_level: 'NORMAL' | 'REVIEW' | 'HIGH' = 'NORMAL';

    // Extract coordinates using all patterns
    for (const pattern of COORD_PATTERNS) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(text)) !== null) {
        const { lat, lon } = pattern.parse(match);
        if (!isValidCoord(lat, lon)) continue;

        evidence_trail.push({ rule: pattern.name, match: match[0] });

        if (!isWithinNavarea(lat, lon)) {
          risk_level = 'REVIEW';
        }

        geometries.push({
          type: 'point',
          coords: [{ lat, lon }],
        });
      }
    }

    // Detect radius
    const radiusMatch = text.match(RADIUS_REGEX);
    if (radiusMatch && geometries.length > 0) {
      const radius = parseFloat(radiusMatch[1]);
      const isKm = /KM/i.test(radiusMatch[0]);
      const radius_nm = isKm ? radius * 0.539957 : radius;
      geometries[0].type = 'circle';
      geometries[0].radius_nm = radius_nm;
      evidence_trail.push({ rule: 'radius', match: radiusMatch[0] });
    }

    // Detect polygon (BOUNDED BY)
    if (BOUNDED_BY_REGEX.test(text) && geometries.length >= 3) {
      const polygonCoords = geometries.map((g) => g.coords[0]);
      polygonCoords.push(polygonCoords[0]); // ring closure
      geometries.length = 0;
      geometries.push({
        type: 'polygon',
        coords: polygonCoords,
        spatial_group_id: `poly-${Date.now()}`,
      });
      evidence_trail.push({ rule: 'polygon', match: 'BOUNDED BY' });
    }

    // Detect linestring (JOINING)
    if (JOINING_REGEX.test(text) && geometries.length >= 2) {
      const lineCoords = geometries.map((g) => g.coords[0]);
      geometries.length = 0;
      geometries.push({
        type: 'line',
        coords: lineCoords,
      });
      evidence_trail.push({ rule: 'linestring', match: 'JOINING' });
    }

    // Cancellation extraction
    let is_cancelled = false;
    let cancellation_text: string | null = null;
    let valid_until_utc: Date | null = null;

    const cancelMatch = text.match(CANCEL_REGEX);
    if (cancelMatch) {
      is_cancelled = true;
      cancellation_text = cancelMatch[0];
      const day = cancelMatch[1].slice(0, 2);
      const hour = cancelMatch[1].slice(2, 4);
      const monthMap: Record<string, number> = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
      };
      const month = monthMap[cancelMatch[2].toUpperCase()] ?? 0;
      const year = 2000 + parseInt(cancelMatch[3]);
      valid_until_utc = new Date(Date.UTC(year, month, parseInt(day), parseInt(hour)));
    }

    return {
      geometries,
      risk_level,
      extraction_method: 'deterministic',
      confidence_score: geometries.length > 0 ? 0.99 : 0,
      evidence_trail,
      is_cancelled,
      cancellation_text,
      valid_until_utc,
    };
  }

  generateChecksum(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim().toUpperCase();
    return createHash('sha256').update(normalized).digest('hex');
  }
}
