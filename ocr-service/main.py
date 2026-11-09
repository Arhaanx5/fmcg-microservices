"""
FMCG Invoice OCR & AI Text Generation Microservice
--------------------------------------------------
Senior Engineering Clean Implementation (Python FastAPI)

This microservice handles:
1. Invoice Image OCR Parsing (/ocr/scan-invoice) via Gemini Multimodal.
2. AI Text & Business Insights Generation (/ocr/generate-text).
3. Structured JSON Parsing (/ocr/parse-structured).

Architectural Features:
- Multi-Model Gemini API Fallback (Bypasses rate limits & 503 capacity issues).
- Image Compression & EXIF Auto-Rotation (Speeds up upload latency).
- Server-side Financial Calculations Validation (Auto-corrects invoice taxable values).
- Clean JSON Code-Fence Stripping.
"""

import os
import json
import logging
import base64
import asyncio
import io
import struct
import requests
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, File, UploadFile, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image, ImageOps

# ── Logging Configuration ──────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s"
)
logger = logging.getLogger("ocr-service")

# ── FastAPI App Initialization ──────────────────────────────────────────────
app = FastAPI(
    title="FMCG Invoice OCR & AI Text Service",
    version="2.0.0",
    description="High-performance microservice for processing invoice images and AI business copilot text generation."
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Environment & Config ────────────────────────────────────────────────────
API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    logger.warning("⚠️ GEMINI_API_KEY environment variable is missing! AI calls will fail until configured.")

INTERNAL_SECRET = os.environ.get("WA_INTERNAL_SECRET") or os.environ.get("INTERNAL_SECRET") or os.environ.get("OCR_INTERNAL_SECRET")

def verify_internal_secret(x_internal_secret: Optional[str] = Header(None)):
    """
    Enforces secret authorization between Spring Boot backend and Python OCR service.
    Protects Gemini AI quota from unauthorized external public invocations.
    """
    if INTERNAL_SECRET:
        if not x_internal_secret or x_internal_secret.strip() != INTERNAL_SECRET.strip():
            logger.warning("Unauthorized access attempt to OCR endpoint: invalid or missing X-Internal-Secret")
            raise HTTPException(status_code=403, detail="Forbidden: Invalid or missing X-Internal-Secret")

# Ordered list of stable Gemini models for automatic fallback retry
FALLBACK_MODELS: List[str] = [
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro"
]

# ── Data Transfer Objects (DTOs) ────────────────────────────────────────────
class InvoiceItem(BaseModel):
    name: str
    mrp: float = 0.0
    batch_number: Optional[str] = None
    expiry_date: Optional[str] = None
    invoice_cases: int = 1
    packs_per_case: int = 1
    buy_price_per_piece: float = 0.0
    net_amount: float = 0.0           # Gross row amount before scheme discounts
    cst_discount: float = 0.0         # Sum of scheme, CST, and cash discounts
    taxable_value: float = 0.0        # Net taxable value after discount, before GST
    gst_percent: float = 5.0          # Applicable GST percentage rate
    offer_secondary_received: int = 0 # Free or scheme offer bonus units

class ScanResponse(BaseModel):
    invoice_number: Optional[str] = None
    rawItems: List[InvoiceItem]

class TextGenerationRequest(BaseModel):
    prompt: str

class StructuredRequest(BaseModel):
    prompt: str
    systemInstruction: Optional[str] = None

class SpeechGenerationRequest(BaseModel):
    prompt: str
    voice_name: Optional[str] = "Puck"

# ── AI Invoice Extraction Prompt ───────────────────────────────────────────
PROMPT_OCR = """
You are an expert accountant parsing a retail shop purchase tax invoice.
Scan the uploaded image of the tax invoice.

First, look at the header area of the invoice and extract:
- "invoice_number": Locate and extract the Invoice Number (or Bill Number / Inv No., e.g., '26-27/SA-0821', 'SA-0820'). If not found, return null.

Next, parse the listed invoice items. The invoice is a structured table with the following columns:
S No. | Item Name | Hsn Code | Batch Number | Expiry Date | MRP | UOM | Total Invoice Cases | Price/Piece | Net Amt. | GST Discount (%) | GST Discount | Total Scheme Dis. | Taxable Value | GST (%)

CRITICAL ALIGNMENT RULE:
You MUST read the table row-by-row. Do NOT mix up columns from different rows!
For each serial number (S No.), extract all of its columns from the same horizontal line.
For example, for a single row, the 'Item Name', 'Batch Number', 'Expiry Date', 'MRP', 'UOM', 'Total Invoice Cases', 'Price/Piece', and 'Taxable Value' must all belong to that same row.

Please extract each item with:
1. "name": The exact name of the item.
2. "mrp": Maximum Retail Price per piece/packet.
3. "batch_number": Alphanumeric batch string (Do NOT confuse with numeric HSN code).
4. "expiry_date": Format strictly as "YYYY-MM-DD" (convert DD/MM/YY to YYYY-MM-DD).
5. "invoice_cases": Total purchased cases quantity.
6. "packs_per_case": Units per case (from UOM column).
7. "buy_price_per_piece": Purchase price per piece excluding tax.
8. "net_amount": Gross row total before discount.
9. "cst_discount": Total scheme and CST discount amount for this row.
10. "taxable_value": Net amount after discount, before GST (taxable_value = net_amount - cst_discount).
11. "gst_percent": GST percentage rate.
12. "offer_secondary_received": Free/bonus scheme units received for this product row.

Return a JSON object with keys "invoice_number" and "rawItems". Do not include markdown code block explanations outside the JSON.
"""

# ── Helper Utilities ───────────────────────────────────────────────────────
def strip_json_fences(raw_text: str) -> str:
    """Removes markdown ```json fences from raw AI output string."""
    cleaned = raw_text.strip()
    if "```json" in cleaned:
        cleaned = cleaned.split("```json")[1].split("```")[0].strip()
    elif "```" in cleaned:
        cleaned = cleaned.split("```")[1].split("```")[0].strip()
    return cleaned

def compress_image(image_bytes: bytes) -> bytes:
    """Resizes and compresses uploaded invoice image for faster AI API transfer."""
    if len(image_bytes) < 150 * 1024:
        logger.info("Image size < 150KB. Skipping compression.")
        return image_bytes
        
    try:
        img = Image.open(io.BytesIO(image_bytes))
        
        # Auto-rotate image based on mobile camera EXIF orientation data
        try:
            img = ImageOps.exif_transpose(img)
            logger.info("Rotated image based on EXIF metadata.")
        except Exception as rot_err:
            logger.warning(f"EXIF rotation skipped: {rot_err}")
        
        if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
            img = img.convert('RGB')
            
        max_size = (1400, 1400)
        img.thumbnail(max_size, Image.Resampling.LANCZOS)
        
        out_io = io.BytesIO()
        img.save(out_io, format="JPEG", quality=82)
        compressed = out_io.getvalue()
        logger.info(f"Compressed image from {len(image_bytes)} to {len(compressed)} bytes.")
        return compressed
    except Exception as e:
        logger.error(f"Failed to compress image: {e}")
        return image_bytes

async def execute_gemini_request(
    parts: List[Dict[str, Any]], 
    json_mode: bool = False,
    system_instruction: Optional[str] = None
) -> str:
    """
    Executes a Gemini API request with automatic multi-model fallback retry.
    Iterates through FALLBACK_MODELS until a 200 OK response is received.
    """
    if not API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY environment variable is not configured.")

    generation_config: Dict[str, Any] = {}
    if json_mode:
        generation_config["responseMimeType"] = "application/json"

    payload: Dict[str, Any] = {
        "contents": [{"parts": parts}],
        "generationConfig": generation_config
    }

    if system_instruction:
        payload["systemInstruction"] = {
            "parts": [{"text": system_instruction}]
        }

    headers = {"Content-Type": "application/json"}
    last_error: Optional[str] = None

    for model_name in FALLBACK_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={API_KEY}"
        logger.info(f"Attempting Gemini API request with model: {model_name}...")
        
        try:
            res = await asyncio.to_thread(requests.post, url, json=payload, headers=headers)
            if res.status_code == 200:
                res_data = res.json()
                text = res_data['candidates'][0]['content']['parts'][0]['text'].strip()
                logger.info(f"Successfully received response from model: {model_name}")
                return text
            else:
                logger.warning(f"Model {model_name} failed with status {res.status_code}: {res.text[:200]}")
                last_error = f"HTTP {res.status_code}: {res.text[:200]}"
        except Exception as exc:
            logger.error(f"Network error calling Gemini model {model_name}: {exc}")
            last_error = str(exc)

    raise HTTPException(
        status_code=500,
        detail=f"All Gemini models exhausted. Last error: {last_error}"
    )

def audit_and_fix_financial_calculations(items_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Audits extracted invoice items and auto-corrects taxable value column misalignments.
    Ensures taxable_value <= net_amount (net_amount - cst_discount).
    """
    for item in items_list:
        if isinstance(item, dict):
            net_amt = float(item.get("net_amount", 0) or 0)
            cst_disc = float(item.get("cst_discount", 0) or 0)
            taxable = float(item.get("taxable_value", 0) or 0)
            
            # If taxable > net_amount, AI read wrong column — apply auto-correction
            if net_amt > 0 and taxable > net_amt:
                corrected = round(max(0.0, net_amt - cst_disc), 2)
                logger.warning(
                    f"Financial Audit Corrected taxable_value for '{item.get('name')}': "
                    f"was {taxable}, corrected to {corrected} (net={net_amt}, disc={cst_disc})"
                )
                item["taxable_value"] = corrected
    return items_list

# ── Endpoints ──────────────────────────────────────────────────────────────
@app.get("/health")
def health_check():
    """Health check endpoint for Render container readiness monitoring."""
    return {
        "status": "UP",
        "service": "FMCG OCR Service",
        "api_configured": API_KEY is not None,
        "models_count": len(FALLBACK_MODELS)
    }

@app.post("/ocr/scan-invoice", response_model=ScanResponse, dependencies=[Depends(verify_internal_secret)])
async def scan_invoice(file: UploadFile = File(...)):
    """
    Uploads and parses a purchase tax invoice image or PDF using Gemini Multimodal OCR.
    Extracts invoice header number and structured item rows.
    """
    try:
        contents = await file.read()
        logger.info(f"Received file: {file.filename}, raw size: {len(contents)} bytes")
        
        # Determine MIME type
        content_type = file.content_type
        if not content_type:
            ext = os.path.splitext(file.filename or '')[1].lower()
            content_type = 'application/pdf' if ext == '.pdf' else 'image/jpeg'

        if content_type == 'application/pdf':
            mime_type = 'application/pdf'
            base64_data = base64.b64encode(contents).decode('utf-8')
            logger.info("Processing PDF file...")
        else:
            mime_type = 'image/jpeg'
            processed = compress_image(contents)
            base64_data = base64.b64encode(processed).decode('utf-8')
            logger.info(f"Processing compressed image ({len(processed)} bytes)...")

        parts = [
            {"text": PROMPT_OCR},
            {
                "inlineData": {
                    "mime_type": mime_type,
                    "data": base64_data
                }
            }
        ]

        raw_ai_output = await execute_gemini_request(parts, json_mode=True)
        cleaned_json_str = strip_json_fences(raw_ai_output)
        parsed_data = json.loads(cleaned_json_str)

        # Format output to match ScanResponse schema
        if isinstance(parsed_data, list):
            return {"rawItems": audit_and_fix_financial_calculations(parsed_data)}
        elif isinstance(parsed_data, dict):
            if "rawItems" in parsed_data:
                parsed_data["rawItems"] = audit_and_fix_financial_calculations(parsed_data.get("rawItems", []))
                return parsed_data
            
            # If AI wrapped items under another key, find list
            for key, val in parsed_data.items():
                if isinstance(val, list):
                    parsed_data[key] = audit_and_fix_financial_calculations(val)
                    return {"rawItems": parsed_data[key]}
            return {"rawItems": []}
        else:
            return {"rawItems": []}

    except json.JSONDecodeError as jde:
        logger.error(f"JSON Parse Error: {jde}")
        raise HTTPException(
            status_code=500,
            detail=f"AI returned invalid JSON format: {str(jde)}"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unhandled error in invoice scanning: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")

@app.post("/ocr/generate-text", dependencies=[Depends(verify_internal_secret)])
async def generate_text(req: TextGenerationRequest):
    """Generates free-form AI text or copilot recommendations."""
    parts = [{"text": req.prompt}]
    text = await execute_gemini_request(parts, json_mode=False)
    return {"text": text}

@app.post("/ocr/parse-structured", dependencies=[Depends(verify_internal_secret)])
async def parse_structured(req: StructuredRequest):
    """Generates structured JSON data based on prompt instructions."""
    parts = [{"text": req.prompt}]
    response_text = await execute_gemini_request(
        parts, 
        json_mode=True, 
        system_instruction=req.systemInstruction
    )
    
    cleaned = strip_json_fences(response_text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {"rawText": response_text}

def pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 24000, channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """
    Wraps raw PCM audio in a standard 44-byte RIFF/WAVE header for universal browser audio playback.
    """
    byte_rate = sample_rate * channels * (bits_per_sample // 8)
    block_align = channels * (bits_per_sample // 8)
    subchunk2_size = len(pcm_bytes)
    chunk_size = 36 + subchunk2_size
    header = struct.pack(
        '<4sI4s4sIHHIIHH4sI',
        b'RIFF', chunk_size, b'WAVE',
        b'fmt ', 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample,
        b'data', subchunk2_size
    )
    return header + pcm_bytes

@app.post("/ocr/generate-speech", dependencies=[Depends(verify_internal_secret)])
async def generate_speech(req: SpeechGenerationRequest):
    """
    Generates high-definition neural voice audio via Gemini 2.5 Flash TTS.
    Returns standard audio/wav base64 data URL for direct browser playback.
    """
    if not API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY environment variable is not configured.")

    voice_name = req.voice_name or "Puck"
    models_to_try = ["gemini-2.5-flash-preview-tts", "gemini-2.5-flash"]

    payload = {
        "contents": [{"parts": [{"text": req.prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": voice_name
                    }
                }
            }
        }
    }

    headers = {"Content-Type": "application/json"}
    last_error = None

    for model_name in models_to_try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={API_KEY}"
        logger.info(f"Attempting Gemini TTS generation with model {model_name} (Voice: {voice_name})...")
        try:
            res = await asyncio.to_thread(requests.post, url, json=payload, headers=headers)
            if res.status_code == 200:
                res_data = res.json()
                cand = res_data.get('candidates', [{}])[0]
                part = cand.get('content', {}).get('parts', [{}])[0]
                inline_data = part.get('inlineData')
                if inline_data and 'data' in inline_data:
                    raw_pcm_b64 = inline_data['data']
                    pcm_bytes = base64.b64decode(raw_pcm_b64)
                    wav_bytes = pcm_to_wav(pcm_bytes, sample_rate=24000, channels=1, bits_per_sample=16)
                    wav_b64 = base64.b64encode(wav_bytes).decode('utf-8')
                    logger.info(f"Generated {len(wav_bytes)} bytes WAV audio successfully.")
                    return {
                        "success": True,
                        "audioBase64": f"data:audio/wav;base64,{wav_b64}",
                        "voice": voice_name,
                        "format": "wav"
                    }
            else:
                logger.warning(f"TTS Model {model_name} failed ({res.status_code}): {res.text[:200]}")
                last_error = f"HTTP {res.status_code}: {res.text[:200]}"
        except Exception as exc:
            logger.error(f"Error during Gemini TTS with {model_name}: {exc}")
            last_error = str(exc)

    raise HTTPException(status_code=500, detail=f"Gemini TTS generation failed. Last error: {last_error}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8087)
