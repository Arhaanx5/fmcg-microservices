# 🚀 FMCG Microservices (WhatsApp Bot & Gemini OCR)

Dedicated repository for FMCG Shop microservices running independently on **Render Account 2**.

---

## 📦 Services Included:

1. **`whatsapp-service`**:
   - Engine: `@whiskeysockets/baileys` WebSocket client + PDF Generator
   - Port: 3000
   - Auth: Protected via `X-Internal-Secret` header

2. **`ocr-service`**:
   - Engine: FastAPI + Gemini 2.5 Flash Multimodal Vision
   - Port: 8087
   - Auth: Protected via `X-Internal-Secret` header
   - Healthcheck: `/health`

---

## 🛠️ Deploy to Render Account 2:

1. Create a new GitHub repository: `fmcg-microservices` (can be private or public).
2. Push this folder to your repository:
   ```bash
   git init
   git add .
   git commit -m "Initial microservices setup"
   git branch -M main
   git remote add origin https://github.com/<your-username>/fmcg-microservices.git
   git push -u origin main
   ```
3. Open **Render Dashboard** in an Incognito window using **Account 2**.
4. Click **New +** -> **Blueprint**.
5. Select the repository `fmcg-microservices`.
6. Render will automatically detect `render.yaml` and provision:
   - `laritraders-whatsapp`
   - `laritraders-ocr`
7. Fill in the environment variables:
   - `GEMINI_API_KEY`: <your-gemini-api-key>
   - `WA_INTERNAL_SECRET`: <your-internal-secret>

