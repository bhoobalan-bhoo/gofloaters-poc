const express = require('express');
const multer = require('multer');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const bodyParser = require('body-parser');
const path = require('path');
const { createCanvas } = require('canvas');

const app = express();

// Setup multer for file uploads - use memory storage for Lambda compatibility
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

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
  console.log("Processing PDF to JSON conversion");
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  try {
    // Use the buffer directly from multer
    const data = new Uint8Array(req.file.buffer);

    // Load PDF document with Lambda-friendly settings
    const pdf = await pdfjsLib.getDocument({
      data,
      verbosity: 0,
      useSystemFonts: false,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true
    }).promise;
    
    const numPages = pdf.numPages;
    const pages = [];

    // Process each page
    for (let i = 1; i <= numPages; i++) {
      console.log(`Processing page ${i}/${numPages}`);
      
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.0 });
      
      // Get text content
      const content = await page.getTextContent();
      
      // Process text elements
      const textElements = content.items.map(item => {
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
      
      const elements = [...textElements];
      
      // Extract images
      try {
        const opList = await page.getOperatorList();
        const ops = opList.fnArray;
        const args = opList.argsArray;
        
        for (let j = 0; j < ops.length; j++) {
          if (ops[j] === pdfjsLib.OPS.paintImageXObject ||
              ops[j] === pdfjsLib.OPS.paintImageXObjectRepeat ||
              ops[j] === pdfjsLib.OPS.paintJpegXObject) {
            
            const imgName = args[j][0];
            
            try {
              const img = await page.objs.get(imgName);
              
              if (img && img.data) {
                const canvas = createCanvas(img.width, img.height);
                const ctx = canvas.getContext('2d');
                const imgData = ctx.createImageData(img.width, img.height);
                
                for (let k = 0; k < img.data.length; k++) {
                  imgData.data[k] = img.data[k];
                }
                
                ctx.putImageData(imgData, 0, 0);
                const dataURL = canvas.toDataURL('image/png');
                
                // Get transform matrix
                let ctm = null;
                for (let k = j - 1; k >= 0; k--) {
                  if (ops[k] === pdfjsLib.OPS.setTransform) {
                    ctm = args[k][0];
                    break;
                  }
                }
                
                let x = 0;
                let y = 0;
                let width = img.width;
                let height = img.height;
                
                if (ctm) {
                  x = ctm[4];
                  y = viewport.height - (ctm[5] + height);
                  const scaleX = Math.hypot(ctm[0], ctm[1]);
                  const scaleY = Math.hypot(ctm[2], ctm[3]);
                  width = img.width * scaleX;
                  height = img.height * scaleY;
                }
                
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
      
      pages.push({
        width: viewport.width,
        height: viewport.height,
        elements
      });
    }

    res.json({ pages });
    
  } catch (error) {
    console.error('Error processing PDF:', error);
    res.status(500).json({ error: 'Failed to process PDF', details: error.message });
  }
});

// JSON to PDF conversion endpoint - returns base64
app.post('/jsonToPdf', async (req, res) => {
  try {
    console.log("Processing JSON to PDF conversion");
    
    let jsonData = req.body;
    if (Buffer.isBuffer(req.body)) {
      const jsonString = req.body.toString();
      jsonData = JSON.parse(jsonString);
    }
    
    const { pages } = jsonData;
    
    if (!pages || !Array.isArray(pages)) {
      return res.status(400).json({ error: 'Invalid JSON format. Expected { pages: [...] }' });
    }

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    for (const pageData of pages) {
      const page = pdfDoc.addPage([pageData.width, pageData.height]);
      
      const sortedElements = [...pageData.elements].sort((a, b) => {
        if (a.type === 'image' && b.type === 'text') return -1;
        if (a.type === 'text' && b.type === 'image') return 1;
        return 0;
      });

      for (const element of sortedElements) {
        if (element.type === 'text') {
          page.drawText(element.text, {
            x: element.x,
            y: pageData.height - element.y,
            size: element.fontSize || 12,
            font,
            color: rgb(0, 0, 0)
          });
        } else if (element.type === 'image' && element.src) {
          try {
            const imageBytes = Buffer.from(
              element.src.replace(/^data:image\/\w+;base64,/, ''),
              'base64'
            );
            
            let image;
            if (element.src.includes('image/png')) {
              image = await pdfDoc.embedPng(imageBytes);
            } else if (element.src.includes('image/jpeg')) {
              image = await pdfDoc.embedJpg(imageBytes);
            } else {
              image = await pdfDoc.embedPng(imageBytes);
            }
            
            page.drawImage(image, {
              x: element.x,
              y: pageData.height - element.y - element.height,
              width: element.width,
              height: element.height
            });
          } catch (imgError) {
            console.error('Error embedding image:', imgError);
          }
        }
      }
    }

    const pdfBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(pdfBytes).toString('base64');
    
    res.json({ 
      success: true,
      pdf: base64Pdf,
      filename: 'document.pdf',
      size: pdfBytes.length
    });
    
  } catch (error) {
    console.error('Error creating PDF:', error);
    res.status(500).json({ error: 'Failed to create PDF', details: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Enhanced home page with improved UI and base64 handling
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>PDF-JSON Converter</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
          line-height: 1.6;
          color: #333;
          background-color: #f5f5f5;
        }
        .container {
          max-width: 800px;
          margin: 40px auto;
          padding: 0 20px;
        }
        .header {
          text-align: center;
          background: white;
          padding: 40px;
          border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          margin-bottom: 30px;
        }
        .header h1 {
          color: #2c3e50;
          font-size: 2.5em;
          margin-bottom: 10px;
        }
        .header p {
          color: #7f8c8d;
          font-size: 1.1em;
        }
        .card {
          background: white;
          border-radius: 12px;
          padding: 30px;
          margin-bottom: 25px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          transition: transform 0.2s ease;
        }
        .card:hover {
          transform: translateY(-2px);
        }
        .card h2 {
          color: #34495e;
          margin-bottom: 20px;
          font-size: 1.5em;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .icon {
          width: 24px;
          height: 24px;
          display: inline-block;
        }
        .file-input-wrapper {
          position: relative;
          overflow: hidden;
          display: inline-block;
          width: 100%;
          margin-bottom: 20px;
        }
        .file-input {
          position: absolute;
          left: -9999px;
        }
        .file-input-label {
          display: block;
          padding: 12px 20px;
          background: #ecf0f1;
          border: 2px dashed #bdc3c7;
          border-radius: 8px;
          cursor: pointer;
          text-align: center;
          transition: all 0.3s ease;
          font-weight: 500;
        }
        .file-input-label:hover {
          background: #d5dbdb;
          border-color: #95a5a6;
        }
        .file-input:focus-within + .file-input-label {
          outline: 2px solid #3498db;
          outline-offset: 2px;
        }
        .btn {
          display: inline-block;
          padding: 12px 30px;
          background: #3498db;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 16px;
          font-weight: 600;
          text-decoration: none;
          transition: all 0.3s ease;
          width: 100%;
          position: relative;
          overflow: hidden;
        }
        .btn:hover {
          background: #2980b9;
          transform: translateY(-1px);
        }
        .btn:active {
          transform: translateY(0);
        }
        .btn:disabled {
          background: #95a5a6;
          cursor: not-allowed;
          transform: none;
        }
        .btn.btn-success {
          background: #27ae60;
        }
        .btn.btn-success:hover {
          background: #229954;
        }
        .status {
          margin-top: 20px;
          padding: 15px;
          border-radius: 8px;
          font-weight: 500;
          display: none;
          align-items: center;
          gap: 10px;
        }
        .status.loading {
          background: #ebf7ff;
          color: #0066cc;
          border: 1px solid #b3d9ff;
          display: flex;
        }
        .status.success {
          background: #eafaf1;
          color: #0f7b21;
          border: 1px solid #a3e6a3;
          display: flex;
        }
        .status.error {
          background: #ffeaea;
          color: #c0392b;
          border: 1px solid #ffb3b3;
          display: flex;
        }
        .spinner {
          width: 20px;
          height: 20px;
          border: 2px solid #f3f3f3;
          border-top: 2px solid #3498db;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .features {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 20px;
          margin-top: 30px;
        }
        .feature {
          background: white;
          padding: 20px;
          border-radius: 10px;
          text-align: center;
          box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>PDF ↔ JSON Converter</h1>
          <p>Convert PDFs to structured JSON and back to PDFs with preserved layout</p>
        </div>
        
        <div class="card">
          <h2>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14,2 14,8 20,8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10,9 9,9 8,9"></polyline>
            </svg>
            PDF to JSON
          </h2>
          <div class="file-input-wrapper">
            <input type="file" id="pdfFile" class="file-input" accept=".pdf" />
            <label for="pdfFile" class="file-input-label">
              📄 Click to select PDF file or drag and drop
            </label>
          </div>
          <button id="pdfBtn" class="btn" onclick="convertPdfToJson()">Convert to JSON</button>
          <div id="pdfStatus" class="status"></div>
        </div>
        
        <div class="card">
          <h2>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#27ae60" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14,2 14,8 20,8"></polyline>
              <line x1="12" y1="18" x2="12" y2="12"></line>
              <line x1="9" y1="15" x2="12" y2="12"></line>
              <line x1="15" y1="15" x2="12" y2="12"></line>
            </svg>
            JSON to PDF
          </h2>
          <div class="file-input-wrapper">
            <input type="file" id="jsonFile" class="file-input" accept=".json" />
            <label for="jsonFile" class="file-input-label">
              📝 Click to select JSON file or drag and drop
            </label>
          </div>
          <button id="jsonBtn" class="btn btn-success" onclick="convertJsonToPdf()">Convert to PDF</button>
          <div id="jsonStatus" class="status"></div>
        </div>
        
        <div class="features">
          <div class="feature">
            <h3>Text Extraction</h3>
            <p>Preserves all text content with exact positioning and styling</p>
          </div>
          <div class="feature">
            <h3>Image Support</h3>
            <p>Extracts and embeds images with original quality</p>
          </div>
          <div class="feature">
            <h3>Layout Preservation</h3>
            <p>Maintains exact positioning and dimensions</p>
          </div>
          <div class="feature">
            <h3>Cloud Ready</h3>
            <p>Optimized for serverless environments like AWS Lambda</p>
          </div>
        </div>
      </div>
      
      <script>
        // Helper function to download base64 as file
        function downloadBase64File(base64Data, filename, mimeType = 'application/pdf') {
          try {
            const byteCharacters = atob(base64Data);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });
            
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          } catch (error) {
            console.error('Error downloading file:', error);
            throw new Error('Failed to download file');
          }
        }
        
        // Update file input labels when files are selected
        document.getElementById('pdfFile').addEventListener('change', function(e) {
          const label = this.nextElementSibling;
          if (e.target.files.length > 0) {
            label.textContent = '📄 ' + e.target.files[0].name;
            label.style.color = '#27ae60';
          }
        });
        
        document.getElementById('jsonFile').addEventListener('change', function(e) {
          const label = this.nextElementSibling;
          if (e.target.files.length > 0) {
            label.textContent = '📝 ' + e.target.files[0].name;
            label.style.color = '#27ae60';
          }
        });
        
        // Drag and drop support
        function setupDragAndDrop(inputId, labelId) {
          const input = document.getElementById(inputId);
          const label = input.nextElementSibling;
          
          ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            label.addEventListener(eventName, preventDefaults, false);
          });
          
          function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
          }
          
          ['dragenter', 'dragover'].forEach(eventName => {
            label.addEventListener(eventName, highlight, false);
          });
          
          ['dragleave', 'drop'].forEach(eventName => {
            label.addEventListener(eventName, unhighlight, false);
          });
          
          function highlight(e) {
            label.style.background = '#d5dbdb';
            label.style.borderColor = '#3498db';
          }
          
          function unhighlight(e) {
            label.style.background = '#ecf0f1';
            label.style.borderColor = '#bdc3c7';
          }
          
          label.addEventListener('drop', handleDrop, false);
          
          function handleDrop(e) {
            const dt = e.dataTransfer;
            const files = dt.files;
            input.files = files;
            input.dispatchEvent(new Event('change'));
          }
        }
        
        setupDragAndDrop('pdfFile');
        setupDragAndDrop('jsonFile');
        
        // PDF to JSON conversion
        async function convertPdfToJson() {
          const fileInput = document.getElementById('pdfFile');
          const statusDiv = document.getElementById('pdfStatus');
          const btn = document.getElementById('pdfBtn');
          const file = fileInput.files[0];
          
          if (!file) {
            showStatus(statusDiv, 'error', 'Please select a PDF file');
            return;
          }
          
          btn.disabled = true;
          showStatus(statusDiv, 'loading', 'Converting PDF to JSON...');
          
          try {
            const formData = new FormData();
            formData.append('file', file);
            
            const response = await fetch('/pdfToJson', {
              method: 'POST',
              body: formData
            });
            
            if (!response.ok) {
              const error = await response.json();
              throw new Error(error.details || 'Failed to convert PDF to JSON');
            }
            
            const result = await response.json();
            
            // Download the JSON file
            const jsonBlob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(jsonBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'document.json';
            a.click();
            URL.revokeObjectURL(url);
            
            showStatus(statusDiv, 'success', 'PDF converted to JSON successfully! File downloaded.');
            fileInput.value = '';
            fileInput.nextElementSibling.textContent = '📄 Click to select PDF file or drag and drop';
            fileInput.nextElementSibling.style.color = '';
          } catch (error) {
            console.error('Error:', error);
            showStatus(statusDiv, 'error', error.message);
          } finally {
            btn.disabled = false;
          }
        }
        
        // JSON to PDF conversion
        async function convertJsonToPdf() {
          const fileInput = document.getElementById('jsonFile');
          const statusDiv = document.getElementById('jsonStatus');
          const btn = document.getElementById('jsonBtn');
          const file = fileInput.files[0];
          
          if (!file) {
            showStatus(statusDiv, 'error', 'Please select a JSON file');
            return;
          }
          
          btn.disabled = true;
          showStatus(statusDiv, 'loading', 'Converting JSON to PDF...');
          
          try {
            const reader = new FileReader();
            reader.onload = async function(e) {
              try {
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
                
                const result = await response.json();
                
                if (result.success && result.pdf) {
                  // Download the PDF from base64
                  downloadBase64File(result.pdf, result.filename || 'document.pdf');
                  showStatus(statusDiv, 'success', 
                    \`PDF generated successfully! Size: \${(result.size / 1024).toFixed(2)} KB. File downloaded.\`);
                  fileInput.value = '';
                  fileInput.nextElementSibling.textContent = '📝 Click to select JSON file or drag and drop';
                  fileInput.nextElementSibling.style.color = '';
                } else {
                  throw new Error('Invalid response format');
                }
              } catch (jsonError) {
                console.error('Error:', jsonError);
                showStatus(statusDiv, 'error', jsonError.message);
              } finally {
                btn.disabled = false;
              }
            };
            
            reader.readAsText(file);
          } catch (error) {
            console.error('Error:', error);
            showStatus(statusDiv, 'error', error.message);
            btn.disabled = false;
          }
        }
        
        // Helper function to show status messages
        function showStatus(statusDiv, type, message) {
          statusDiv.className = \`status \${type}\`;
          statusDiv.style.display = 'flex';
          
          if (type === 'loading') {
            statusDiv.innerHTML = \`<div class="spinner"></div><span>\${message}</span>\`;
          } else if (type === 'success') {
            statusDiv.innerHTML = \`<span>✓</span><span>\${message}</span>\`;
          } else if (type === 'error') {
            statusDiv.innerHTML = \`<span>✗</span><span>\${message}</span>\`;
          }
          
          // Auto-hide success/error messages after 5 seconds
          if (type !== 'loading') {
            setTimeout(() => {
              statusDiv.style.display = 'none';
            }, 5000);
          }
        }
      </script>
    </body>
    </html>
  `);
});


module.exports = app;