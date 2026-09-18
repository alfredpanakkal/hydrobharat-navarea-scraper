import { z } from 'zod';

export const GeomSchema = z.object({
  warning_id: z.string(),
  geometries: z.array(
    z.object({
      type: z.enum(['point', 'polygon', 'line', 'circle']),
      coords: z.array(
        z.object({
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
        })
      ),
      radius_nm: z.number().optional(),
    })
  ),
});

export type GeomResult = z.infer<typeof GeomSchema>;

const SYSTEM_PROMPT = `Extract maritime navigation coordinates from the warning text.
Return a JSON array of objects, each with:
- warning_id: the identifier string
- geometries: array of { type: "point"|"polygon"|"line"|"circle", coords: [{lat, lon}], radius_nm? }

Types:
- point: single coordinate
- polygon: 3+ coordinates forming a closed ring (last = first)
- line: 2+ coordinates for a track/route
- circle: center point + radius_nm

Rules:
- lat range: -90 to 90
- lon range: -180 to 180
- Return ONLY the JSON array, no markdown fences, no explanation
- If no coordinates found, return empty array for geometries`;

function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

async function callMistral(items: Array<{ warning_id: string; raw_text: string }>): Promise<GeomResult[] | null> {
  const { Mistral } = await import('@mistralai/mistralai');
  const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

  const content = items.map((i) => `[${i.warning_id}]: ${i.raw_text}`).join('\n\n');

  const response = await client.chat.complete({
    model: 'mistral-small-latest',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    temperature: 0,
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') return null;

  const cleaned = stripMarkdownFences(text);
  const parsed = JSON.parse(cleaned);
  const result = GeomSchema.array().safeParse(parsed);
  return result.success ? result.data : null;
}

async function callGemini(items: Array<{ warning_id: string; raw_text: string }>): Promise<GeomResult[] | null> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
  const model = genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

  const content = items.map((i) => `[${i.warning_id}]: ${i.raw_text}`).join('\n\n');

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${content}` }] }],
  });

  const text = result.response.text();
  if (!text) return null;

  const cleaned = stripMarkdownFences(text);
  const parsed = JSON.parse(cleaned);
  const validated = GeomSchema.array().safeParse(parsed);
  return validated.success ? validated.data : null;
}

export async function extractBatchWithLLM(
  items: Array<{ warning_id: string; raw_text: string }>
): Promise<GeomResult[] | null> {
  // Try Mistral first
  if (process.env.MISTRAL_API_KEY) {
    try {
      const result = await callMistral(items);
      if (result && result.length > 0) return result;
    } catch (e) {
      console.error('Mistral failed:', e);
    }
  }

  // Fallback to Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const result = await callGemini(items);
      if (result && result.length > 0) return result;
    } catch (e) {
      console.error('Gemini failed:', e);
    }
  }

  return null;
}
