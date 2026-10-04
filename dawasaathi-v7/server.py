#!/usr/bin/env python3
import json
import os
import threading
import time
from collections import defaultdict, deque
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("HOST", "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))


def load_api_key() -> str:
    env_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if env_key:
        return env_key
    key_file = ROOT / "api_key.txt"
    if key_file.exists():
        try:
            return key_file.read_text(encoding="utf-8").strip()
        except Exception:
            return ""
    return ""


OPENAI_API_KEY = load_api_key()
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.6-sol").strip() or "gpt-5.6-sol"
TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "gpt-realtime-2.1-mini").strip() or "gpt-realtime-2.1-mini"
TTS_VOICE = os.environ.get("OPENAI_TTS_VOICE", "marin").strip() or "marin"
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
MAX_BODY_BYTES = 30 * 1024 * 1024
MAX_SPEECH_CHARS = 1400
RATE_LIMIT_PER_HOUR = int(os.environ.get("RATE_LIMIT_PER_HOUR", "60"))
_RATE_BUCKETS = defaultdict(deque)
_RATE_LOCK = threading.Lock()

PRESCRIPTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "document_type": {"type": "string", "enum": ["prescription", "not_prescription", "unclear"]},
        "raw_transcription": {"type": "string"},
        "medications": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "drug_name": {"type": "string"},
                    "drug_name_hindi": {"type": "string"},
                    "dose": {"type": "string"},
                    "frequency": {"type": "string"},
                    "route": {"type": "string"},
                    "duration": {"type": "string"},
                    "instructions": {"type": "string"},
                    "instructions_hindi": {"type": "string"},
                    "confidence": {"type": "number"},
                    "uncertainty": {"type": "string"}
                },
                "required": [
                    "drug_name", "drug_name_hindi", "dose", "frequency", "route", "duration",
                    "instructions", "instructions_hindi", "confidence", "uncertainty"
                ]
            }
        },
        "other_instructions": {"type": "array", "items": {"type": "string"}},
        "other_instructions_hindi": {"type": "array", "items": {"type": "string"}},
        "overall_confidence": {"type": "number"},
        "uncertainties": {"type": "array", "items": {"type": "string"}}
    },
    "required": [
        "document_type", "raw_transcription", "medications", "other_instructions",
        "other_instructions_hindi", "overall_confidence", "uncertainties"
    ]
}

MEDICINE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "document_type": {"type": "string", "enum": ["medicine_pack", "not_medicine_pack", "unclear"]},
        "display_name": {"type": "string"},
        "display_name_hindi": {"type": "string"},
        "brand_name": {"type": "string"},
        "dosage_form": {"type": "string"},
        "release_type": {"type": "string"},
        "strength_text": {"type": "string"},
        "active_ingredients": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "name_hindi": {"type": "string"},
                    "strength": {"type": "string"},
                    "confidence": {"type": "number"}
                },
                "required": ["name", "name_hindi", "strength", "confidence"]
            }
        },
        "raw_transcription": {"type": "string"},
        "overall_confidence": {"type": "number"},
        "uncertainties": {"type": "array", "items": {"type": "string"}}
    },
    "required": [
        "document_type", "display_name", "display_name_hindi", "brand_name", "dosage_form",
        "release_type", "strength_text", "active_ingredients", "raw_transcription",
        "overall_confidence", "uncertainties"
    ]
}

PRESCRIPTION_INSTRUCTIONS = """You are the vision extraction component of a medication-safety prototype for English prescriptions used in India.
Your job is only to read and structure what is visible. Do not diagnose, recommend treatment, or silently fill missing clinical information from medical knowledge.

Rules:
1. The prescription and medicine names are expected to be written in English, often by hand.
2. Transcribe visible English text faithfully in raw_transcription.
3. For each medication, extract drug_name, dose, frequency, route, duration and visible medication-specific instructions.
4. drug_name must preserve the English spelling actually read from the prescription. drug_name_hindi must be a phonetic Devanagari rendering of that same name for a Hindi-speaking patient. Do not translate the medicine into another medicine or generic name.
5. instructions_hindi must be a faithful, simple Hindi translation of instructions that are visibly present. If no medication-specific instruction is visible, return an empty string. Do not add food timing or other advice that is not visible.
6. Preserve visible prescription abbreviations exactly in frequency. Use this project's authoritative mapping when reading them: OD = once a day at any fixed time; OD BBF = once a day in the morning on an empty stomach; BD = twice a day; TDS = thrice a day; QID = four times a day; ABF = after breakfast; BL = before lunch; AL = after lunch; AD = after dinner; OD HS = once a day before sleeping. Keep composite forms such as 'OD BBF' and 'OD HS' together in the frequency field. MV means multivitamin and BC means B complex when those abbreviations are visibly written as the medicine name.
7. If a clinical field is not visible or not safely readable, return an empty string and explain the uncertainty. Never guess a drug name, strength, frequency, route or duration.
8. You may label route as Oral only when oral use is unambiguous from the prescription; otherwise leave route empty.
9. Put all other clinically relevant visible advice in other_instructions in English. Put faithful simple Hindi translations of the same items, in the same order, in other_instructions_hindi. Do not add advice.
10. confidence means confidence in the visual reading, not confidence that the treatment is medically correct.
11. If there are no medicines, medications must be an empty array.
"""

MEDICINE_INSTRUCTIONS = """You are the vision extraction component of a medication-safety prototype for medicine strips, boxes, bottles, inhalers, drops and similar packs used in India.
Your job is only to read and structure what is visibly printed on the pack. Do not diagnose, recommend treatment, or infer an ingredient from a brand name unless it is visibly printed.

Rules:
1. Read English pack text carefully, including small composition text when visible.
2. display_name is the clearest product/drug name printed on the pack. display_name_hindi is a phonetic Devanagari rendering of exactly that name for Hindi speech; do not translate it into another drug name.
3. brand_name is the brand/product name if clearly visible; otherwise empty.
4. active_ingredients may contain only ingredients visibly printed on the pack. name_hindi must be the phonetic Devanagari rendering of the same visible ingredient name.
5. Copy strengths exactly as visible, such as '500 mg', '20 mg', '250 mg/5 mL'.
6. dosage_form should be a concise English form such as tablet, capsule, syrup, injection, inhaler, drops or cream; leave empty if unclear.
7. release_type should capture visible modified-release wording such as SR, ER, XR, CR, MR, PR, XL, LA, sustained release or extended release; otherwise empty.
8. raw_transcription should contain the most relevant visible pack text, including composition and strength.
9. If text is unreadable, use empty strings rather than guessing and explain the problem in uncertainties.
10. confidence is confidence in the visual reading only.
"""


def validate_strict_schema(schema, path="root"):
    if isinstance(schema, dict):
        if schema.get("type") == "object" and isinstance(schema.get("properties"), dict):
            props = set(schema["properties"].keys())
            required = set(schema.get("required", []))
            if props != required:
                missing = sorted(props - required)
                extra = sorted(required - props)
                raise RuntimeError(f"Schema mismatch at {path}: missing required={missing}, extra required={extra}")
        for key, value in schema.items():
            validate_strict_schema(value, f"{path}.{key}")
    elif isinstance(schema, list):
        for i, value in enumerate(schema):
            validate_strict_schema(value, f"{path}[{i}]")


validate_strict_schema(PRESCRIPTION_SCHEMA, "prescription")
validate_strict_schema(MEDICINE_SCHEMA, "medicine")


def api_error_message(body: bytes, fallback: str) -> str:
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict) and err.get("message"):
                return str(err["message"])
            if data.get("message"):
                return str(data["message"])
    except Exception:
        pass
    text = body.decode("utf-8", errors="replace").strip()
    return text[:500] if text else fallback


def extract_output_text(response_json: dict) -> str:
    for item in response_json.get("output", []) or []:
        if item.get("type") != "message":
            continue
        for part in item.get("content", []) or []:
            if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                return part["text"]
    raise RuntimeError("एआई से संरचित उत्तर नहीं मिला।")


def call_openai(image_data_url: str, mode: str):
    if not OPENAI_API_KEY:
        raise RuntimeError("एपीआई कुंजी सर्वर पर सेट नहीं है।")
    if not image_data_url.startswith("data:image/"):
        raise ValueError("तस्वीर सही रूप में नहीं मिली।")

    if mode == "prescription":
        schema = PRESCRIPTION_SCHEMA
        schema_name = "dawasaathi_prescription"
        instructions = PRESCRIPTION_INSTRUCTIONS
        user_text = "Read this prescription image and return only the structured extraction requested by the schema."
        max_output = 4500
    elif mode == "medicine":
        schema = MEDICINE_SCHEMA
        schema_name = "dawasaathi_medicine_pack"
        instructions = MEDICINE_INSTRUCTIONS
        user_text = "Read this medicine-pack image and return only the structured extraction requested by the schema."
        max_output = 3000
    else:
        raise ValueError("Unknown analysis mode.")

    payload = {
        "model": MODEL,
        "store": False,
        "instructions": instructions,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": user_text},
                {"type": "input_image", "image_url": image_data_url, "detail": "high"}
            ]
        }],
        "text": {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "description": "Strict structured extraction for DawaSaathi.",
                "strict": True,
                "schema": schema
            }
        },
        "max_output_tokens": max_output
    }

    req = urllib.request.Request(
        f"{OPENAI_BASE_URL}/responses",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=150) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        body = e.read()
        detail = api_error_message(body, e.reason)
        print(f"OpenAI API error ({e.code}): {detail}")
        raise RuntimeError(f"एआई सेवा ने अनुरोध स्वीकार नहीं किया। त्रुटि संख्या {e.code}।") from e
    except urllib.error.URLError as e:
        print(f"OpenAI connection error: {e.reason}")
        raise RuntimeError("एआई सेवा से संपर्क नहीं हो सका। इंटरनेट कनेक्शन जाँचें।") from e

    try:
        response_json = json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise RuntimeError("एआई सेवा से सही उत्तर नहीं मिला।") from e

    if response_json.get("status") in {"failed", "incomplete"}:
        err = response_json.get("error") or response_json.get("incomplete_details") or {}
        print(f"OpenAI incomplete response: {err}")
        raise RuntimeError("एआई ने उत्तर पूरा नहीं किया। कृपया तस्वीर दोबारा लें।")

    text = extract_output_text(response_json)
    try:
        result = json.loads(text)
    except Exception as e:
        raise RuntimeError("एआई का संरचित उत्तर पढ़ा नहीं जा सका।") from e

    return result, response_json.get("usage") or {}


def call_openai_speech(text: str) -> bytes:
    if not OPENAI_API_KEY:
        raise RuntimeError("एपीआई कुंजी सर्वर पर सेट नहीं है।")
    text = (text or "").strip()
    if not text:
        raise ValueError("बोलने के लिए कोई निर्देश नहीं मिला।")
    if len(text) > MAX_SPEECH_CHARS:
        raise ValueError("आवाज़ के लिए निर्देश बहुत लंबा है।")

    payload = {
        "model": TTS_MODEL,
        "voice": TTS_VOICE,
        "input": text,
        "instructions": "Speak in clear, natural Indian Hindi at a calm patient-friendly pace. Read Arabic numerals naturally in Hindi. Pronounce medicine names exactly as written in Devanagari. Do not add or omit any information.",
        "response_format": "mp3"
    }

    def request_audio(model_name: str) -> bytes:
        body = dict(payload)
        body["model"] = model_name
        req = urllib.request.Request(
            f"{OPENAI_BASE_URL}/audio/speech",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            detail = api_error_message(e.read(), e.reason)
            print(f"OpenAI speech error ({e.code}) using {model_name}: {detail}")
            raise RuntimeError(detail) from e
        except urllib.error.URLError as e:
            print(f"OpenAI speech connection error: {e.reason}")
            raise RuntimeError("आवाज़ सेवा से संपर्क नहीं हो सका।") from e

    try:
        return request_audio(TTS_MODEL)
    except RuntimeError:
        # Temporary compatibility fallback while older speech model aliases remain available.
        if TTS_MODEL != "gpt-4o-mini-tts":
            try:
                return request_audio("gpt-4o-mini-tts")
            except RuntimeError:
                pass
        raise RuntimeError("आवाज़ अभी तैयार नहीं हो सकी। कृपया फिर कोशिश करें।")


def client_ip(handler) -> str:
    forwarded = handler.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return handler.client_address[0] if handler.client_address else "unknown"


def allow_request(ip: str) -> bool:
    if RATE_LIMIT_PER_HOUR <= 0:
        return True
    now = time.time()
    cutoff = now - 3600
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS[ip]
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_PER_HOUR:
            return False
        bucket.append(now)
        return True


class DawaSaathiHandler(SimpleHTTPRequestHandler):
    server_version = "DawaSaathi/7.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _send_json(self, status: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_audio(self, data: bytes):
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/health":
            self._send_json(200, {
                "ok": True,
                "api_key_configured": bool(OPENAI_API_KEY),
                "model": MODEL,
                "tts_model": TTS_MODEL
            })
            return
        return super().do_GET()

    def do_POST(self):
        if self.path not in {"/api/analyze-prescription", "/api/analyze-medicine", "/api/speak"}:
            self._send_json(404, {"ok": False, "error": "पता नहीं मिला।"})
            return

        if not allow_request(client_ip(self)):
            self._send_json(429, {"ok": False, "error": "बहुत अधिक अनुरोध किए गए हैं। कुछ देर बाद फिर कोशिश करें।"})
            return

        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"ok": False, "error": "तस्वीर नहीं मिली।"})
            return
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"ok": False, "error": "तस्वीर बहुत बड़ी है। छोटी तस्वीर चुनें।"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/api/speak":
                audio = call_openai_speech(str(payload.get("text", "")))
                self._send_audio(audio)
                return

            image = payload.get("image", "")
            mode = "prescription" if self.path.endswith("prescription") else "medicine"
            result, usage = call_openai(image, mode)
            self._send_json(200, {"ok": True, "result": result, "model": MODEL, "usage": usage})
        except ValueError as e:
            self._send_json(400, {"ok": False, "error": str(e)})
        except RuntimeError as e:
            self._send_json(502, {"ok": False, "error": str(e)})
        except Exception as e:
            print("Unexpected server error:", repr(e))
            self._send_json(500, {"ok": False, "error": "सर्वर में अनपेक्षित त्रुटि हुई।"})


def open_browser_later():
    time.sleep(0.8)
    try:
        webbrowser.open(f"http://{HOST}:{PORT}")
    except Exception:
        pass


if __name__ == "__main__":
    print("\nदवा साथी")
    print(f"Open: http://{HOST}:{PORT}")
    print(f"Model: {MODEL}")
    if not OPENAI_API_KEY:
        print("WARNING: API key is not configured.\n")
    else:
        print("API key detected (not shown).\n")
    if not os.environ.get("RENDER"):
        threading.Thread(target=open_browser_later, daemon=True).start()
    httpd = ThreadingHTTPServer((HOST, PORT), DawaSaathiHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping DawaSaathi...")
    finally:
        httpd.server_close()
