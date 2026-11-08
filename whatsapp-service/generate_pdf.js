import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async () => {
    try {
        console.log('Launching Puppeteer...');
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        // Resolve path to the HTML file
        const htmlPath = path.resolve(__dirname, '../security_docs/architecture_threat_model.html');
        console.log('Loading HTML file from:', htmlPath);
        
        await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0', timeout: 30000 });
        
        const pdfPath = path.resolve(__dirname, '../security_docs/architecture_threat_model.pdf');
        console.log('Generating PDF at:', pdfPath);
        
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '15mm',
                bottom: '15mm',
                left: '15mm',
                right: '15mm'
            }
        });
        
        await browser.close();
        console.log('PDF generation complete!');
    } catch (err) {
        console.error('Failed to generate PDF:', err);
        process.exit(1);
    }
})();
