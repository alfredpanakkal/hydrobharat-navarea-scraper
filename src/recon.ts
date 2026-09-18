import { writeFileSync, mkdirSync } from 'fs';

const LIFERAY_USER = process.env.LIFERAY_USER ?? 'nho@liferay.com';
const LIFERAY_PASS = process.env.LIFERAY_PASS ?? 'Giks@2017';
const API_BASE = 'https://hydrobharat.gov.in/o/headless-delivery/v1.0';

async function recon() {
  mkdirSync('recon', { recursive: true });
  
  const auth = Buffer.from(`${LIFERAY_USER}:${LIFERAY_PASS}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
  };

  // Step 1: List document folders
  console.log('=== Document Folders ===');
  const foldersResp = await fetch(`${API_BASE}/sites/20117/document-folders?fields=id,name`, { headers });
  const folders = await foldersResp.json();
  console.log(`Found ${folders.totalCount} folders`);
  
  // Find Navarea Warnings folder
  const navFolder = folders.items.find((f: any) => f.name === 'Navarea Warnings');
  if (!navFolder) {
    console.error('Navarea Warnings folder not found!');
    return;
  }
  console.log(`Navarea Warnings folder ID: ${navFolder.id}`);

  // Step 2: List documents in folder
  console.log('\n=== Documents in Navarea Warnings ===');
  const docsResp = await fetch(
    `${API_BASE}/document-folders/${navFolder.id}/documents?pageSize=20&sort=dateCreated:desc&fields=id,title,dateCreated,contentUrl`,
    { headers }
  );
  const docs = await docsResp.json();
  console.log(`Total documents: ${docs.totalCount}`);
  console.log(`Page 1 of ${docs.lastPage}`);
  
  // Save full response
  writeFileSync('recon/api-response.json', JSON.stringify(docs, null, 2));
  
  // Step 3: Show sample documents
  console.log('\n=== Sample Documents ===');
  for (const doc of docs.items.slice(0, 5)) {
    console.log(`  ID: ${doc.id}, Title: ${doc.title}, Created: ${doc.dateCreated}`);
    console.log(`  URL: ${doc.contentUrl}`);
  }

  // Step 4: Download a sample PDF and extract text
  console.log('\n=== Sample PDF Content ===');
  const sampleDoc = docs.items[0];
  const pdfUrl = `https://hydrobharat.gov.in${sampleDoc.contentUrl}`;
  console.log(`Downloading: ${pdfUrl}`);
  
  const pdfResp = await fetch(pdfUrl, { 
    headers: { Authorization: `Basic ${auth}` }
  });
  
  if (pdfResp.ok) {
    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    writeFileSync('recon/sample.pdf', pdfBuffer);
    console.log(`Saved sample PDF: ${pdfBuffer.length} bytes`);
    
    // Extract text
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
    const pdfData = await parser.getText();
    console.log(`\nExtracted text (${pdfData.total} pages):`);
    console.log(pdfData.text.substring(0, 2000));
    writeFileSync('recon/sample-text.txt', pdfData.text);
  } else {
    console.error(`PDF download failed: ${pdfResp.status}`);
  }

  console.log('\nRecon complete. Check recon/ directory.');
}

recon().catch(console.error);
