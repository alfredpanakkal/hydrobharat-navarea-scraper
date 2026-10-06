import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

serve(async (req) => {
  console.info("🚀 India Navarea Scraper started...");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
  if (!SERVICE_ROLE_KEY) return new Response("Missing Secrets", { status: 500 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const targetUrl = "https://hydrobharat.gov.in/navarea-warnings";
    
    // 1. Fetch the HTML
    const res = await fetch(targetUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      }
    });
    const html = await res.text();
    
    // 2. Load HTML into Cheerio
    const $ = cheerio.load(html);
    const recordsToSave: any[] = [];

    // 3. Extract Data (Standard Government Table Parser)
    // Government sites almost always use <table> tags for this kind of data.
    // We look for every table row inside the main content area.
    $('table tr').each((index, element) => {
      // Get all columns in the row
      const columns = $(element).find('td');
      
      if (columns.length >= 3) { // Make sure it's a data row, not a header
        // Typically: Col 1 = Number/ID, Col 2 = Date, Col 3 = Description
        // You may need to adjust these indexes based on the actual website!
        const warningId = $(columns[0]).text().trim();
        const dateStr = $(columns[1]).text().trim();
        const description = $(columns[2]).text().trim().replace(/\s+/g, ' '); // Clean up extra spaces

        // Only save if we actually got text
        if (warningId && description) {
          recordsToSave.push({
            source_id: "india-hydrobharat-html",
            warning_id: warningId,
            title: warningId, 
            raw_text: description,
            issued_text: dateStr,
            navarea: "VIII-IX", // India coordinates NAVAREA VIII and IX
            area_text: "Indian Ocean",
            authority: "National Hydrographic Office (India)",
            source_url: targetUrl,
            risk_level: description.toLowerCase().includes("firing") || description.toLowerCase().includes("hazard") ? "high" : "medium",
            extraction_method: "html_cheerio",
          });
        }
      }
    });

    // Deduplicate just in case
    const uniqueRecords: any[] = [];
    const seenIds = new Set();
    for (const rec of recordsToSave) {
      if (!seenIds.has(rec.warning_id)) {
        seenIds.add(rec.warning_id);
        uniqueRecords.push(rec);
      }
    }

    console.info(`💾 Saving ${uniqueRecords.length} India warnings...`);

    // 4. Save to Supabase
    if (uniqueRecords.length > 0) {
      const { error } = await supabase
        .from("nav_warnings")
        .upsert(uniqueRecords, { onConflict: 'source_id,warning_id' });
      if (error) throw error;
    }

    return new Response(JSON.stringify({ success: true, saved: uniqueRecords.length }));
  } catch (err) {
    console.error("Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});