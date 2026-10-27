export interface PdfFixturePage {
  lines?: Array<{ text: string; x: number; y: number; size?: number }>;
  image?: boolean;
}

/** Real PDF objects/xref, with controllable text positions and an image-only page. */
export function translationPdf(pages: PdfFixturePage[] = [
  { lines: [{ text: 'Introduction', x: 50, y: 780, size: 18 }, { text: 'The experiment uses 12 samples [1].', x: 50, y: 730 }] },
  { lines: [{ text: 'Results', x: 50, y: 780, size: 18 }, { text: 'The measurements do not prove causation.', x: 50, y: 730 }] },
]): Buffer {
  const objects: string[] = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const children: number[] = [];
  for (const page of pages) {
    const pageId = objects.length + 1;
    const streamId = pageId + 1;
    children.push(pageId);
    let stream = (page.lines ?? []).map(line => {
      const escaped = line.text.replace(/[\\()]/g, value => `\\${value}`);
      return `BT /F1 ${line.size ?? 12} Tf 1 0 0 1 ${line.x} ${line.y} Tm (${escaped}) Tj ET\n`;
    }).join('');
    // A valid inline RGB image makes this a scanned/image page without text objects.
    if (page.image) stream += 'q 400 0 0 600 50 100 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /ASCIIHexDecode ID 334455> EI Q\n';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${children.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
