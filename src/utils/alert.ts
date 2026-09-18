import { CONFIG } from '../config';

export async function alert(message: string): Promise<void> {
  console.error('[ALERT]', message);
  if (!CONFIG.ALERT_WEBHOOK) return;

  try {
    await fetch(CONFIG.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `HydroBharat scraper: ${message}` }),
    });
  } catch (e) {
    console.error('Alert send failed:', e);
  }
}
