// Bouwt het verslag uit de blokken (letterlijke tekst) + structuur, en exporteert naar DOCX, PDF en VTT.
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, Footer, PageNumber } from 'docx';
import { db, json } from '../db.js';
import { formatTime } from './extract.js';
import { defaultTitle } from './pipeline.js';

export function buildReport(runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(run.meeting_id);
  const rep = json(run.report, {}) || {};
  const blocks = db.prepare('SELECT * FROM run_blocks WHERE run_id = ? AND merged_into IS NULL ORDER BY ord').all(runId);
  const punten = (rep.punten?.length ? rep.punten : [{ titel: 'Transcript', nummer: '', samenvatting: '', beslissingen: [] }])
    .map((p) => ({ ...p, bijdragen: [] }));
  for (const b of blocks) {
    const p = punten[Math.min(b.point_idx ?? 0, punten.length - 1)];
    const last = p.bijdragen[p.bijdragen.length - 1];
    const name = b.speaker_name || b.speaker_raw || 'Onbekende spreker';
    if (last && last.spreker === name) {
      last.text += ' ' + b.text_final;
      last.t_end = b.t_end ?? last.t_end;
      last.blocks.push(b.block_id);
    } else {
      p.bijdragen.push({ spreker: name, functie: b.functie, fractie: b.fractie, zekerheid: b.zekerheid, text: b.text_final, t_start: b.t_start, t_end: b.t_end, blocks: [b.block_id] });
    }
  }
  return {
    titel: rep.titel || meeting.titel || defaultTitle(meeting),
    samenvatting: rep.samenvatting || '',
    waarschuwingen: rep.waarschuwingen || [],
    beslissingen: punten.flatMap((p) => (p.beslissingen || []).map((b) => (p.nummer ? `Punt ${p.nummer}: ${b}` : b))),
    punten: punten.filter((p) => p.bijdragen.length),
    hasTimecodes: !!meeting.has_timecodes,
    meeting,
    blocks,
  };
}

const speakerLabel = (c) => {
  const extra = [c.functie, c.fractie].filter((x) => x && x !== '-').join(', ');
  return extra ? `${c.spreker} (${extra})` : c.spreker;
};
const pointTitle = (p) => (p.nummer ? `Punt ${p.nummer}: ${p.titel}` : p.titel);

// ---------------- DOCX ----------------
export async function toDocx(r) {
  const children = [new Paragraph({ text: r.titel, heading: HeadingLevel.TITLE })];
  for (const w of r.waarschuwingen) {
    children.push(new Paragraph({
      children: [new TextRun({ text: 'Waarschuwing: ', bold: true }), new TextRun(w)],
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'C0392B', space: 8 } },
      shading: { fill: 'FDF2F0' },
      spacing: { after: 120 },
    }));
  }
  if (r.samenvatting) {
    children.push(new Paragraph({ text: 'Samenvatting', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: r.samenvatting, spacing: { after: 160 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Beslissingen en stemmingen', bold: true })] }));
    if (r.beslissingen.length) for (const b of r.beslissingen) children.push(new Paragraph({ text: b, bullet: { level: 0 } }));
    else children.push(new Paragraph({ children: [new TextRun({ text: 'Geen beslissingen of stemmingen vermeld in de transcriptie.', italics: true })] }));
  }
  for (const p of r.punten) {
    children.push(new Paragraph({ text: pointTitle(p), heading: HeadingLevel.HEADING_1, spacing: { before: 240 } }));
    if (p.samenvatting) children.push(new Paragraph({ children: [new TextRun({ text: p.samenvatting, italics: true })], spacing: { after: 120 } }));
    for (const c of p.bijdragen) {
      const runs = [];
      if (r.hasTimecodes && c.t_start != null) runs.push(new TextRun({ text: `[${formatTime(c.t_start).slice(0, 8)}] `, color: '888888', size: 18 }));
      runs.push(new TextRun({ text: `${speakerLabel(c)}: `, bold: true }), new TextRun(c.text));
      children.push(new Paragraph({ children: runs, spacing: { after: 120 }, alignment: AlignmentType.LEFT }));
    }
  }
  const doc = new Document({
    creator: 'Transcraiber',
    title: r.titel,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{
      children,
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: '888888' })] })] }) },
    }],
  });
  return Packer.toBuffer(doc);
}

// ---------------- PDF ----------------
// PDFKit-standaardfonts kennen alleen WinAnsi; vervang tekens die daar niet in zitten.
const pdfSafe = (s) => String(s ?? '').replace(/[‐-‒]/g, '-').replace(/[^\x00-\xFF–—‘’“”…€ŒœŠšŸŽž]/g, '?');

export function toPdf(r) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 60, right: 60 }, bufferPages: true, info: { Title: r.titel, Creator: 'Transcraiber' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 120;

    doc.font('Helvetica-Bold').fontSize(18).text(pdfSafe(r.titel));
    doc.moveDown(0.6);
    for (const w of r.waarschuwingen) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#C0392B').text('Waarschuwing: ', { continued: true })
        .font('Helvetica').fillColor('#333').text(pdfSafe(w));
      doc.moveDown(0.3);
    }
    if (r.samenvatting) {
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(13).fillColor('#000').text('Samenvatting');
      doc.font('Helvetica').fontSize(10.5).text(pdfSafe(r.samenvatting), { width: W, align: 'justify' });
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(10.5).text('Beslissingen en stemmingen');
      doc.font('Helvetica').fontSize(10.5);
      if (r.beslissingen.length) doc.list(r.beslissingen.map(pdfSafe), { bulletRadius: 2, width: W });
      else doc.font('Helvetica-Oblique').text('Geen beslissingen of stemmingen vermeld in de transcriptie.');
    }
    for (const p of r.punten) {
      doc.moveDown(1).font('Helvetica-Bold').fontSize(13).fillColor('#000').text(pdfSafe(pointTitle(p)), { width: W });
      if (p.samenvatting) doc.font('Helvetica-Oblique').fontSize(10).fillColor('#444').text(pdfSafe(p.samenvatting), { width: W });
      doc.moveDown(0.4);
      for (const c of p.bijdragen) {
        doc.fontSize(10.5).fillColor('#000');
        if (r.hasTimecodes && c.t_start != null) doc.font('Helvetica').fillColor('#888').text(`[${formatTime(c.t_start).slice(0, 8)}] `, { continued: true }).fillColor('#000');
        doc.font('Helvetica-Bold').text(pdfSafe(`${speakerLabel(c)}: `), { continued: true })
          .font('Helvetica').text(pdfSafe(c.text), { width: W, align: 'left' });
        doc.moveDown(0.4);
      }
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // anders maakt PDFKit een nieuwe pagina voor tekst in de ondermarge
      doc.font('Helvetica').fontSize(8).fillColor('#888')
        .text(`${i + 1} / ${range.count}`, 60, doc.page.height - 40, { width: W, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// ---------------- VTT ----------------
const MAX_CUE = 160; // tekens per cue

function splitForCues(text) {
  const sentences = text.match(/[^.?!…]+[.?!…]+["'”’)]?\s*|[^.?!…]+$/g) || [text];
  const pieces = [];
  for (let s of sentences) {
    s = s.trim();
    while (s.length > MAX_CUE) {
      let cut = s.lastIndexOf(', ', MAX_CUE);
      if (cut < MAX_CUE / 2) cut = s.lastIndexOf(' ', MAX_CUE);
      if (cut <= 0) cut = MAX_CUE;
      pieces.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) pieces.push(s);
  }
  // korte stukken samenvoegen
  const out = [];
  for (const p of pieces) {
    if (out.length && out[out.length - 1].length + p.length + 1 <= MAX_CUE) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

/**
 * Eén blok = één echt tijdsinterval uit de bron (start van het eerste, einde van het laatste cue).
 * Binnen een blok worden de cues verdeeld naar verhouding van het aantal tekens.
 */
export function toVtt(r) {
  if (!r.hasTimecodes) throw new Error('VTT-uitvoer kan alleen als de invoer tijdcodes had (VTT of SRT).');
  let out = 'WEBVTT\n\n';
  let n = 1;
  for (const b of r.blocks) {
    if (b.t_start == null || b.t_end == null) continue;
    const speaker = (b.speaker_name || b.speaker_raw || '').replace(/[<>]/g, '');
    const pieces = splitForCues(b.text_final || '');
    const total = pieces.reduce((s, p) => s + p.length, 0) || 1;
    const dur = Math.max(0, b.t_end - b.t_start);
    let t = b.t_start;
    for (const p of pieces) {
      const end = Math.min(b.t_end, t + (dur * p.length) / total);
      out += `${n++}\n${formatTime(t)} --> ${formatTime(end)}\n${speaker ? `<v ${speaker}>` : ''}${p}\n\n`;
      t = end;
    }
  }
  return out;
}
