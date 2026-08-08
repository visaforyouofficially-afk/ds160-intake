const Busboy = require('busboy');
const PDFDocument = require('pdfkit');
const { SECTIONS } = require('./_sections');

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 8 * 1024 * 1024 } });
    const fields = {};
    const files = [];
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('end', () => {
        files.push({ fieldname: name, filename: info.filename, mimeType: info.mimeType, buffer: Buffer.concat(chunks) });
      });
    });
    bb.on('finish', () => resolve({ fields, files }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

function buildPdf({ ref, lang, ts, answers, fileNames }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).fillColor('#1C2B3A').text('DS-160 Application Summary');
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#5B6672').text(
      'Reference: ' + ref + '    Submitted: ' + new Date(ts).toLocaleString() + '    Language: ' + lang
    );
    doc.moveDown(1);

    SECTIONS.forEach((section) => {
      const rows = section.fields.filter((f) => answers[f.id] || fileNames[f.id]);
      if (rows.length === 0) return;
      doc.fontSize(13).fillColor('#B3241C').text(section.title);
      doc.moveDown(0.2);
      rows.forEach((f) => {
        let v = f.type === 'file' ? (fileNames[f.id] || '') : (answers[f.id] || '');
        if (f.type === 'radio') v = v === 'yes' ? 'Yes' : 'No';
        if (f.type === 'select' && f.options && f.options[v]) v = f.options[v];
        doc.fontSize(10).fillColor('#1C2B3A').font('Helvetica-Bold').text(f.label + ': ', { continued: true });
        doc.font('Helvetica').text(String(v));
      });
      doc.moveDown(0.6);
    });

    doc.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL) {
    res.status(500).json({ error: 'server_not_configured' });
    return;
  }
  try {
    const { fields, files } = await parseForm(req);
    const answers = JSON.parse(fields.answers || '{}');
    const lang = fields.lang || 'en';
    const ref = 'DS160-' + Math.floor(100000 + Math.random() * 900000);
    const fileNames = {};
    files.forEach((f) => { fileNames[f.fieldname] = f.filename; });

    const pdfBuffer = await buildPdf({ ref, lang, ts: Date.now(), answers, fileNames });
    const attachments = [
      { filename: ref + '.pdf', content: pdfBuffer.toString('base64') },
      ...files.map((f) => ({ filename: f.filename, content: f.buffer.toString('base64') })),
    ];

    const applicantName = ((answers.givenNames || '') + ' ' + (answers.surname || '')).trim();

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'DS-160 Intake <onboarding@resend.dev>',
        to: [process.env.NOTIFY_EMAIL],
        subject: 'New DS-160 application \u2014 ' + ref + (applicantName ? ' \u2014 ' + applicantName : ''),
        html:
          '<p>New application received.</p><p>Reference: <b>' + ref + '</b></p>' +
          '<p>Language used by applicant: ' + lang + '</p>' +
          '<p>Full answers and any uploaded files are attached.</p>',
        attachments,
      }),
    });

    if (!resendResp.ok) {
      const errText = await resendResp.text();
      console.error('Resend error:', errText);
      res.status(502).json({ error: 'email_failed' });
      return;
    }

    res.status(200).json({ ok: true, ref });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
};
