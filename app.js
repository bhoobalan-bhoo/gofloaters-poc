const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const bodyParser = require('body-parser');
const path = require('path');
const { createCanvas } = require('canvas');

const app = express();
// Setup multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Use tmp directory
        cb(null, '/tmp');
    },
    filename: (req, file, cb) => {
        // Generate a unique filename
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

// Configure express to handle larger payloads
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Import PDF.js
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const pdfjsWorker = require('pdfjs-dist/legacy/build/pdf.worker.entry');

// Set the worker source
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// PDF to JSON conversion endpoint
app.post('/pdfToJson', upload.single('file'), async (req, res) => {
  console.log("Received file:", req.file);
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const pdfPath = req.file.path;
  
  try {
    // Read PDF file
    const data = new Uint8Array(fs.readFileSync(pdfPath));

    // Load PDF document
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const numPages = pdf.numPages;
    const pages = [];

    // Process each page
    for (let i = 1; i <= numPages; i++) {
      console.log(`Processing page ${i}/${numPages}`);
      
      // Get page
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.0 });
      
      // Get text content
      const content = await page.getTextContent();
      
      // Process text elements
      const textElements = content.items.map(item => {
        // Get correct coordinates from transform matrix
        const transform = item.transform;
        
        return {
          type: 'text',
          text: item.str,
          x: transform[4],
          y: transform[5],
          fontSize: item.height || Math.hypot(transform[0], transform[1]),
          width: item.width,
          height: item.height,
          fontName: item.fontName
        };
      });
      
      // Create an array to store all page elements
      const elements = [...textElements];
      
      // Extract images
      try {
        const opList = await page.getOperatorList();
        const ops = opList.fnArray;
        const args = opList.argsArray;
        
        for (let j = 0; j < ops.length; j++) {
          // Check for image operators
          if (ops[j] === pdfjsLib.OPS.paintImageXObject ||
              ops[j] === pdfjsLib.OPS.paintImageXObjectRepeat ||
              ops[j] === pdfjsLib.OPS.paintJpegXObject) {
            
            const imgName = args[j][0]; // Image name
            
            try {
              // Get image from page objects
              const img = await page.objs.get(imgName);
              
              if (img && img.data) {
                // Create canvas to render image
                const canvas = createCanvas(img.width, img.height);
                const ctx = canvas.getContext('2d');
                
                // Create ImageData
                const imgData = ctx.createImageData(img.width, img.height);
                
                // Copy image data
                for (let k = 0; k < img.data.length; k++) {
                  imgData.data[k] = img.data[k];
                }
                
                // Put image data on canvas
                ctx.putImageData(imgData, 0, 0);
                
                // Convert to base64
                const dataURL = canvas.toDataURL('image/png');
                
                // Get image transform info for positioning
                // Look through operators to find ctm (current transform matrix) for this image
                let ctm = null;
                
                // Search backwards for the most recent ctm for this image
                for (let k = j - 1; k >= 0; k--) {
                  if (ops[k] === pdfjsLib.OPS.setTransform) {
                    ctm = args[k][0];
                    break;
                  }
                }
                
                // Default position if transform not found
                let x = 0;
                let y = 0;
                let width = img.width;
                let height = img.height;
                
                // Apply transformation if found
                if (ctm) {
                  // Extract position from transform matrix (quite simplified)
                  x = ctm[4];
                  y = viewport.height - (ctm[5] + height); // PDF coordinates are bottom-up
                  
                  // Scale if needed
                  const scaleX = Math.hypot(ctm[0], ctm[1]);
                  const scaleY = Math.hypot(ctm[2], ctm[3]);
                  width = img.width * scaleX;
                  height = img.height * scaleY;
                }
                
                // Add image element
                elements.push({
                  type: 'image',
                  x,
                  y,
                  width,
                  height,
                  src: dataURL
                });
              }
            } catch (imgError) {
              console.error(`Error processing image ${imgName}:`, imgError);
            }
          }
        }
      } catch (opError) {
        console.error(`Error extracting images from page ${i}:`, opError);
      }
      
      // Add page data
      pages.push({
        width: viewport.width,
        height: viewport.height,
        elements
      });
    }

    // Clean up temporary file
    fs.unlinkSync(pdfPath);

    // Send response
    res.setHeader('Content-Disposition', 'attachment; filename="document.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json({ pages });
    
  } catch (error) {
    console.error('Error processing PDF:', error);
    // Clean up on error
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    res.status(500).json({ error: 'Failed to process PDF', details: error.message });
  }
});

// JSON to PDF conversion endpoint
app.post('/jsonToPdf', async (req, res) => {
  try {
    const { pages } = req.body;
    
    if (!pages || !Array.isArray(pages)) {
      return res.status(400).json({ error: 'Invalid JSON format. Expected { pages: [...] }' });
    }

    // Create PDF document
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Process each page
    for (const pageData of pages) {
      // Add page
      const page = pdfDoc.addPage([pageData.width, pageData.height]);
      
      // Sort elements by type to render images first, then text
      const sortedElements = [...pageData.elements].sort((a, b) => {
        if (a.type === 'image' && b.type === 'text') return -1;
        if (a.type === 'text' && b.type === 'image') return 1;
        return 0;
      });

      // Add elements to page
      for (const element of sortedElements) {
        if (element.type === 'text') {
          // Add text
          page.drawText(element.text, {
            x: element.x,
            y: pageData.height - element.y, // Adjust for PDF coordinate system
            size: element.fontSize || 12,
            font,
            color: rgb(0, 0, 0)
          });
        } else if (element.type === 'image' && element.src) {
          try {
            // Extract image data from base64
            const imageBytes = Buffer.from(
              element.src.replace(/^data:image\/\w+;base64,/, ''),
              'base64'
            );
            
            // Embed image in PDF
            let image;
            if (element.src.includes('image/png')) {
              image = await pdfDoc.embedPng(imageBytes);
            } else if (element.src.includes('image/jpeg')) {
              image = await pdfDoc.embedJpg(imageBytes);
            } else {
              // Default to PNG
              image = await pdfDoc.embedPng(imageBytes);
            }
            
            // Draw image on page
            page.drawImage(image, {
              x: element.x,
              y: pageData.height - element.y - element.height, // Adjust for PDF coordinate system
              width: element.width,
              height: element.height
            });
          } catch (imgError) {
            console.error('Error embedding image:', imgError);
          }
        }
      }
    }

    // Generate PDF bytes
    const pdfBytes = await pdfDoc.save();

    // Send response
    res.setHeader('Content-Disposition', 'attachment; filename=document.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBytes));
    
  } catch (error) {
    console.error('Error creating PDF:', error);
    res.status(500).json({ error: 'Failed to create PDF', details: error.message });
  }
});

// Static file serving for testing
app.use(express.static('public'));

// Simple form for testing
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>PDF-JSON Converter</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .container { margin-bottom: 30px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; }
        h1 { color: #333; }
        h2 { color: #555; }
        input[type="file"] { margin: 10px 0; }
        button { padding: 8px 15px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #45a049; }
      </style>
    </head>
    <body>
      <h1>PDF-JSON Converter</h1>
      
      <div class="container">
        <h2>PDF to JSON</h2>
        <form action="/pdfToJson" method="post" enctype="multipart/form-data">
          <div>
            <label for="pdfFile">Select PDF File:</label>
            <input type="file" id="pdfFile" name="file" accept=".pdf" required>
          </div>
          <button type="submit">Convert to JSON</button>
        </form>
      </div>
      
      <div class="container">
        <h2>JSON to PDF</h2>
        <form id="jsonForm">
          <div>
            <label for="jsonFile">Select JSON File:</label>
            <input type="file" id="jsonFile" accept=".json" required>
          </div>
          <button type="submit">Convert to PDF</button>
        </form>
      </div>
      
      <script>
        document.getElementById('jsonForm').addEventListener('submit', async (event) => {
          event.preventDefault();
          const fileInput = document.getElementById('jsonFile');
          const file = fileInput.files[0];
          if (!file) return alert('Please select a JSON file');
          
          try {
            const reader = new FileReader();
            reader.onload = async function(e) {
              const jsonData = JSON.parse(e.target.result);
              
              const response = await fetch('/jsonToPdf', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData)
              });
              
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.details || 'Failed to convert JSON to PDF');
              }
              
              const blob = await response.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'document.pdf';
              a.click();
              URL.revokeObjectURL(url);
            };
            
            reader.readAsText(file);
          } catch (error) {
            alert('Error: ' + error.message);
          }
        });
      </script>
    </body>
    </html>
  `);
});

module.exports = app;