const express = require('express');
const multer = require('multer');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(bodyParser.json({ limit: '10mb' }));

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

app.post('/pdfToJson', upload.single('file'), async (req, res) => {
  const pdfPath = req.file.path;
  const data = new Uint8Array(fs.readFileSync(pdfPath));

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const numPages = pdf.numPages;

  const pages = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const content = await page.getTextContent();

    const elements = content.items.map(item => {
      const transform = item.transform;
      return {
        type: 'text',
        text: item.str,
        x: transform[4],
        y: transform[5],
        fontSize: Math.hypot(transform[0], transform[1]),
        width: item.width,
        height: item.height,
        fontName: item.fontName
      };
    });

    pages.push({
      width: viewport.width,
      height: viewport.height,
      elements
    });
  }

  fs.unlinkSync(pdfPath); // Clean up

  res.setHeader('Content-Disposition', 'attachment; filename="document.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send({ pages });
});


// JSON to PDF
app.post('/jsonToPdf', async (req, res) => {
  const { pages } = req.body;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const pageData of pages) {
    const page = pdfDoc.addPage([pageData.width, pageData.height]);

    for (const element of pageData.elements) {
      if (element.type === 'text') {
        page.drawText(element.text, {
          x: element.x,
          y: element.y,
          size: element.fontSize || 12,
          font,
          color: rgb(0, 0, 0)
        });
      } else if (element.type === 'image' && element.src) {
        const imageBytes = Buffer.from(
          element.src.replace(/^data:image\/\w+;base64,/, ''),
          'base64'
        );
        const image = await pdfDoc.embedPng(imageBytes);
        page.drawImage(image, {
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height
        });
      }
    }
  }

  const pdfBytes = await pdfDoc.save();

  res.setHeader('Content-Disposition', 'attachment; filename=document.pdf');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(Buffer.from(pdfBytes));
});

module.exports = app;