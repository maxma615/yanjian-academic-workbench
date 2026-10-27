export interface MetadataPdfOptions {
  info?: Record<string, string>;
  xmp?: string;
  pages?: Array<{ lines?: Array<{ text: string; x: number; y: number; size?: number }>; image?: boolean }>;
}

/** Small real PDFs with Info / XMP and positioned text; never private source documents. */
export function metadataPdf(options: MetadataPdfOptions = {}): Buffer {
  const pages = options.pages ?? [{ lines: [
    { text: 'Working memory and learning', x: 50, y: 760, size: 22 },
    { text: 'Alice Smith1, Bob Jones2', x: 50, y: 715, size: 12 },
    { text: 'Department of Psychology, Example University', x: 50, y: 690, size: 10 },
    { text: 'Published online: 17 June 2022', x: 50, y: 655, size: 9 },
    { text: 'DOI: 10.1234/memory.2022.14', x: 50, y: 635, size: 9 },
    { text: 'Abstract', x: 50, y: 600, size: 12 },
    { text: 'The experiment tested a hypothesis about learning.', x: 50, y: 580, size: 10 },
  ] }];
  const objects: string[] = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids: number[] = [];
  const escape = (value: string) => value.replace(/[\\()]/g, match => `\\${match}`);
  for (const page of pages) {
    const id = objects.length + 1; kids.push(id);
    let stream = (page.lines ?? []).map(line => `BT /F1 ${line.size ?? 12} Tf 1 0 0 1 ${line.x} ${line.y} Tm (${escape(line.text)}) Tj ET\n`).join('');
    if (page.image) stream += 'q 400 0 0 600 50 100 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /ASCIIHexDecode ID 334455> EI Q\n';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let metadataId: number | undefined, infoId: number | undefined;
  if (options.xmp) { metadataId = objects.length + 1; objects.push(`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(options.xmp)} >>\nstream\n${options.xmp}\nendstream`); }
  if (options.info) { infoId = objects.length + 1; objects.push(`<< ${Object.entries(options.info).map(([key, value]) => `/${key} (${escape(value)})`).join(' ')} >>`); }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${metadataId ? ` /Metadata ${metadataId} 0 R` : ''} >>`;
  objects[1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let source = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
