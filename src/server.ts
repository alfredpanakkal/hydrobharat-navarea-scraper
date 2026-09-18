import { LiferayClient } from './services/liferay';
import { extractTextFromPdf } from './utils/pdfExtractor';
import { CoordinateParser } from './utils/coordinateParser';
import { extractBatchWithLLM } from './utils/llmParser';
import { DatabaseService } from './services/api';
import { alert } from './utils/alert';
import { CONFIG } from './config';

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

    // Extract warning_id from document title
    const warnings = documents.map((doc) => {
      // Extract warning ID from title like "Inforce_Navarea Warn_mu6wnrsl9.pdf"
      const match = doc.title.match(/Warn[_ ]([a-z0-9]+)/i);
      const warningId = match ? match[1] : `doc-${doc.id}`;
      return { ...doc, warningId };
    });

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

      // Download and extract PDF text
      console.log(`[Pipeline] Processing: ${w.title}`);
      const pdfBuffer = await liferay.downloadPdf(w);
      const rawText = await extractTextFromPdf(pdfBuffer);

      const checksum = parser.generateChecksum(rawText);
      const prev = existing.get(w.warningId);

      // Unchanged → touch timestamp only
      if (prev && prev.checksum === checksum) {
        await db.touch(w.warningId);
        continue;
      }

      const parsed = parser.parse(rawText);
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

      // Rate limit: 1 request per second
      await new Promise((r) => setTimeout(r, 1000));
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

      const llmResult = await extractBatchWithLLM(
        batch.map((b) => ({ warning_id: b.warning_id, raw_text: b.raw_text }))
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

      // Gentle rate limit
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Upsert all ready rows
    for (const row of ready) {
      await db.upsertWarning(row, existing.get(row.warning_id));
      upserted++;
    }

    // Mark missing as cancelled
    await db.markMissingAsCancelled(warnings.map((w) => w.warningId));

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
