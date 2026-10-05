import { LiferayClient } from './services/liferay';
import { extractTextFromPdf } from './utils/pdfExtractor';
import { CoordinateParser } from './utils/coordinateParser';
import { extractBatchWithLLM } from './utils/llmParser';
import { DatabaseService } from './services/api';
import { alert, sendHighRiskDigest } from './utils/alert';
import { CONFIG } from './config';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithRetry<T>(fn: () => Promise<T>, retries: number = 3, delay: number = 2000): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt === retries) throw err;
      console.warn(`[Retry] Attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
      await sleep(delay * attempt);
    }
  }
  throw new Error('Unreachable');
}

async function runPipeline() {
  const liferay = new LiferayClient();
  const parser = new CoordinateParser();
  const db = new DatabaseService();
  const started = new Date();
  let scraped = 0;
  let upserted = 0;
  let llmCalls = 0;

  try {
    console.log('[Pipeline] Fetching document list from Liferay API...');
    const documents = await liferay.listAllDocuments();
    scraped = documents.length;
    console.log(`[Pipeline] Found ${scraped} documents`);

    if (scraped < CONFIG.MIN_EXPECTED_ROWS) {
      throw new Error(
        `Only ${scraped} documents — below threshold ${CONFIG.MIN_EXPECTED_ROWS}`
      );
    }

    // Extract warning_id from document title, skip non-PDFs
    const warnings = documents
      .filter((doc) => doc.title.toLowerCase().endsWith('.pdf'))
      .map((doc) => {
        const match = doc.title.match(/Warn[_ ]([a-z0-9]+)/i);
        const warningId = match ? match[1] : `doc-${doc.id}`;
        return { ...doc, warningId };
      });
    console.log(`[Pipeline] ${warnings.length} PDF documents to process`);

    // Fetch existing state in one query
    const existing = await db.getExisting(warnings.map((w) => w.warningId));

    const needsLLM: any[] = [];
    const ready: any[] = [];

    for (const w of warnings) {
      // Skip if already processed and unchanged
      if (existing.has(w.warningId)) {
        await db.touch(w.warningId);
        continue;
      }

      // Download and extract PDF text with retry
      try {
        console.log(`[Pipeline] Processing: ${w.title}`);
        const pdfBuffer = await runWithRetry(() => liferay.downloadPdf(w));
        const rawText = await extractTextFromPdf(pdfBuffer);

        const checksum = parser.generateChecksum(rawText);
        const prev = existing.get(w.warningId);

        // Unchanged → touch timestamp only
        if (prev && prev.checksum === checksum) {
          await db.touch(w.warningId);
          continue;
        }

        const parsed = parser.parseMulti(rawText);
        const base = {
          warning_id: w.warningId,
          title: w.title,
          raw_text: rawText,
          checksum,
          ...parsed,
        };

        if (parsed.geometries.length > 0) {
          ready.push(base);
        } else {
          needsLLM.push(base);
        }
      } catch (err: any) {
        console.error(`[Pipeline] Failed to process ${w.title}: ${err.message}`);
        // Continue with next document instead of crashing
      }

      // Rate limit: 1 request per second
      await sleep(1000);
    }

    console.log(
      `[Pipeline] ${ready.length} ready, ${needsLLM.length} need LLM`
    );

    // Batched LLM extraction
    for (let i = 0; i < needsLLM.length; i += CONFIG.LLM_BATCH_SIZE) {
      const batch = needsLLM.slice(i, i + CONFIG.LLM_BATCH_SIZE);
      console.log(
        `[Pipeline] LLM batch ${Math.floor(i / CONFIG.LLM_BATCH_SIZE) + 1}/${Math.ceil(needsLLM.length / CONFIG.LLM_BATCH_SIZE)}`
      );

      try {
        const llmResult = await runWithRetry(() =>
          extractBatchWithLLM(
            batch.map((b) => ({ warning_id: b.warning_id, raw_text: b.raw_text }))
          )
        );
        llmCalls++;

        for (const item of batch) {
          const hit = llmResult?.find((r) => r.warning_id === item.warning_id);
          ready.push(
            hit
              ? {
                  ...item,
                  geometries: hit.geometries,
                  extraction_method: 'llm_assisted',
                  confidence_score: 0.92,
                }
              : {
                  ...item,
                  extraction_method: 'failed',
                  confidence_score: 0,
                  risk_level: 'HIGH',
                }
          );
        }
      } catch (err: any) {
        console.error(`[Pipeline] LLM batch failed: ${err.message}`);
        // Mark batch as failed
        for (const item of batch) {
          ready.push({
            ...item,
            extraction_method: 'failed',
            confidence_score: 0,
            risk_level: 'HIGH',
          });
        }
      }

      // Gentle rate limit
      await sleep(2000);
    }

    // Batch upsert all ready rows
    const BATCH_SIZE = 50;
    for (let i = 0; i < ready.length; i += BATCH_SIZE) {
      const batch = ready.slice(i, i + BATCH_SIZE);
      console.log(`[Pipeline] Upserting batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(ready.length / BATCH_SIZE)}`);
      await db.upsertWarningBatch(batch, existing);
      upserted += batch.length;
    }

    // Mark missing as cancelled
    await db.markMissingAsCancelled(warnings.map((w) => w.warningId));

    // Alert on newly processed HIGH risk warnings
    const newHighRisk = ready
      .filter((r) => !existing.has(r.warning_id) && r.risk_level === 'HIGH')
      .map((r) => ({
        warning_id: r.warning_id,
        risk_level: r.risk_level,
        title: r.title ?? r.warning_id,
        snippet: (r.raw_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      }));
    await sendHighRiskDigest(newHighRisk);

    // Alert on failures
    const failed = ready.filter((r) => r.extraction_method === 'failed').length;
    if (failed > 0) {
      await alert(`${failed} warnings failed geometry extraction`);
    }

    // Log successful run
    await db.logRun({
      started_at: started,
      finished_at: new Date(),
      rows_scraped: scraped,
      rows_upserted: upserted,
      llm_calls: llmCalls,
      status: 'ok',
    });

    console.log(
      `[Pipeline] Complete. ${upserted} upserted, ${llmCalls} LLM calls, ${failed} failures`
    );
  } catch (err: any) {
    console.error('[Pipeline] FAILED:', err.message);
    await alert(`Run FAILED: ${err.message}`);
    await db
      .logRun({
        started_at: started,
        finished_at: new Date(),
        rows_scraped: scraped,
        rows_upserted: upserted,
        llm_calls: llmCalls,
        status: 'error',
        error_text: err.message,
      })
      .catch(() => {});
    process.exit(1);
  }
}

runPipeline();
