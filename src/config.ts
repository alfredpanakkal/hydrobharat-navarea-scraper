function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

export const CONFIG = {
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_KEY: required('SUPABASE_KEY'),
  LIFERAY_USER: required('LIFERAY_USER'),
  LIFERAY_PASS: required('LIFERAY_PASS'),
  LIFERAY_API_BASE: 'https://hydrobharat.gov.in/o/headless-delivery/v1.0',
  LIFERAY_FOLDER_ID: 288109, // Navarea Warnings folder
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY ?? '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  ALERT_WEBHOOK: process.env.ALERT_WEBHOOK ?? '',
  SOURCE_ID: 'hydrobharat-gov-in',
  MIN_EXPECTED_ROWS: 5,
  LLM_BATCH_SIZE: 10,
};
