import { CONFIG } from '../config';
import { AlertPayload } from '../types';

async function sendWebhook(body: { text: string }): Promise<void> {
  if (!CONFIG.ALERT_WEBHOOK) return;

  try {
    await fetch(CONFIG.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('Alert send failed:', e);
  }
}

export async function alert(message: string): Promise<void> {
  console.error('[ALERT]', message);
  await sendWebhook({ text: `HydroBharat scraper: ${message}` });
}

export async function alertWarning(w: AlertPayload): Promise<void> {
  console.error('[ALERT]', `HIGH RISK warning ${w.warning_id} (${w.risk_level}) — ${w.title}`);
  await sendWebhook({
    text:
      `⚠️ NAVAREA HIGH RISK: ${w.warning_id} (${w.risk_level}) — ${w.title}\n` +
      w.snippet.slice(0, 300),
  });
}

export async function sendHighRiskDigest(warnings: AlertPayload[]): Promise<void> {
  if (warnings.length === 0) return;
  if (warnings.length === 1) {
    await alertWarning(warnings[0]);
    return;
  }

  const header = `🔴 NAVAREA HIGH RISK DIGEST (${warnings.length} warnings detected)`;
  const lines = warnings.slice(0, 10).map((w) => `• ${w.warning_id} — ${w.title}`);
  const tail = warnings.length > 10 ? `... and ${warnings.length - 10} more` : '';
  const text = [header, ...lines, tail].filter(Boolean).join('\n');

  console.error('[ALERT]', `HIGH RISK digest: ${warnings.length} warnings`);
  await sendWebhook({ text });
}