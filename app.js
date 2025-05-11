const express = require('express');
const multer = require('multer');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const { getDocument, GlobalWorkerOptions } = require('pdfjs-dist');
const sharp = require('sharp');
const { createCanvas, loadImage } = require('canvas');

// Configure PDF.js worker
GlobalWorkerOptions.workerSrc = path.resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Ensure upload directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Enhanced PDF element extraction
async function extractPageElements(page) {
  const viewport = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent();
  const opList = await page.getOperatorList();
  
  const elements = [];
  let currentTransform = [1, 0, 0, 1, 0, 0];

  // Process text elements
  for (const item of textContent.items) {
    elements.push({
      type: 'text',
      text: item.str,
      x: item.transform[4],
      y: viewport.height - item.transform[5], // Convert to bottom-left origin
      width: item.width,
      height: item.height,
      font: item.fontName,
      transform: item.transform,
      color: item.color || [0, 0, 0] // Default to black
    });
  }

  // Process images and other elements
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    // Track current transformation matrix
    if (fn === 'transform') {
      currentTransform = args;
    }

    // Handle image elements
    if (fn === 'paintImageXObject') {
      try {
        const imgName = args[0];
        const imgObj = await page.objs.get(imgName);
        
        if (imgObj && imgObj.data) {
          // Create canvas to render the image
          const canvas = createCanvas(imgObj.width, imgObj.height);
          const ctx = canvas.getContext('2d');
          const imageData = new ImageData(
            new Uint8ClampedArray(imgObj.data),
            imgObj.width,
            imgObj.height
          );
          ctx.putImageData(imageData, 0, 0);
          
          // Convert to base64
          const base64Image = canvas.toDataURL('image/png').split(',')[1];
          
          elements.push({
            type: 'image',
            data: base64Image,
            x: currentTransform[4],
            y: viewport.height - currentTransform[5] - imgObj.height, // Convert to bottom-left origin
            width: imgObj.width,
            height: imgObj.height,
            transform: currentTransform
          });
        }
      } catch (err) {
        console.error('Error processing image:', err);
      }
    }
  }

  return elements;
}

// API 1: Convert PDF to JSON with precise element extraction
app.post('/api/pdf-to-json', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const filePath = req.file.path;
    const fileBuffer = fs.readFileSync(filePath);
    const uint8Array = new Uint8Array(fileBuffer);

    // Load PDF document
    const pdfDoc = await getDocument(uint8Array).promise;
    
    // Extract metadata
    const metadata = {
      title: (await pdfDoc.getMetadata()).info?.Title || null,
      author: (await pdfDoc.getMetadata()).info?.Author || null,
      subject: (await pdfDoc.getMetadata()).info?.Subject || null,
      creator: (await pdfDoc.getMetadata()).info?.Creator || null,
      keywords: (await pdfDoc.getMetadata()).info?.Keywords || null,
      producer: (await pdfDoc.getMetadata()).info?.Producer || null,
      creationDate: (await pdfDoc.getMetadata()).info?.CreationDate || null,
      modificationDate: (await pdfDoc.getMetadata()).info?.ModDate || null,
      pageCount: pdfDoc.numPages,
    };

    // Extract content from each page
    const pages = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1.0 });
      
      const elements = await extractPageElements(page);
      
      pages.push({
        pageNumber: i,
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
        elements: elements
      });
    }

    const result = {
      metadata,
      pages,
      fileInfo: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      }
    };

    // Clean up the uploaded file
    fs.unlinkSync(filePath);

    res.json(result);
  } catch (error) {
    console.error('Error processing PDF:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Error processing PDF', details: error.message });
  }
});

// API 2: Convert JSON back to PDF with precise element placement
app.post('/api/json-to-pdf', async (req, res) => {
  try {
    const { metadata, pages } = req.body;
    
    if (!metadata || !pages) {
      return res.status(400).json({ error: 'Invalid JSON structure. Metadata and pages are required.' });
    }

    // Create a new PDF document
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    // Set metadata
    if (metadata.title) pdfDoc.setTitle(metadata.title);
    if (metadata.author) pdfDoc.setAuthor(metadata.author);
    if (metadata.subject) pdfDoc.setSubject(metadata.subject);
    if (metadata.creator) pdfDoc.setCreator(metadata.creator);
    if (metadata.keywords) pdfDoc.setKeywords(metadata.keywords);
    if (metadata.producer) pdfDoc.setProducer(metadata.producer);

    // Add pages and reconstruct content
    for (const pageInfo of pages) {
      const page = pdfDoc.addPage([pageInfo.width || 612, pageInfo.height || 792]);
      
      if (pageInfo.rotation) {
        page.setRotation(pageInfo.rotation);
      }

      // Process all elements in their original order
      if (pageInfo.elements && Array.isArray(pageInfo.elements)) {
        for (const element of pageInfo.elements) {
          try {
            if (element.type === 'text') {
              page.drawText(element.text, {
                x: element.x,
                y: element.y,
                size: element.height,
                color: rgb(element.color[0] || 0, element.color[1] || 0, element.color[2] || 0),
              });
            } else if (element.type === 'image' && element.data) {
              const imageBytes = Buffer.from(element.data, 'base64');
              let image;
              
              // Try to determine image type
              try {
                const metadata = await sharp(imageBytes).metadata();
                if (metadata.format === 'jpeg') {
                  image = await pdfDoc.embedJpg(imageBytes);
                } else if (metadata.format === 'png') {
                  image = await pdfDoc.embedPng(imageBytes);
                } else {
                  image = await pdfDoc.embedImage(imageBytes);
                }
              } catch {
                image = await pdfDoc.embedImage(imageBytes);
              }
              
              page.drawImage(image, {
                x: element.x,
                y: element.y,
                width: element.width,
                height: element.height,
              });
            }
          } catch (err) {
            console.error('Error reconstructing element:', err);
          }
        }
      }
    }

    // Serialize the PDF to bytes
    const pdfBytes = await pdfDoc.save();

    // Set response headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=restored.pdf');
    res.setHeader('Content-Length', pdfBytes.length);

    // Send the PDF
    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Error generating PDF', details: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: 'File upload error', details: err.message });
  } else if (err) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

module.exports = app;